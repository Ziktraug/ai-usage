import fs from 'node:fs';
import path from 'node:path';
import type { LocalHistoryError } from '@ai-usage/local-machine/errors';
import {
  CODEX_DETAIL_MAX_PHASES,
  type CodexSession,
  type CodexSessionPhase,
  type CodexSubagentKind,
  type CodexThreadMetadata,
  type CodexThreadMetadataRow,
  type CodexThreadSpawnEdgeRow,
  codexModelSegments,
  codexParentsFromEdges,
  codexStateDbCandidates,
  codexThreadMetadataFromRow,
  createCodexSessionParser,
  isCodexUsageOwnedByRoot,
  isRecord,
  codexSessionsDir as localCodexSessionsDir,
  mergeMetadata,
  nonEmpty,
  listCodexSessionFiles as rawCodexSessionFiles,
  THREAD_METADATA_SQL,
} from '@ai-usage/local-machine/internal/codex-history';
import {
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-machine/local-history';
import { firstExisting } from '@ai-usage/local-machine/platform-paths';
import { base, safeJSON } from '@ai-usage/local-machine/text';
import { normalizeCodexRateLimitStatus, type ProviderStatus } from '@ai-usage/report-core/provider-status';
import { parseSessionVcsContext, type SessionVcsContext } from '@ai-usage/report-core/session-vcs';
import { type SkillObservation, skillObservationIdentity } from '@ai-usage/report-core/skill-observation';
import type { SessionOrigin } from '@ai-usage/report-core/types';
import { actualCost, approximateApiCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import type { CollectedSession } from './collected-session';
import { reviveSkillObservationsResult } from './collector-cache';
import { parseNonNegativeSafeInteger } from './metric-validation';
import { withPerfSpan } from './perf';

export {
  codexSessionsDir,
  hasCodexHistory,
  listCodexSessionFiles,
} from '@ai-usage/local-machine/internal/codex-history';

const listCodexSessionFilesForCollection = withPerfSpan(
  'aiUsage.collect.codex.listSessionFiles',
  rawCodexSessionFiles,
  (files) => ({ files: files.length }),
);

const isCodexSubagentKind = (value: unknown): value is CodexSubagentKind =>
  value === 'guardian' || value === 'review' || value === 'thread-spawn';

export type CodexCollectedSession = CollectedSession;

export interface CodexQuotaWindow {
  resetsAt: Date | null;
  usedPercent: number;
  windowMinutes: number;
}

export interface CodexQuotaSnapshot {
  credits: number | null;
  planType: string;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
  ts: Date;
}

export interface CodexProviderStatusOptions {
  accountId?: string | null;
  machineId?: string;
  machineLabel?: string;
  recentFileLimit?: number;
}

interface RawCodexRateLimitSnapshot {
  rateLimits: Record<string, unknown>;
  ts: Date;
}

interface CodexSessionReadResult {
  bytes: number;
  cacheHits: number;
  cacheMisses: number;
  cacheReadMs: number;
  cacheWriteMs: number;
  files: number;
  lines: number;
  parsedLines: number;
  parseMs: number;
  readMs: number;
  rejectedMetricRecords: number;
  sessions: CodexSession[];
  skippedLines: number;
}

interface CodexSessionFileStat {
  mtimeMs: number;
  size: number;
}

interface CachedCodexSessionRecord extends CodexSessionFileStat {
  session: CodexSession;
}

interface CodexSessionCacheRow {
  file_path: string;
  mtime_ms: number;
  session_json: string;
  size: number;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): unknown;
  query(sql: string): SqliteStatement;
}

// This cache stores normalized parser output, not raw JSONL. Bump whenever an
// unchanged rollout could produce different counters, labels, origin, lineage,
// phases, or turns.
// Bumped to 18 for the skill-observation stream: an entry written by version 17
// carries a parsed session with no observations, and reusing it would report a
// machine with history as a machine that has never invoked a skill.
const CODEX_SESSION_CACHE_VERSION = 18;

const THREAD_SPAWN_EDGES_SQL = `
select parent_thread_id as parent, child_thread_id as child
from thread_spawn_edges
`;

const readCodexThreadMetadata: Effect.Effect<
  Map<string, CodexThreadMetadata>,
  LocalHistoryError,
  LocalHistoryStorageService
> = withPerfSpan(
  'aiUsage.collect.codex.threadMetadata',
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const dbPath = yield* firstExisting(storage, ...codexStateDbCandidates(storage));
    if (!dbPath) {
      return new Map<string, CodexThreadMetadata>();
    }

    return yield* Effect.acquireUseRelease(
      withPerfSpan('aiUsage.collect.codex.threadMetadata.open', storage.openDatabase(dbPath)),
      (db) =>
        Effect.gen(function* () {
          const rows = yield* withPerfSpan(
            'aiUsage.collect.codex.threadMetadata.threads',
            db.all<CodexThreadMetadataRow>(THREAD_METADATA_SQL),
            (value) => ({ rows: value.length }),
          );
          const edges = yield* withPerfSpan(
            'aiUsage.collect.codex.threadMetadata.edges',
            db.all<CodexThreadSpawnEdgeRow>(THREAD_SPAWN_EDGES_SQL),
            (value) => ({ rows: value.length }),
          );

          const parents = codexParentsFromEdges(edges);

          const metadata = new Map<string, CodexThreadMetadata>();
          for (const row of rows) {
            const id = nonEmpty(row.id);
            if (!id) {
              continue;
            }
            const threadMetadata = codexThreadMetadataFromRow(row, parents.get(id) ?? null);
            if (threadMetadata) {
              metadata.set(id, threadMetadata);
            }
          }

          return metadata;
        }),
      (db) => db.close,
    ).pipe(Effect.catchAll(() => Effect.succeed(new Map<string, CodexThreadMetadata>())));
  }),
  (metadata) => ({ rows: metadata.size }),
);

