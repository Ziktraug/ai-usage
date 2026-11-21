// biome-ignore-all lint/style/noExcessiveLinesPerFile: legacy, plan 127
import fs from 'node:fs';
import path from 'node:path';
import { isMissingHistoryFileError, type LocalHistoryError } from '@ai-usage/local-machine/errors';
import {
  CODEX_DETAIL_MAX_PHASES,
  type CodexSession,
  type CodexSessionPhase,
  type CodexSubagentKind,
  type CodexThreadMetadata,
  type CodexThreadMetadataRow,
  type CodexThreadSpawnEdgeRow,
  codexArchivedSessionsDir,
  codexModelSegments,
  codexParentsFromEdges,
  codexRolloutSessionIdCandidates,
  codexStateDbCandidates,
  codexThreadMetadataFromRow,
  createCodexSessionParser,
  isCodexExternalImport,
  isCodexUsageOwnedByRoot,
  isCodexUsageOwnershipUndecided,
  isRecord,
  listCodexRolloutFiles,
  codexSessionsDir as localCodexSessionsDir,
  mergeMetadata,
  nonEmpty,
  readCodexRolloutWithFallback,
  THREAD_METADATA_SQL,
} from '@ai-usage/local-machine/internal/codex-history';
import {
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-machine/local-history';
import { firstExisting } from '@ai-usage/local-machine/platform-paths';
import { base, safeJSON } from '@ai-usage/local-machine/text';
import { type CodexWorkObservation, parseCodexWorkObservation } from '@ai-usage/report-core/codex-work-observation';
import { normalizeCodexRateLimitStatus, type ProviderStatus } from '@ai-usage/report-core/provider-status';
import { parseSessionVcsContext, type SessionVcsContext } from '@ai-usage/report-core/session-vcs';
import {
  completeSkillObservationCollection,
  MAX_SKILL_OBSERVATION_BATCH,
  type SkillObservation,
  type SkillObservationCollectionCompleteness,
  skillObservationIdentity,
} from '@ai-usage/report-core/skill-observation';
import type { SessionOrigin } from '@ai-usage/report-core/types';
import { actualCost, approximateApiCost } from '@ai-usage/report-core/usage-row';
import { Effect, Result } from 'effect';
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
  listCodexRolloutFiles,
  (list) => ({ archivedWalkFailed: list.archivedWalkFailure !== null, files: list.files.length }),
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
  /** Why `archived_sessions` was not listed this pass, when its walk failed. */
  archivedWalkFailure: LocalHistoryError | null;
  bytes: number;
  cacheHits: number;
  cacheMisses: number;
  cacheReadMs: number;
  cacheWriteMs: number;
  files: number;
  lines: number;
  /** Admitted lines the parser dropped as invalid JSON or undated, summed over the sessions. */
  malformedLines: number;
  observationCompleteness: SkillObservationCollectionCompleteness;
  /** `changed` when only the rollouts read this pass carry their skill observations. */
  observationScope: 'all' | 'changed';
  oversizedLines: number;
  parsedLines: number;
  parseMs: number;
  /** One entry per rollout whose read failed; the file was skipped, not cached. */
  readFailures: LocalHistoryError[];
  readMs: number;
  rejectedMetricRecords: number;
  rejectedSkillObservationRecords: number;
  sessions: CodexSession[];
  skippedLines: number;
  unreadableFiles: number;
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

interface ResidentCodexRollout extends CodexSessionFileStat {
  /** How many skill observations the full session carries; the resident copy holds none. */
  observationCount: number;
  /** The parsed session before thread metadata is merged, without its skill observations. */
  session: CodexSession;
}

/**
 * What a long-running collector keeps between passes so an unchanged rollout costs one `stat`:
 * every parsed session except its skill observations, which are four fifths of the cache and are
 * only needed when the rollout changes. Owned by one collector; never shared between homes.
 */
export interface CodexResidentIndex {
  home: string | null;
  /**
   * The most skill observations the rollouts may hold in total for the index to answer. It is the
   * bound of one engine import: above it the engine truncates the full list by recency, which a
   * pass that returns the observations of changed rollouts only cannot reproduce.
   */
  readonly maximumObservations: number;
  /** Null until a complete pass has filled it, and again whenever it can no longer be trusted. */
  rollouts: Map<string, ResidentCodexRollout> | null;
}

export const createCodexResidentIndex = (maximumObservations = MAX_SKILL_OBSERVATION_BATCH): CodexResidentIndex => ({
  home: null,
  maximumObservations,
  rollouts: null,
});

export interface CodexIncrementalRead {
  /**
   * True asks for everything, as a collector without an index returns it: the caller could not
   * record what an earlier pass returned, so nothing may be left out as already delivered.
   */
  readonly complete: boolean;
  readonly index: CodexResidentIndex;
}

interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface SqliteDatabase {
  close: () => void;
  exec: (sql: string) => unknown;
  query: (sql: string) => SqliteStatement;
}

// This cache stores normalized parser output, not raw JSONL. Bump whenever an
// unchanged rollout could produce different counters, labels, origin, lineage,
// phases, or turns.
// Bumped to 21 because system-skill paths, namespaced plugin reads, unreadable-line
// completeness, and distinct rejection diagnostics now produce different skill
// facts. Older versions would preserve missing, incorrectly named, falsely
// complete, or double-counted results for an unchanged rollout.
// Bumped to 22 because an unreadable line is now charged only to the channel it
// could have carried — invocation for a tool call, exposure for a catalogue,
// neither for a line admitted only for usage rows. A version 21 entry carries
// reject counts inflated by lines that could never have held a skill signal, and
// reusing it would keep reporting a complete read as a lower bound.
// Bumped to 23 because the per-line byte bound rose to 32 MiB and an oversized
// record is now dropped and counted instead of failing the read. A version 22
// entry was written when a pasted-image record could still abort the file, so an
// unchanged rollout now yields more turns, tokens, and phases — and carries an
// `oversizedLines` count that older entries cannot report.
// Version 24 distinguishes fully recovered counter resets from uncertain metrics
// and records the latest anomaly date, including on unchanged cached sessions.
// Bumped to 25 because child token ownership now uses the declared session birth
// and native task evidence instead of retaining inherited cumulative snapshots.
// An unchanged rollout must also recover lost generations and partial status.
// Version 27 also records loss from recognized native requests/outputs with invalid timestamps.
// 28: sessions keep `session_meta.source`, so `codex exec` runs are told apart from interactive ones.
// 29: sessions count `external-import-turn-N` tasks, so transcripts Codex Desktop
// imported from another harness are retired instead of emitted as empty rows.
// 30: sessions carry `malformedLines` (admitted lines that did not parse or had no
// timestamp), which a version 29 entry cannot report and which blocks retirement.
const CODEX_SESSION_CACHE_VERSION = 30;

// The runtime's op-count yielding cannot split one long synchronous
// decompress-and-parse, and a cold pass over thousands of rollouts chains many
// of them, so the loop yields explicitly: `Effect.sleep(0)` suspends the fiber
// and resumes it from the scheduler's macrotask dispatch (`setImmediate`),
// which lets timers and I/O callbacks run in between. The slice counts
// accumulated read-and-parse time, not wall-clock since the last sleep, so
// cache hits, GC pauses and a loaded runner cannot push a small
// `Effect.runSync` fixture over it, while a cold pass still yields regularly.
const CODEX_PARSE_YIELD_SLICE_MS = 50;

const THREAD_SPAWN_EDGES_SQL = `
select parent_thread_id as parent, child_thread_id as child
from thread_spawn_edges
`;

// Codex writes its state database while it runs. The read-only open refuses a database whose
// identity moves under it, so a pass that meets a write used to fall back to no metadata at all:
// every row that takes its parent, model or origin from the database was rewritten without them and
// rewritten again on the next pass. The check is retried before giving up.
const CODEX_METADATA_READ_ATTEMPTS = 3;
const CODEX_METADATA_RETRY_DELAY_MS = 100;

interface CodexThreadMetadataRead {
  /**
   * Why the state database gave no metadata although it exists. The sessions of the pass are then
   * built from their rollouts alone; the caller reports it rather than let the rows change quietly.
   */
  failure: LocalHistoryError | null;
  metadata: Map<string, CodexThreadMetadata>;
}

const readCodexThreadMetadata: Effect.Effect<CodexThreadMetadataRead, LocalHistoryError, LocalHistoryStorageService> =
  withPerfSpan(
    'aiUsage.collect.codex.threadMetadata',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const dbPath = yield* firstExisting(storage, ...codexStateDbCandidates(storage));
      if (!dbPath) {
        return { failure: null, metadata: new Map<string, CodexThreadMetadata>() };
      }

      const read = Effect.acquireUseRelease(
        // Suspended so each attempt opens the database again.
        withPerfSpan(
          'aiUsage.collect.codex.threadMetadata.open',
          Effect.suspend(() => storage.openDatabase(dbPath)),
        ),
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
      );
      for (let attempt = 1; ; attempt++) {
        const result = yield* Effect.result(read);
        if (Result.isSuccess(result)) {
          return { failure: null, metadata: result.success };
        }
        if (attempt >= CODEX_METADATA_READ_ATTEMPTS || result.failure.operation !== 'sqlite.identityChanged') {
          return { failure: result.failure, metadata: new Map<string, CodexThreadMetadata>() };
        }
        yield* Effect.sleep(CODEX_METADATA_RETRY_DELAY_MS);
      }
    }),
    (read) => ({ failed: read.failure !== null, rows: read.metadata.size }),
  );