const cloneCodexSession = (session: CodexSession): CodexSession => ({
  ...session,
  end: session.end ? new Date(session.end) : null,
  models: [...session.models],
  skillObservations: session.skillObservations.map((observation) => ({ ...observation })),
  skillObservationRejects: session.skillObservationRejects,
  skillObservationsTruncated: session.skillObservationsTruncated,
  phases: session.phases.map((phase) => ({
    ...phase,
    end: new Date(phase.end),
    start: new Date(phase.start),
  })),
  start: session.start ? new Date(session.start) : null,
  ...(session.vcs ? { vcs: parseSessionVcsContext(JSON.parse(JSON.stringify(session.vcs))) } : {}),
});

const codexSessionCachePath = (storage: LocalHistoryStorageService) =>
  path.join(storage.home, '.config', 'ai-usage', 'codex-session-cache.sqlite');

const codexFileStat = (filePath: string): CodexSessionFileStat | null => {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
};

const reviveDate = (value: unknown): Date | null => {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const reviveCachedPhases = (value: unknown): CodexSessionPhase[] | null => {
  if (!(Array.isArray(value) && value.length <= CODEX_DETAIL_MAX_PHASES)) {
    return null;
  }
  const phases: CodexSessionPhase[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      return null;
    }
    const start = reviveDate(candidate.start);
    const end = reviveDate(candidate.end);
    const tin = parseNonNegativeSafeInteger(candidate.tin);
    const tcr = parseNonNegativeSafeInteger(candidate.tcr);
    const tout = parseNonNegativeSafeInteger(candidate.tout);
    if (
      !(
        start &&
        end &&
        end >= start &&
        tin.ok &&
        tcr.ok &&
        tout.ok &&
        typeof candidate.model === 'string' &&
        (candidate.effort === null || typeof candidate.effort === 'string')
      )
    ) {
      return null;
    }
    phases.push({
      effort: candidate.effort,
      end,
      model: candidate.model,
      start,
      tcr: tcr.value,
      tin: tin.value,
      tout: tout.value,
    });
  }
  return phases;
};