const cloneCodexSession = (session: CodexSession): CodexSession => ({
  ...session,
  workObservation: session.workObservation === null ? null : parseCodexWorkObservation(session.workObservation),
  end: session.end ? new Date(session.end) : null,
  models: [...session.models],
  skillObservations: session.skillObservations.map((observation) => ({ ...observation })),
  skillObservationCompleteness: {
    exposure: { ...session.skillObservationCompleteness.exposure },
    invocation: { ...session.skillObservationCompleteness.invocation },
  },
  phases: session.phases.map((phase) => ({
    ...phase,
    end: new Date(phase.end),
    start: new Date(phase.start),
  })),
  start: session.start ? new Date(session.start) : null,
  ...(session.vcs ? { vcs: parseSessionVcsContext(JSON.parse(JSON.stringify(session.vcs))) } : {}),
});

const residentCodexRollout = (stat: CodexSessionFileStat, session: CodexSession): ResidentCodexRollout => ({
  ...stat,
  observationCount: session.skillObservations.length,
  session: { ...session, skillObservations: [] },
});

/**
 * A copy `mergeMetadata` may write to. It reassigns scalar fields and `models` and rewrites each
 * phase's model, so those are copied; dates, the VCS context and the work observation are never
 * written after parsing and stay shared with the resident session.
 */
const residentCodexSessionCopy = (session: CodexSession): CodexSession => ({
  ...session,
  models: [...session.models],
  phases: session.phases.map((phase) => ({ ...phase })),
  skillObservations: [],
  skillObservationCompleteness: {
    exposure: { ...session.skillObservationCompleteness.exposure },
    invocation: { ...session.skillObservationCompleteness.invocation },
  },
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

const reviveSkillObservationCompletenessPart = (
  value: unknown,
): SkillObservationCollectionCompleteness['exposure'] | null => {
  if (!(isRecord(value) && Object.keys(value).every((key) => key === 'rejected' || key === 'truncated'))) {
    return null;
  }
  const rejected = parseNonNegativeSafeInteger(value.rejected);
  return rejected.ok && typeof value.truncated === 'boolean'
    ? { rejected: rejected.value, truncated: value.truncated }
    : null;
};

const reviveSkillObservationCompleteness = (value: unknown): SkillObservationCollectionCompleteness | null => {
  if (!(isRecord(value) && Object.keys(value).every((key) => key === 'exposure' || key === 'invocation'))) {
    return null;
  }
  const exposure = reviveSkillObservationCompletenessPart(value.exposure);
  const invocation = reviveSkillObservationCompletenessPart(value.invocation);
  return exposure && invocation ? { exposure, invocation } : null;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
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
      value.rejectedSkillObservationRecords,
      value.oversizedLines,
      value.importedTasks,
      value.malformedLines,
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
    const skillObservationCompleteness = reviveSkillObservationCompleteness(value.skillObservationCompleteness);
    const workObservation = value.workObservation === null ? null : parseCodexWorkObservation(value.workObservation);
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
      (value.lastRejectedMetricAt !== undefined &&
        (typeof value.lastRejectedMetricAt !== 'string' || !Number.isFinite(Date.parse(value.lastRejectedMetricAt)))) ||
      typeof value.durationPartial !== 'boolean' ||
      typeof value.reportPartial !== 'boolean' ||
      (value.classifierParent !== null && typeof value.classifierParent !== 'string') ||
      (value.subagentKind !== null && !isCodexSubagentKind(value.subagentKind)) ||
      !(activeDuration === null || activeDuration.ok) ||
      models === null ||
      models.length !== rawModels?.length ||
      phases === null ||
      !skillObservations.valid ||
      skillObservationCompleteness === null ||
      (value.workObservation !== null && workObservation === null)
    ) {
      return null;
    }
    const [
      turns,
      tools,
      maxTotal,
      tin,
      tcr,
      tout,
      rejectedMetricRecords,
      rejectedSkillObservationRecords,
      oversizedLines,
      importedTasks,
      malformedLines,
    ] = counters;
    if (!(turns?.ok && tools?.ok && maxTotal?.ok && tin?.ok && tcr?.ok && tout?.ok && rejectedMetricRecords?.ok)) {
      return null;
    }
    if (!(rejectedSkillObservationRecords?.ok && oversizedLines?.ok && importedTasks?.ok && malformedLines?.ok)) {
      return null;
    }
    return {
      workObservation,
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
      launchSource: typeof value.launchSource === 'string' ? value.launchSource : null,
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
      ...(typeof value.lastRejectedMetricAt === 'string' ? { lastRejectedMetricAt: value.lastRejectedMetricAt } : {}),
      rejectedSkillObservationRecords: rejectedSkillObservationRecords.value,
      oversizedLines: oversizedLines.value,
      malformedLines: malformedLines.value,
      hasTokenUsage: value.hasTokenUsage,
      importedTasks: importedTasks.value,
      skillObservations: skillObservations.observations,
      skillObservationCompleteness,
      ...(vcs ? { vcs } : {}),
    };
  } catch {
    return null;
  }
};

const openCodexSessionCache = async (storage: LocalHistoryStorageService): Promise<SqliteDatabase> => {
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
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization error; there is no usable cache to return.
    }
    throw error;
  }
};