const reviveCachedSession = (json: string): CodexSession | null => {
  try {
    const value = JSON.parse(json) as unknown;
    if (!isRecord(value)) {
      return null;
    }
    const counters = [
      value.turns,
      value.tools,
      value.maxTotal,
      value.tin,
      value.tcr,
      value.tout,
      value.rejectedMetricRecords,
    ].map(parseNonNegativeSafeInteger);
    const start = reviveDate(value.start);
    const end = reviveDate(value.end);
    const activeDuration = value.activeDurationMs === null ? null : parseNonNegativeSafeInteger(value.activeDurationMs);
    const rawModels = Array.isArray(value.models) ? value.models : null;
    const models = rawModels
      ? rawModels.filter((model): model is string => typeof model === 'string').slice(0, CODEX_DETAIL_MAX_PHASES)
      : null;
    const phases = reviveCachedPhases(value.phases);
    // Re-validated on the way out of the cache, like every other cached field:
    // a cache entry whose observations no longer parse is a cache miss, not a
    // session that silently lost its observations.
    const skillObservations = reviveSkillObservationsResult(value.skillObservations);
    const skillObservationRejects = parseNonNegativeSafeInteger(value.skillObservationRejects);
    let vcs: SessionVcsContext | undefined;
    try {
      vcs = value.vcs === undefined ? undefined : parseSessionVcsContext(value.vcs);
    } catch {
      return null;
    }
    if (
      !counters.every((counter) => counter.ok) ||
      (value.start !== null && start === null) ||
      (value.end !== null && end === null) ||
      typeof value.model !== 'string' ||
      typeof value.subscription !== 'boolean' ||
      typeof value.hasTokenUsage !== 'boolean' ||
      typeof value.observedPriorTokenUsage !== 'boolean' ||
      typeof value.durationPartial !== 'boolean' ||
      typeof value.reportPartial !== 'boolean' ||
      (value.classifierParent !== null && typeof value.classifierParent !== 'string') ||
      (value.subagentKind !== null && !isCodexSubagentKind(value.subagentKind)) ||
      !(activeDuration === null || activeDuration.ok) ||
      models === null ||
      models.length !== rawModels?.length ||
      phases === null ||
      !skillObservations.valid ||
      !skillObservationRejects.ok ||
      typeof value.skillObservationsTruncated !== 'boolean'
    ) {
      return null;
    }
    const [turns, tools, maxTotal, tin, tcr, tout, rejectedMetricRecords] = counters;
    if (!(turns?.ok && tools?.ok && maxTotal?.ok && tin?.ok && tcr?.ok && tout?.ok && rejectedMetricRecords?.ok)) {
      return null;
    }
    return {
      activeDurationMs: activeDuration?.value ?? null,
      classifierParent: value.classifierParent,
      id: typeof value.id === 'string' ? value.id : null,
      parent: typeof value.parent === 'string' ? value.parent : null,
      durationPartial: value.durationPartial,
      reportPartial: value.reportPartial,
      observedPriorTokenUsage: value.observedPriorTokenUsage,
      start,
      end,
      cwd: typeof value.cwd === 'string' ? value.cwd : null,
      model: value.model,
      models,
      phases,
      subagentKind: value.subagentKind,
      threadSource: typeof value.threadSource === 'string' ? value.threadSource : null,
      agentNickname: typeof value.agentNickname === 'string' ? value.agentNickname : null,
      subscription: value.subscription,
      firstUser: typeof value.firstUser === 'string' ? value.firstUser : null,
      turns: turns.value,
      tools: tools.value,
      maxTotal: maxTotal.value,
      tin: tin.value,
      tcr: tcr.value,
      tout: tout.value,
      rejectedMetricRecords: rejectedMetricRecords.value,
      hasTokenUsage: value.hasTokenUsage,
      skillObservations: skillObservations.observations,
      skillObservationRejects: skillObservationRejects.value,
      skillObservationsTruncated: value.skillObservationsTruncated === true,
      ...(vcs ? { vcs } : {}),
    };
  } catch {
    return null;
  }
};