const loadCodexSessionCache = async (storage: LocalHistoryStorageService) => {
  if (!fs.existsSync(localCodexSessionsDir(storage))) {
    return null;
  }

  const db = await openCodexSessionCache(storage);
  try {
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

/**
 * The skill observations the cache holds for rollouts the index kept without them. Null when any
 * of them has no cache entry for the very parse the index holds (same size and mtime), so the
 * caller falls back to a complete pass instead of returning a session with part of its
 * observations, or with those of an older parse.
 */
const readCachedCodexSkillObservations = (
  db: SqliteDatabase,
  rollouts: readonly { filePath: string; stat: CodexSessionFileStat }[],
): Map<string, SkillObservation[]> | null => {
  const select = db.query(
    'SELECT size, mtime_ms, session_json FROM codex_session_cache WHERE file_path = ? AND version = ?',
  );
  const observations = new Map<string, SkillObservation[]>();
  for (const { filePath, stat } of rollouts) {
    const row = select.get(filePath, CODEX_SESSION_CACHE_VERSION) as Omit<CodexSessionCacheRow, 'file_path'> | null;
    // The entry must be the parse the index holds: a cache write that failed leaves an older one.
    const session =
      row && row.size === stat.size && row.mtime_ms === stat.mtimeMs ? reviveCachedSession(row.session_json) : null;
    if (!session) {
      return null;
    }
    observations.set(filePath, session.skillObservations);
  }
  return observations;
};

const writeCodexSessionCache = (
  db: SqliteDatabase,
  files: string[],
  parsed: { filePath: string; session: CodexSession; stat: CodexSessionFileStat }[],
  // Entries under a directory this pass could not list are kept: their files
  // are unseen, not gone, so the next pass that lists them hits the cache.
  unlistedDirectory: string | null,
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
    `DELETE FROM codex_session_cache
     WHERE version != ?
        OR (file_path NOT IN (SELECT value FROM json_each(?))
            AND (? IS NULL OR substr(file_path, 1, length(?)) != ?))`,
  );
  const unlistedPrefix = unlistedDirectory === null ? null : `${unlistedDirectory}${path.sep}`;

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
    deleteStale.run(CODEX_SESSION_CACHE_VERSION, JSON.stringify(files), unlistedPrefix, unlistedPrefix, unlistedPrefix);
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

/** What one rollout read yields: the parser that visited its lines and the reader's own counts. */
interface CodexRolloutParse {
  parser: ReturnType<typeof createCodexSessionParser>;
  result: { bytes: number; oversizedLines: number };
}

interface CodexListedRollout {
  filePath: string;
  session: CodexSession;
  stat: CodexSessionFileStat;
}

type LoadedCodexSessionCache = NonNullable<Awaited<ReturnType<typeof loadCodexSessionCache>>>;

/** What one `readCodexSessions` pass reads from and never changes. */
interface CodexSessionReadContext {
  readonly archivedWalkFailure: LocalHistoryError | null;
  readonly files: string[];
  readonly index: CodexResidentIndex | undefined;
  readonly metadata: Map<string, CodexThreadMetadata>;
  readonly resident: Map<string, ResidentCodexRollout> | null;
  readonly storage: LocalHistoryStorageService;
  readonly unlistedDirectory: string | null;
}

/** The accumulators of one `readCodexSessions` pass. */
interface CodexSessionReadPass {
  bytes: number;
  cacheHits: number;
  cacheMisses: number;
  cacheReadMs: number;
  cacheWriteMs: number;
  // Set when an incremental pass cannot answer exactly; it is then redone as a complete one.
  incrementalRefused: boolean;
  lines: number;
  malformedLines: number;
  // Session ids whose set of rollouts moved this pass: read again, unreadable, or gone.
  readonly movedSessionIds: Set<string>;
  readonly nextRollouts: Map<string, ResidentCodexRollout>;
  readonly observationCompleteness: SkillObservationCollectionCompleteness;
  observationCount: number;
  oversizedLines: number;
  readonly parsedForCache: CodexListedRollout[];
  parsedLines: number;
  parseMs: number;
  readonly readFailures: LocalHistoryError[];
  readMs: number;
  rejectedMetricRecords: number;
  rejectedSkillObservationRecords: number;
  readonly residentHits: CodexListedRollout[];
  readonly sessions: CodexSession[];
  skippedLines: number;
  unreadableFiles: number;
  readonly unreadablePaths: Set<string>;
}

const mergeObservationCompleteness = (
  observationCompleteness: SkillObservationCollectionCompleteness,
  value: SkillObservationCollectionCompleteness,
): void => {
  observationCompleteness.exposure.rejected += value.exposure.rejected;
  observationCompleteness.exposure.truncated ||= value.exposure.truncated;
  observationCompleteness.invocation.rejected += value.invocation.rejected;
  observationCompleteness.invocation.truncated ||= value.invocation.truncated;
};

const takeCachedCodexRollout = (
  pass: CodexSessionReadPass,
  context: CodexSessionReadContext,
  filePath: string,
  stat: CodexSessionFileStat,
  cachedSession: CodexSession,
): void => {
  const { metadata, resident } = context;
  pass.cacheHits++;
  pass.rejectedMetricRecords += cachedSession.rejectedMetricRecords;
  pass.rejectedSkillObservationRecords += cachedSession.rejectedSkillObservationRecords;
  pass.oversizedLines += cachedSession.oversizedLines;
  pass.malformedLines += cachedSession.malformedLines;
  mergeObservationCompleteness(pass.observationCompleteness, cachedSession.skillObservationCompleteness);
  let session: CodexSession;
  if (resident) {
    session = residentCodexSessionCopy(cachedSession);
    pass.observationCount += resident.get(filePath)?.observationCount ?? 0;
    pass.residentHits.push({ filePath, session, stat });
  } else {
    session = cloneCodexSession(cachedSession);
    pass.observationCount += session.skillObservations.length;
    pass.nextRollouts.set(filePath, residentCodexRollout(stat, cachedSession));
  }
  mergeMetadata(session, session.id ? metadata.get(session.id) : undefined);
  if (session.id || session.start) {
    pass.sessions.push(session);
  }
};

const countCodexCacheMiss = (pass: CodexSessionReadPass, context: CodexSessionReadContext, filePath: string): void => {
  pass.cacheMisses++;
  // The id the index held for this file counts even if the file now reads as another
  // session or not at all: its other rollouts lose a competitor either way.
  const previousSessionId = context.resident?.get(filePath)?.session.id;
  if (previousSessionId) {
    pass.movedSessionIds.add(previousSessionId);
  }
};

const recordUnreadableCodexRollout = (
  pass: CodexSessionReadPass,
  filePath: string,
  failure: LocalHistoryError,
): void => {
  // A rollout that cannot be read (a corrupt or truncated
  // archive, a file that vanished mid-scan) costs itself, not
  // the collection source: it is reported, left out of the
  // cache so the next scan retries it, and the scan goes on.
  pass.unreadableFiles++;
  pass.readFailures.push(failure);
  pass.unreadablePaths.add(filePath);
  // The rollout is missing evidence for both skill tiers, so each
  // bound weakens by one source; persisting them as complete
  // would assert an absence this pass could not observe.
  pass.observationCompleteness.exposure.rejected += 1;
  pass.observationCompleteness.invocation.rejected += 1;
};

const takeParsedCodexRollout = (
  pass: CodexSessionReadPass,
  context: CodexSessionReadContext,
  filePath: string,
  stat: CodexSessionFileStat | null,
  read: { readonly path: string; readonly value: CodexRolloutParse },
): void => {
  const { parser, result: readResult } = read.value;
  pass.bytes += readResult.bytes;

  const parsed = parser.finish();
  // The reader dropped these before the parser could see them, so
  // the count is attached here rather than produced by `finish`.
  parsed.session.oversizedLines = readResult.oversizedLines;
  pass.oversizedLines += readResult.oversizedLines;
  pass.malformedLines += parsed.session.malformedLines;
  pass.lines += parsed.lines;
  pass.parseMs += parsed.parseMs;
  pass.parsedLines += parsed.parsedLines;
  pass.rejectedMetricRecords += parsed.rejectedMetricRecords;
  pass.rejectedSkillObservationRecords += parsed.session.rejectedSkillObservationRecords;
  pass.skippedLines += parsed.skippedLines;
  const session = parsed.session;
  pass.observationCount += session.skillObservations.length;
  mergeObservationCompleteness(pass.observationCompleteness, session.skillObservationCompleteness);
  // A rollout read under another path is cached under that path
  // by the next pass, which lists it there.
  if (stat && read.path === filePath) {
    const unmerged = cloneCodexSession(session);
    pass.parsedForCache.push({ filePath, session: unmerged, stat });
    pass.nextRollouts.set(filePath, residentCodexRollout(stat, unmerged));
  }
  mergeMetadata(session, session.id ? context.metadata.get(session.id) : undefined);
  if (session.id) {
    pass.movedSessionIds.add(session.id);
  }
  if (session.id || session.start) {
    pass.sessions.push(session);
  }
};

/** Reads a rollout the cache and the index could not answer for; returns the work time it cost. */
const readMissedCodexRollout = (
  pass: CodexSessionReadPass,
  context: CodexSessionReadContext,
  filePath: string,
  stat: CodexSessionFileStat | null,
) =>
  Effect.gen(function* () {
    const { storage } = context;
    countCodexCacheMiss(pass, context, filePath);
    const readStartedAt = Date.now();
    // Codex may compress or archive the rollout after it was listed;
    // the read follows it to its next form with a fresh parser.
    const read = yield* Effect.result(
      readCodexRolloutWithFallback(storage, filePath, (candidatePath) => {
        const parser = createCodexSessionParser();
        return storage.readLines(candidatePath, parser.visit).pipe(Effect.map((result) => ({ parser, result })));
      }),
    );
    pass.readMs += Date.now() - readStartedAt;
    if (Result.isFailure(read)) {
      recordUnreadableCodexRollout(pass, filePath, read.failure);
    } else {
      takeParsedCodexRollout(pass, context, filePath, stat, read.success);
    }
    return Date.now() - readStartedAt;
  });

const readListedCodexRollouts = (
  pass: CodexSessionReadPass,
  context: CodexSessionReadContext,
  sessionCache: LoadedCodexSessionCache | null,
) =>
  Effect.gen(function* () {
    const { files, resident } = context;
    let sliceWorkMs = 0;
    for (const filePath of files) {
      const stat = sessionCache || resident ? codexFileStat(filePath) : null;
      const cached = stat ? (resident?.get(filePath) ?? sessionCache?.entries.get(filePath)) : null;
      if (cached && cached.size === stat?.size && cached.mtimeMs === stat.mtimeMs) {
        takeCachedCodexRollout(pass, context, filePath, stat, cached.session);
        continue;
      }

      sliceWorkMs += yield* readMissedCodexRollout(pass, context, filePath, stat);
      if (sliceWorkMs >= CODEX_PARSE_YIELD_SLICE_MS) {
        yield* Effect.sleep(0);
        sliceWorkMs = 0;
      }
    }
  });

/** The cold-start cache write of a pass that read through the cache, and the index it leaves. */
const writeCodexColdCache = (
  pass: CodexSessionReadPass,
  context: CodexSessionReadContext,
  sessionCache: LoadedCodexSessionCache,
  retainedFiles: string[],
) =>
  Effect.gen(function* () {
    const { archivedWalkFailure, index, unlistedDirectory } = context;
    const cacheWriteStartedAt = Date.now();
    yield* Effect.try({
      try: () => writeCodexSessionCache(sessionCache.db, retainedFiles, pass.parsedForCache, unlistedDirectory),
      catch: (error) => error,
    }).pipe(Effect.ignore);
    pass.cacheWriteMs = Date.now() - cacheWriteStartedAt;
    if (index) {
      // More observations than one import carries: the engine truncates the full list
      // by recency, which a pass that returns only changed rollouts cannot reproduce.
      // Nor can an index without the archived rollouts answer for the pass that lists them again.
      index.rollouts =
        archivedWalkFailure !== null || pass.observationCount > index.maximumObservations ? null : pass.nextRollouts;
    }
  });

/** Drops the resident entries of unlisted or unreadable rollouts; returns whether any was dropped. */
const pruneResidentCodexRollouts = (
  pass: CodexSessionReadPass,
  files: string[],
  resident: Map<string, ResidentCodexRollout>,
): boolean => {
  // The index follows the same retention as the cache: an unreadable rollout loses its
  // entry, and so does one that is no longer listed. Every directory was walked, since a
  // pass with an unwalked one never reads the index.
  const listed = new Set(files);
  let removed = false;
  for (const [filePath, rollout] of resident) {
    if (!listed.has(filePath) || pass.unreadablePaths.has(filePath)) {
      resident.delete(filePath);
      removed = true;
      if (rollout.session.id) {
        pass.movedSessionIds.add(rollout.session.id);
      }
    }
  }
  return removed;
};

const refreshResidentCodexIndex = (
  pass: CodexSessionReadPass,
  context: CodexSessionReadContext,
  resident: Map<string, ResidentCodexRollout>,
  retainedFiles: string[],
) =>
  Effect.gen(function* () {
    const { files, index, storage, unlistedDirectory } = context;
    const removed = pruneResidentCodexRollouts(pass, files, resident);
    for (const [filePath, rollout] of pass.nextRollouts) {
      resident.set(filePath, rollout);
    }
    // Two rollouts can carry one session id, and their observations are deduplicated
    // across both in session order. When one of them changed, the other's observations
    // are needed too, or the changed copy could win an identity it loses in a full pass.
    // When one of them left the scan, the other's copy is the observation from now on.
    const siblings = pass.residentHits.filter(
      ({ session }) => session.id !== null && pass.movedSessionIds.has(session.id),
    );
    if (index && pass.observationCount > index.maximumObservations) {
      pass.incrementalRefused = true;
      return;
    }
    if (pass.parsedForCache.length === 0 && !removed && siblings.length === 0) {
      return;
    }
    const cacheWriteStartedAt = Date.now();
    const siblingObservations = yield* Effect.tryPromise({
      try: async () => {
        const db = await openCodexSessionCache(storage);
        try {
          try {
            writeCodexSessionCache(db, retainedFiles, pass.parsedForCache, unlistedDirectory);
          } catch {
            // The cache is for the next cold start. An entry left behind by a failed write
            // is older than the index, which the stat check of the read below refuses.
          }
          return readCachedCodexSkillObservations(db, siblings);
        } finally {
          db.close();
        }
      },
      catch: (error) => error,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    pass.cacheWriteMs = Date.now() - cacheWriteStartedAt;
    if (siblings.length === 0) {
      return;
    }
    if (siblingObservations === null) {
      pass.incrementalRefused = true;
      return;
    }
    for (const { filePath, session } of siblings) {
      session.skillObservations = siblingObservations.get(filePath) ?? [];
    }
  });

const readAndRetainCodexRollouts = (
  pass: CodexSessionReadPass,
  context: CodexSessionReadContext,
  sessionCache: LoadedCodexSessionCache | null,
) =>
  Effect.gen(function* () {
    const { files, resident } = context;
    yield* readListedCodexRollouts(pass, context, sessionCache);

    // A file that failed to read keeps no entry, not even one from an
    // earlier scan, so a stale parse can never stand in for it.
    const retainedFiles =
      pass.unreadablePaths.size === 0 ? files : files.filter((filePath) => !pass.unreadablePaths.has(filePath));
    if (sessionCache) {
      yield* writeCodexColdCache(pass, context, sessionCache, retainedFiles);
    }
    if (!resident) {
      return;
    }
    yield* refreshResidentCodexIndex(pass, context, resident, retainedFiles);
  });

const readCodexSessions = (
  metadata: Map<string, CodexThreadMetadata>,
  incremental?: CodexIncrementalRead,
): Effect.Effect<CodexSessionReadResult, LocalHistoryError, LocalHistoryStorageService> =>
  withPerfSpan(
    'aiUsage.collect.codex.sessions',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const index = incremental?.index;
      if (index && index.home !== storage.home) {
        index.home = storage.home;
        index.rollouts = null;
      }
      const { archivedWalkFailure, files } = yield* listCodexSessionFilesForCollection;
      // An incremental pass reads the index instead of the cache; a complete one refills it.
      // A pass that could not walk the archived directory is complete, and so is the one after
      // it: the copies of the unlisted rollouts drop out of their sessions and come back on
      // recovery, which only a complete pass returns as a full collection does.
      const resident =
        incremental?.complete === false && archivedWalkFailure === null ? (index?.rollouts ?? null) : null;
      if (index && !resident) {
        // Refilled below only when this pass can vouch for every entry.
        index.rollouts = null;
      }
      const pass: CodexSessionReadPass = {
        bytes: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheReadMs: 0,
        cacheWriteMs: 0,
        incrementalRefused: false,
        lines: 0,
        malformedLines: 0,
        movedSessionIds: new Set<string>(),
        nextRollouts: new Map<string, ResidentCodexRollout>(),
        observationCompleteness: completeSkillObservationCollection(),
        observationCount: 0,
        oversizedLines: 0,
        parsedForCache: [],
        parsedLines: 0,
        parseMs: 0,
        readFailures: [],
        readMs: 0,
        rejectedMetricRecords: 0,
        rejectedSkillObservationRecords: 0,
        residentHits: [],
        sessions: [],
        skippedLines: 0,
        unreadableFiles: 0,
        unreadablePaths: new Set<string>(),
      };
      const { observationCompleteness } = pass;
      if (archivedWalkFailure) {
        // The archived rollouts are missing from this pass, so like an
        // unreadable file each skill tier weakens by one source.
        observationCompleteness.exposure.rejected += 1;
        observationCompleteness.invocation.rejected += 1;
      }
      const context: CodexSessionReadContext = {
        archivedWalkFailure,
        files,
        index,
        metadata,
        resident,
        storage,
        unlistedDirectory: archivedWalkFailure ? codexArchivedSessionsDir(storage) : null,
      };

      yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          if (resident) {
            return null;
          }
          const cacheReadStartedAt = Date.now();
          const sessionCache = fs.existsSync(localCodexSessionsDir(storage))
            ? yield* Effect.tryPromise({
                try: () => loadCodexSessionCache(storage),
                catch: (error) => error,
              }).pipe(Effect.catch(() => Effect.succeed(null)))
            : null;
          pass.cacheReadMs = Date.now() - cacheReadStartedAt;
          return sessionCache;
        }),
        (sessionCache) => readAndRetainCodexRollouts(pass, context, sessionCache),
        (sessionCache) =>
          sessionCache
            ? Effect.try({
                try: () => sessionCache.db.close(),
                catch: (error) => error,
              }).pipe(Effect.ignore)
            : Effect.succeed(undefined),
      );

      if (pass.incrementalRefused && index) {
        index.rollouts = null;
        return yield* readCodexSessions(metadata, { complete: true, index });
      }

      const { sessions } = pass;
      sessions.sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
      return {
        archivedWalkFailure,
        bytes: pass.bytes,
        cacheHits: pass.cacheHits,
        cacheMisses: pass.cacheMisses,
        cacheReadMs: pass.cacheReadMs,
        cacheWriteMs: pass.cacheWriteMs,
        files: files.length,
        lines: pass.lines,
        malformedLines: pass.malformedLines,
        observationCompleteness,
        observationScope: resident ? ('changed' as const) : ('all' as const),
        oversizedLines: pass.oversizedLines,
        parseMs: pass.parseMs,
        parsedLines: pass.parsedLines,
        readFailures: pass.readFailures,
        readMs: pass.readMs,
        rejectedMetricRecords: pass.rejectedMetricRecords,
        rejectedSkillObservationRecords: pass.rejectedSkillObservationRecords,
        sessions,
        skippedLines: pass.skippedLines,
        unreadableFiles: pass.unreadableFiles,
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
      malformedLines: result.malformedLines,
      observationScope: result.observationScope,
      oversizedLines: result.oversizedLines,
      parseMs: result.parseMs,
      parsedLines: result.parsedLines,
      readMs: result.readMs,
      rejectedMetricRecords: result.rejectedMetricRecords,
      rejectedSkillObservationRecords: result.rejectedSkillObservationRecords,
      sessions: result.sessions.length,
      skippedLines: result.skippedLines,
      unreadableFiles: result.unreadableFiles,
    }),
  );

export interface CodexUsageSessionsResult {
  /**
   * Why `archived_sessions` was not listed this pass. Its rollouts are missing
   * from the pass and retried on the next; the collector surfaces it as a
   * `codex` warning.
   */
  archivedWalkFailure: LocalHistoryError | null;
  /**
   * Lines the prefix gate admitted and the parser dropped as invalid JSON or
   * undated; the affected sessions are lower bounds and are never retired.
   */
  malformedLines: number;
  metricWarningContext: { affectedSessions: number; lastObservedAt?: string };
  observationCompleteness: SkillObservationCollectionCompleteness;
  /**
   * Present on an incremental read that returned the skill observations of the rollouts it read
   * this pass only; the others were returned by an earlier pass. Absent means all of them.
   */
  observationScope?: 'changed';
  /**
   * Codex declares no skill invocations, so these are `exposed` catalogue
   * entries and `inferred` exec reads. They are collected on the same pass and
   * are never combined into one count (ADR 0022).
   */
  observations: SkillObservation[];
  /** Records dropped by the reader for exceeding the per-line byte bound. */
  oversizedLines: number;
  /**
   * Child sessions left out of this pass because whether their root owns their
   * usage depends on an ancestor whose rollout was not read. Importing them
   * would overwrite a root-owned row with a session that owns its usage; they
   * are re-decided on the next pass that reads the ancestor.
   */
  ownershipDeferredSessions: number;
  /**
   * Rollouts whose read failed (for example an archive that no longer
   * decompresses). Each is skipped for this pass and retried on the next; the
   * collector surfaces every one as a `codex` warning.
   */
  readFailures: readonly LocalHistoryError[];
  rejectedMetricRecords: number;
  rejectedSkillObservationRecords: number;
  /**
   * Session ids this pass read and classified as not Codex usage: transcripts
   * Codex Desktop imported from another harness (ADR 0091). Only positively
   * observed rollouts, never an id that is merely absent or unreadable; the
   * store marks their rows deleted and a later native re-emission revives them.
   */
  retiredSourceSessionIds: string[];
  sessions: CodexCollectedSession[];
  /**
   * Why the thread-metadata database could not be read although it exists (still being written
   * after the retries, or a query that failed). The sessions carry what their rollouts record
   * only; the collector surfaces it as a `codex` warning.
   */
  threadMetadataFailure: LocalHistoryError | null;
  /** Local-only auxiliary attention evidence from the same parser pass. */
  workObservations: CodexWorkObservation[];
}