const loadCodexSessionCache = async (storage: LocalHistoryStorageService) => {
  if (!fs.existsSync(localCodexSessionsDir(storage))) {
    return null;
  }

  const { Database } = await import('bun:sqlite');
  const dbPath = codexSessionCachePath(storage);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath) as SqliteDatabase;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_session_cache (
        version INTEGER NOT NULL,
        file_path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        session_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_codex_session_cache_version ON codex_session_cache(version);
    `);

    const entries = new Map<string, CachedCodexSessionRecord>();
    for (const row of db
      .query('SELECT file_path, size, mtime_ms, session_json FROM codex_session_cache WHERE version = ?')
      .all(CODEX_SESSION_CACHE_VERSION) as CodexSessionCacheRow[]) {
      const session = reviveCachedSession(row.session_json);
      if (!session) {
        continue;
      }
      entries.set(row.file_path, { mtimeMs: row.mtime_ms, session, size: row.size });
    }

    return { db, entries };
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization error; there is no usable cache to return.
    }
    throw error;
  }
};

const writeCodexSessionCache = (
  db: SqliteDatabase,
  files: string[],
  parsed: { filePath: string; session: CodexSession; stat: CodexSessionFileStat }[],
) => {
  const now = new Date().toISOString();
  const upsert = db.query(`
    INSERT INTO codex_session_cache (version, file_path, size, mtime_ms, session_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      version = excluded.version,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      session_json = excluded.session_json,
      updated_at = excluded.updated_at
  `);
  const deleteStale = db.query(
    'DELETE FROM codex_session_cache WHERE version != ? OR file_path NOT IN (SELECT value FROM json_each(?))',
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of parsed) {
      upsert.run(
        CODEX_SESSION_CACHE_VERSION,
        entry.filePath,
        entry.stat.size,
        entry.stat.mtimeMs,
        JSON.stringify(entry.session),
        now,
      );
    }
    deleteStale.run(CODEX_SESSION_CACHE_VERSION, JSON.stringify(files));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

const codexSessionName = (session: CodexSession) => {
  if (session.agentNickname) {
    return session.agentNickname;
  }
  return session.firstUser || (session.id ? `codex ${session.id}` : 'codex');
};

const codexOrigin = (session: CodexSession): SessionOrigin | undefined => {
  if (session.subagentKind === 'thread-spawn') {
    return 'subagent';
  }
  if (session.subagentKind === 'guardian' || session.subagentKind === 'review') {
    return 'classifier';
  }
  return session.threadSource === 'user' ? 'human' : undefined;
};

const codexTitleSource = (session: CodexSession, isSubagent: boolean) => {
  if (isSubagent && session.agentNickname) {
    return 'agent-role';
  }
  return session.firstUser ? 'first-prompt' : 'id';
};

const readCodexSessions = (
  metadata: Map<string, CodexThreadMetadata>,
): Effect.Effect<CodexSessionReadResult, LocalHistoryError, LocalHistoryStorageService> =>
  withPerfSpan(
    'aiUsage.collect.codex.sessions',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const sessions: CodexSession[] = [];
      let bytes = 0;
      let cacheHits = 0;
      let cacheMisses = 0;
      let cacheReadMs = 0;
      let cacheWriteMs = 0;
      let lines = 0;
      let parseMs = 0;
      let parsedLines = 0;
      let readMs = 0;
      let rejectedMetricRecords = 0;
      let skippedLines = 0;
      const files = yield* listCodexSessionFilesForCollection;
      const parsedForCache: { filePath: string; session: CodexSession; stat: CodexSessionFileStat }[] = [];

      yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const cacheReadStartedAt = Date.now();
          const sessionCache = fs.existsSync(localCodexSessionsDir(storage))
            ? yield* Effect.tryPromise({
                try: () => loadCodexSessionCache(storage),
                catch: (error) => error,
              }).pipe(Effect.catchAll(() => Effect.succeed(null)))
            : null;
          cacheReadMs = Date.now() - cacheReadStartedAt;
          return sessionCache;
        }),
        (sessionCache) =>
          Effect.gen(function* () {
            for (const filePath of files) {
              const stat = sessionCache ? codexFileStat(filePath) : null;
              const cached = stat ? sessionCache?.entries.get(filePath) : null;
              if (cached && cached.size === stat?.size && cached.mtimeMs === stat.mtimeMs) {
                cacheHits++;
                rejectedMetricRecords += cached.session.rejectedMetricRecords;
                const session = cloneCodexSession(cached.session);
                mergeMetadata(session, session.id ? metadata.get(session.id) : undefined);
                if (session.id || session.start) {
                  sessions.push(session);
                }
                continue;
              }

              cacheMisses++;
              const readStartedAt = Date.now();
              const parser = createCodexSessionParser();
              const readResult = yield* storage.readLines(filePath, parser.visit);
              readMs += Date.now() - readStartedAt;
              bytes += readResult.bytes;

              const parsed = parser.finish();
              lines += parsed.lines;
              parseMs += parsed.parseMs;
              parsedLines += parsed.parsedLines;
              rejectedMetricRecords += parsed.rejectedMetricRecords;
              skippedLines += parsed.skippedLines;
              const session = parsed.session;
              if (stat) {
                parsedForCache.push({ filePath, session: cloneCodexSession(session), stat });
              }
              mergeMetadata(session, session.id ? metadata.get(session.id) : undefined);
              if (session.id || session.start) {
                sessions.push(session);
              }
            }

            if (sessionCache) {
              const cacheWriteStartedAt = Date.now();
              yield* Effect.try({
                try: () => writeCodexSessionCache(sessionCache.db, files, parsedForCache),
                catch: (error) => error,
              }).pipe(Effect.ignore);
              cacheWriteMs = Date.now() - cacheWriteStartedAt;
            }
          }),
        (sessionCache) =>
          sessionCache
            ? Effect.try({
                try: () => sessionCache.db.close(),
                catch: (error) => error,
              }).pipe(Effect.ignore)
            : Effect.succeed(undefined),
      );

      sessions.sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
      return {
        bytes,
        cacheHits,
        cacheMisses,
        cacheReadMs,
        cacheWriteMs,
        files: files.length,
        lines,
        parseMs,
        parsedLines,
        readMs,
        rejectedMetricRecords,
        sessions,
        skippedLines,
      };
    }),
    (result) => ({
      bytes: result.bytes,
      cacheHits: result.cacheHits,
      cacheMisses: result.cacheMisses,
      cacheReadMs: result.cacheReadMs,
      cacheWriteMs: result.cacheWriteMs,
      files: result.files,
      lines: result.lines,
      parseMs: result.parseMs,
      parsedLines: result.parsedLines,
      readMs: result.readMs,
      rejectedMetricRecords: result.rejectedMetricRecords,
      sessions: result.sessions.length,
      skippedLines: result.skippedLines,
    }),
  );

export interface CodexUsageSessionsResult {
  /**
   * Codex declares no skill invocations, so these are `exposed` catalogue
   * entries and `inferred` exec reads. They are collected on the same pass and
   * are never combined into one count (ADR 0022).
   */
  observations: SkillObservation[];
  /** Whether any session hit its per-session observation ceiling. */
  observationsTruncated: boolean;
  rejectedMetricRecords: number;
  /** Skill candidates that failed validation; reported on their own channel. */
  rejectedObservations: number;
  sessions: CodexCollectedSession[];
}

export const readCodexUsageSessionsResult: Effect.Effect<
  CodexUsageSessionsResult,
  LocalHistoryError,
  LocalHistoryStorageService
> = withPerfSpan(
  'aiUsage.collect.codex.usageSessions',
  Effect.gen(function* () {
    const metadata = yield* readCodexThreadMetadata;
    const { rejectedMetricRecords, sessions } = yield* readCodexSessions(metadata);
    const byId = new Map<string, CodexSession>();
    for (const session of sessions) {
      if (session.id) {
        byId.set(session.id, session);
      }
    }
    const children = new Map<string, CodexSession[]>();
    for (const session of sessions) {
      if (session.id && session.parent && byId.has(session.parent)) {
        const siblings = children.get(session.parent) ?? [];
        siblings.push(session);
        children.set(session.parent, siblings);
      }
    }

    const usageSessions: CodexCollectedSession[] = [];
    for (const session of sessions) {
      const kids = (session.id && children.get(session.id)) || [];
      const tokens = {
        in: session.tin,
        out: session.tout,
        cr: session.tcr,
        cw: 0,
      };
      const origin = codexOrigin(session);
      const isSubagent = origin === 'subagent';
      const classifierRootSourceSessionId = origin === 'classifier' ? session.classifierParent : null;
      const parentSession = session.parent ? byId.get(session.parent) : undefined;
      const subscription = session.subscription || Boolean(parentSession?.subscription);
      const usageOwnedByRoot = isCodexUsageOwnedByRoot(session, byId);
      const modelSegments = codexModelSegments(session);
      const costApprox = modelSegments.reduce((total, segment) => total + segment.costApprox, 0);
      const costKnown = modelSegments.every((segment) => segment.costKnown);
      usageSessions.push({
        source: {
          harnessKey: 'codex',
          sourceSessionId: session.id,
          ...(session.parent === null ? {} : { parentSourceSessionId: session.parent }),
          ...(classifierRootSourceSessionId ? { rootSourceSessionId: classifierRootSourceSessionId } : {}),
          sourcePath: session.cwd,
          ...(session.vcs ? { vcs: session.vcs } : {}),
        },
        projectPath: session.cwd,
        date: session.start,
        endDate: session.end,
        provider: subscription ? 'Codex sub' : 'Codex API',
        model: session.model,
        ...(usageOwnedByRoot ? {} : { modelSegments }),
        models: session.models,
        name: codexSessionName(session),
        ...(origin === undefined ? { originProvenance: 'origin-absent' as const } : { origin }),
        titleSource: codexTitleSource(session, isSubagent),
        project: base(session.cwd),
        tokens: usageOwnedByRoot ? { cr: 0, cw: 0, in: 0, out: 0 } : tokens,
        cost: subscription ? actualCost(0) : approximateApiCost,
        costApprox: usageOwnedByRoot ? 0 : costApprox,
        costKnown: usageOwnedByRoot || costKnown,
        calls: 1,
        durationMs: session.activeDurationMs ?? 0,
        partial: session.reportPartial,
        turns: session.turns,
        tools: session.tools,
        linesAdded: null,
        linesDeleted: null,
        subagent: isSubagent || kids.length > 0,
        usageUnavailable: usageOwnedByRoot || !session.hasTokenUsage,
      });
    }

    // A rollout file can appear under more than one session id, so
    // observations are deduplicated on the identity the store keys on.
    const observations: SkillObservation[] = [];
    const seenObservations = new Set<string>();
    let rejectedObservations = 0;
    let observationsTruncated = false;
    for (const session of sessions) {
      rejectedObservations += session.skillObservationRejects;
      observationsTruncated ||= session.skillObservationsTruncated;
      for (const observation of session.skillObservations) {
        const identity = skillObservationIdentity(observation);
        if (seenObservations.has(identity)) {
          continue;
        }
        seenObservations.add(identity);
        observations.push(observation);
      }
    }

    return {
      observations,
      observationsTruncated,
      rejectedMetricRecords,
      rejectedObservations,
      sessions: usageSessions,
    };
  }),
  (result) => ({
    observations: result.observations.length,
    rejectedMetricRecords: result.rejectedMetricRecords,
    sessions: result.sessions.length,
  }),
);

export const readCodexUsageSessions: Effect.Effect<
  CodexCollectedSession[],
  LocalHistoryError,
  LocalHistoryStorageService
> = readCodexUsageSessionsResult.pipe(Effect.map((result) => result.sessions));

const findLatestRawCodexRateLimits = (
  recentFileLimit = 40,
): Effect.Effect<RawCodexRateLimitSnapshot | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    let latest: RawCodexRateLimitSnapshot | null = null;
    const files = (yield* listCodexSessionFilesForCollection).sort();

    for (const filePath of files.slice(-recentFileLimit).reverse()) {
      yield* storage.readLines(filePath, (line) => {
        if (!line.includes('rate_limits')) {
          return;
        }
        const event = safeJSON(line);
        const payload = isRecord(event?.payload) ? event.payload : null;
        const rateLimits = isRecord(payload?.rate_limits) ? payload.rate_limits : null;
        if (!rateLimits) {
          return;
        }
        if (typeof event?.timestamp !== 'string' && typeof event?.timestamp !== 'number') {
          return;
        }
        const ts = new Date(event.timestamp);
        if (!Number.isFinite(ts.getTime())) {
          return;
        }
        if (!latest || ts > latest.ts) {
          latest = { ts, rateLimits };
        }
      });
      if (latest) {
        break;
      }
    }

    return latest;
  });

export const findLatestCodexQuotaSnapshot = (
  recentFileLimit = 40,
): Effect.Effect<CodexQuotaSnapshot | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const status = yield* findLatestCodexProviderStatus({ recentFileLimit });
    if (!status) {
      return null;
    }
    const primary = status.windows.find((window) => window.id === 'primary') ?? null;
    const secondary = status.windows.find((window) => window.id === 'secondary') ?? null;
    return {
      ts: new Date(status.generatedAt),
      planType: status.plan ?? 'unknown',
      primary: providerWindowToQuotaWindow(primary),
      secondary: providerWindowToQuotaWindow(secondary),
      credits: status.resetCreditsAvailable ?? null,
    };
  });

const providerWindowToQuotaWindow = (window: ProviderStatus['windows'][number] | null): CodexQuotaWindow | null => {
  if (!window) {
    return null;
  }
  return {
    windowMinutes: window.limitSeconds === null ? 0 : window.limitSeconds / 60,
    usedPercent: window.usedPercent ?? 0,
    resetsAt: window.resetsAt ? new Date(window.resetsAt) : null,
  };
};

export const findLatestCodexProviderStatus = (
  options: CodexProviderStatusOptions = {},
): Effect.Effect<ProviderStatus | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const latest = yield* findLatestRawCodexRateLimits(options.recentFileLimit ?? 40);
    if (!latest) {
      return null;
    }
    return normalizeCodexRateLimitStatus({
      rateLimits: latest.rateLimits,
      generatedAt: latest.ts,
      source: 'local-history',
      ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
      ...(options.machineId === undefined ? {} : { machineId: options.machineId }),
      ...(options.machineLabel === undefined ? {} : { machineLabel: options.machineLabel }),
    });
  });