const readCodexUsageSessionsResultWith = (
  incremental?: CodexIncrementalRead,
): Effect.Effect<CodexUsageSessionsResult, LocalHistoryError, LocalHistoryStorageService> =>
  withPerfSpan(
    'aiUsage.collect.codex.usageSessions',
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
    Effect.gen(function* () {
      const { failure: threadMetadataFailure, metadata } = yield* readCodexThreadMetadata;
      const {
        archivedWalkFailure,
        malformedLines,
        observationCompleteness,
        observationScope,
        oversizedLines,
        readFailures,
        rejectedMetricRecords,
        rejectedSkillObservationRecords,
        sessions: readSessions,
      } = yield* readCodexSessions(metadata, incremental);
      // An imported transcript leaves every Codex output here: it is neither a
      // row nor skill or work evidence of this harness. Its id is returned so the
      // store can retire the row an earlier pass emitted for it.
      const importedSessionIds = new Set<string>();
      const sessions = readSessions.filter((session) => {
        if (!isCodexExternalImport(session)) {
          return true;
        }
        if (session.id) {
          importedSessionIds.add(session.id);
        }
        return false;
      });
      // Classified per rollout; an id is retired only when no rollout kept it as a
      // Codex session, so an import copy never retires the native thread it shares
      // an id with (whether that thread is emitted or deferred this pass).
      const keptSessionIds = new Set(sessions.flatMap((session) => (session.id ? [session.id] : [])));
      const retiredSourceSessionIds = [...importedSessionIds].filter((id) => !keptSessionIds.has(id));
      const byId = new Map<string, CodexSession>();
      for (const session of sessions) {
        // A rollout and its resumed continuation share an id; the one with the
        // larger cumulative counter is the more complete reading of the thread.
        if (session.id && (byId.get(session.id)?.maxTotal ?? -1) < session.maxTotal) {
          byId.set(session.id, session);
        }
      }
      const children = new Map<string, CodexSession[]>();
      for (const session of sessions) {
        if (session.id && session.parent && byId.has(session.parent)) {
          const siblings = children.getOrInsertComputed(session.parent, () => []);
          siblings.push(session);
        }
      }

      // Session ids the unread rollouts may hold, from their file names. With
      // the archived directory unlisted, any missing ancestor may be there.
      const unreadableSessionIds = new Set(
        readFailures.flatMap((failure) =>
          failure.path ? codexRolloutSessionIdCandidates(path.basename(failure.path)) : [],
        ),
      );
      const isUnreadableSession = (sessionId: string): boolean =>
        archivedWalkFailure !== null || unreadableSessionIds.has(sessionId);

      const usageSessions: CodexCollectedSession[] = [];
      let ownershipDeferredSessions = 0;
      for (const session of sessions) {
        if (isCodexUsageOwnershipUndecided(session, byId, isUnreadableSession)) {
          ownershipDeferredSessions++;
          continue;
        }
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
            ...(session.launchSource === null
              ? {}
              : { launchMode: session.launchSource === 'exec' ? ('exec' as const) : ('interactive' as const) }),
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

      // Two rollouts can carry one session id (a thread and the rollout it was resumed into). Both
      // became a row under one row key, so every pass rewrote the stored row twice, the first copy
      // over the second and back, and reported a change that was none. Only the copy the store kept
      // is emitted: the last one in session order.
      const lastEmittedById = new Map<string, CodexCollectedSession>();
      for (const session of usageSessions) {
        const sessionId = session.source.sourceSessionId;
        if (sessionId) {
          lastEmittedById.set(sessionId, session);
        }
      }
      const emittedSessions = usageSessions.filter((session) => {
        const sessionId = session.source.sourceSessionId;
        return !sessionId || lastEmittedById.get(sessionId) === session;
      });

      // A rollout file can appear under more than one session id, so
      // observations are deduplicated on the identity the store keys on.
      const observations: SkillObservation[] = [];
      const seenObservations = new Set<string>();
      for (const session of sessions) {
        for (const observation of session.skillObservations) {
          const identity = skillObservationIdentity(observation);
          if (seenObservations.has(identity)) {
            continue;
          }
          seenObservations.add(identity);
          observations.push(observation);
        }
      }

      const rejectedSessions = sessions.filter((session) => session.rejectedMetricRecords > 0);
      const lastObservedAt = rejectedSessions.every((session) => session.lastRejectedMetricAt !== undefined)
        ? rejectedSessions
            .map((session) => session.lastRejectedMetricAt!)
            .sort()
            .at(-1)
        : undefined;
      return {
        workObservations: sessions.flatMap((session) =>
          session.workObservation === null ? [] : [session.workObservation],
        ),
        metricWarningContext: {
          affectedSessions: rejectedSessions.length,
          ...(lastObservedAt ? { lastObservedAt } : {}),
        },
        archivedWalkFailure,
        malformedLines,
        observationCompleteness,
        ...(observationScope === 'changed' ? { observationScope } : {}),
        observations,
        oversizedLines,
        ownershipDeferredSessions,
        readFailures,
        rejectedMetricRecords,
        rejectedSkillObservationRecords,
        retiredSourceSessionIds,
        sessions: emittedSessions,
        threadMetadataFailure,
      };
    }),
    (result) => ({
      archivedWalkFailed: result.archivedWalkFailure !== null,
      malformedLines: result.malformedLines,
      observations: result.observations.length,
      ownershipDeferredSessions: result.ownershipDeferredSessions,
      oversizedLines: result.oversizedLines,
      rejectedMetricRecords: result.rejectedMetricRecords,
      rejectedSkillObservationRecords: result.rejectedSkillObservationRecords,
      retiredSourceSessions: result.retiredSourceSessionIds.length,
      sessions: result.sessions.length,
      unreadableFiles: result.readFailures.length,
    }),
  );

export const readCodexUsageSessionsResult: Effect.Effect<
  CodexUsageSessionsResult,
  LocalHistoryError,
  LocalHistoryStorageService
> = readCodexUsageSessionsResultWith();

/**
 * The same result read through a resident index: rows, work observations and retirements are
 * always complete, and an unchanged rollout costs one `stat`. Skill observations are complete on a
 * `complete` read and otherwise limited to the rollouts read this pass (`observationScope`).
 */
export const readCodexUsageSessionsIncrementally = (
  incremental: CodexIncrementalRead,
): Effect.Effect<CodexUsageSessionsResult, LocalHistoryError, LocalHistoryStorageService> =>
  readCodexUsageSessionsResultWith(incremental);

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
    const { archivedWalkFailure, files } = yield* listCodexSessionFilesForCollection;
    const skippedFailures: LocalHistoryError[] = archivedWalkFailure ? [archivedWalkFailure] : [];

    for (const filePath of [...files].sort().slice(-recentFileLimit).reverse()) {
      let candidate: RawCodexRateLimitSnapshot | null = null;
      const read = yield* Effect.result(
        readCodexRolloutWithFallback(storage, filePath, (candidatePath) => {
          candidate = null;
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
          return storage.readLines(candidatePath, (line) => {
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
            if (!candidate || ts > candidate.ts) {
              candidate = { ts, rateLimits };
            }
          });
        }),
      );
      if (Result.isFailure(read)) {
        // An archive that does not decompress, or a rollout gone in every
        // form, is skipped for the next (older) one; the sessions collector
        // reports the same file. Any other failure is the reader's to report.
        if (!(read.failure.operation === 'readLines.decompress' || isMissingHistoryFileError(read.failure))) {
          return yield* Effect.fail(read.failure);
        }
        skippedFailures.push(read.failure);
        continue;
      }
      if (candidate) {
        latest = candidate;
        break;
      }
    }

    // No reading found is only "no quota" when nothing was skipped; otherwise
    // the reading may sit in what could not be read.
    const [firstSkipped] = skippedFailures;
    if (!latest && firstSkipped) {
      return yield* Effect.fail(firstSkipped);
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
