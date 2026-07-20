import fs from 'node:fs';
import path from 'node:path';
import { approxCost, priceFor } from '@ai-usage/report-core/pricing';
import { normalizeCodexRateLimitStatus, type ProviderStatus } from '@ai-usage/report-core/provider-status';
import type {
  LocalSessionAnalysis,
  SessionDetail,
  SessionDetailPhase,
  SessionDetailPrompt,
  SessionDetailTokenCounts,
  SessionDetailTurn,
  SessionProjectionFacts,
} from '@ai-usage/report-core/session-detail';
import type { UsageModelSegment } from '@ai-usage/report-core/types';
import { actualCost, approximateApiCost, UNSEGMENTED_MULTI_MODEL_LABEL } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import type { CollectedSession } from './collected-session';
import type { LocalHistoryError } from './errors';
import { SMALL_HISTORY_JSON_MAX_BYTES } from './history-budgets';
import {
  historyPath,
  type LocalHistoryDatabase,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
  walkFiles,
} from './local-history';
import { parseNonNegativeSafeInteger } from './metric-validation';
import { withPerfSpan } from './perf';
import { firstExisting, resolvePaths } from './platform-paths';
import { base, safeJSON, usablePrompt } from './text';

interface CodexSession {
  activeDurationMs: number | null;
  agentNickname: string | null;
  cwd: string | null;
  durationPartial: boolean;
  end: Date | null;
  firstUser: string | null;
  hasTokenUsage: boolean;
  id: string | null;
  maxTotal: number;
  model: string;
  models: string[];
  observedPriorTokenUsage: boolean;
  parent: string | null;
  phases: CodexSessionPhase[];
  rejectedMetricRecords: number;
  reportPartial: boolean;
  source: string | null;
  start: Date | null;
  subscription: boolean;
  tcr: number;
  threadSource: string | null;
  tin: number;
  tools: number;
  tout: number;
  turns: number;
}

interface CodexSessionPhase {
  effort: string | null;
  end: Date;
  model: string;
  start: Date;
  tcr: number;
  tin: number;
  tout: number;
}

interface CodexTaskInterval {
  endMs: number;
  startMs: number;
}

interface CodexThreadMetadata {
  agentNickname: string | null;
  cwd: string | null;
  end: Date | null;
  firstUser: string | null;
  id: string;
  model: string | null;
  parent: string | null;
  source: string | null;
  start: Date | null;
  threadSource: string | null;
  title: string | null;
}

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

interface CodexSessionParseResult {
  lines: number;
  parsedLines: number;
  parseMs: number;
  rejectedMetricRecords: number;
  session: CodexSession;
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
// unchanged rollout could produce different counters, lineage, phases, or turns.
const CODEX_SESSION_CACHE_VERSION = 14;
const CODEX_DETAIL_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const CODEX_LINEAGE_MAX_DEPTH = 32;
const CODEX_DETAIL_MAX_LINE_BYTES = 8 * 1024 * 1024;
const CODEX_DETAIL_MAX_PHASES = 256;
const CODEX_DETAIL_MAX_PROMPTS = 256;
const CODEX_DETAIL_MAX_PROMPT_BYTES = 32 * 1024;
const CODEX_DETAIL_MAX_PROMPT_TOTAL_BYTES = 1024 * 1024;
const CODEX_DETAIL_MAX_TURNS = 1024;
const CODEX_DETAIL_DUPLICATE_PROMPT_WINDOW_MS = 1000;
// Forked rollouts stamp copied task events at replay time while preserving the
// task's original second-resolution `started_at`. Genuine task events observed
// in the rollout may also be delivered late. Only an event whose recorded start
// predates the observed rollout can be replayed history; tolerate two seconds of
// timestamp rounding around that boundary.
const CODEX_REPLAYED_TASK_EVENT_LAG_MS = 2000;
const SAFE_CODEX_SESSION_ID = /^[a-z\d][a-z\d-]{0,127}$/i;
const TRAILING_REPLACEMENT_CHARACTER = /\uFFFD$/u;

export const codexSessionsDir = (storage: LocalHistoryStorageService) => {
  const paths = resolvePaths(storage);
  return paths.codex.sessionsDir;
};

export const hasCodexHistory: Effect.Effect<boolean, LocalHistoryError, LocalHistoryStorageService> = Effect.gen(
  function* () {
    const storage = yield* LocalHistoryStorage;
    return yield* storage.exists(codexSessionsDir(storage));
  },
);

export const listCodexSessionFiles: Effect.Effect<string[], LocalHistoryError, LocalHistoryStorageService> =
  withPerfSpan(
    'aiUsage.collect.codex.listSessionFiles',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      return yield* walkFiles(storage, codexSessionsDir(storage), (fileName) => fileName.endsWith('.jsonl'));
    }),
    (files) => ({ files: files.length }),
  );

const readCodexThreadNames: Effect.Effect<
  Map<string, string>,
  LocalHistoryError,
  LocalHistoryStorageService
> = withPerfSpan(
  'aiUsage.collect.codex.threadNames',
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const paths = resolvePaths(storage);
    const names = new Map<string, string>();
    const indexPath = paths.codex.sessionIndexFile;
    if (!(yield* storage.exists(indexPath))) {
      return names;
    }

    yield* storage.readLines(
      indexPath,
      (line) => {
        const event = safeJSON(line);
        if (typeof event?.id === 'string' && typeof event.thread_name === 'string') {
          names.set(event.id, event.thread_name);
        }
      },
      { maxBytes: SMALL_HISTORY_JSON_MAX_BYTES },
    );
    return names;
  }),
  (names) => ({ names: names.size }),
);

const codexStateDbCandidates = (storage: LocalHistoryStorageService) => [
  historyPath(storage, '.codex', 'state_5.sqlite'),
  historyPath(storage, '.codex', 'sqlite', 'state_5.sqlite'),
];

const THREAD_METADATA_SQL = `
select
  id,
  cwd,
  title,
  first_user_message as firstUser,
  source,
  thread_source as threadSource,
  model,
  created_at as createdAt,
  updated_at as updatedAt
from threads
`;

const THREAD_SPAWN_EDGES_SQL = `
select parent_thread_id as parent, child_thread_id as child
from thread_spawn_edges
`;

const THREAD_METADATA_FOR_ID_SQL = `${THREAD_METADATA_SQL.trim()}
where id = ?
limit 2`;

const THREAD_PARENT_FOR_CHILD_SQL = `select distinct
  parent_thread_id as parent,
  child_thread_id as child
from thread_spawn_edges
where child_thread_id = ?
limit 2`;

interface CodexThreadMetadataRow {
  createdAt?: number | null;
  cwd?: string | null;
  firstUser?: string | null;
  id: string;
  model?: string | null;
  source?: string | null;
  threadSource?: string | null;
  title?: string | null;
  updatedAt?: number | null;
}

interface CodexThreadSpawnEdgeRow {
  child?: string | null;
  parent?: string | null;
}

const codexParentsFromEdges = (edges: readonly CodexThreadSpawnEdgeRow[]): Map<string, string> => {
  const candidates = new Map<string, Set<string>>();
  for (const edge of edges) {
    const child = nonEmpty(edge.child);
    const parent = nonEmpty(edge.parent);
    if (!(child && parent)) {
      continue;
    }
    const parents = candidates.get(child) ?? new Set<string>();
    parents.add(parent);
    candidates.set(child, parents);
  }

  const parents = new Map<string, string>();
  for (const [child, parentCandidates] of candidates) {
    if (parentCandidates.size === 1) {
      const parent = parentCandidates.values().next().value;
      if (parent) {
        parents.set(child, parent);
      }
    }
  }
  return parents;
};

const unixDate = (seconds: unknown): Date | null => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
};

const nonEmpty = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const agentNicknameFromSource = (source: string | null | undefined): string | null => {
  if (!source) {
    return null;
  }
  const spawn = threadSpawnFromSource(safeJSON(source));
  return nonEmpty(spawn?.agent_nickname) ?? nonEmpty(spawn?.agent_role);
};

const codexThreadMetadataFromRow = (row: CodexThreadMetadataRow, parent: string | null): CodexThreadMetadata | null => {
  const id = nonEmpty(row.id);
  if (!id) {
    return null;
  }
  return {
    id,
    parent,
    cwd: nonEmpty(row.cwd),
    title: nonEmpty(row.title),
    firstUser: nonEmpty(row.firstUser),
    source: nonEmpty(row.source),
    threadSource: nonEmpty(row.threadSource),
    agentNickname: agentNicknameFromSource(row.source),
    model: nonEmpty(row.model),
    start: unixDate(row.createdAt),
    end: unixDate(row.updatedAt),
  };
};

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

const readCodexThreadMetadataForSession = (
  database: LocalHistoryDatabase,
  sourceSessionId: string,
): Effect.Effect<CodexThreadMetadata | null> =>
  Effect.gen(function* () {
    const rows = yield* database.all<CodexThreadMetadataRow>(THREAD_METADATA_FOR_ID_SQL, [sourceSessionId]);
    const row = rows[0];
    if (rows.length !== 1 || !row) {
      return null;
    }
    const edges = yield* database.all<CodexThreadSpawnEdgeRow>(THREAD_PARENT_FOR_CHILD_SQL, [sourceSessionId]);
    const parent = codexParentsFromEdges(edges).get(sourceSessionId) ?? null;
    return codexThreadMetadataFromRow(row, parent);
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));

const emptySession = (): CodexSession => ({
  activeDurationMs: null,
  id: null,
  parent: null,
  durationPartial: false,
  reportPartial: false,
  observedPriorTokenUsage: false,
  rejectedMetricRecords: 0,
  start: null,
  end: null,
  cwd: null,
  model: 'codex',
  models: [],
  phases: [],
  source: null,
  threadSource: null,
  agentNickname: null,
  subscription: false,
  firstUser: null,
  turns: 0,
  tools: 0,
  maxTotal: 0,
  tin: 0,
  tcr: 0,
  tout: 0,
  hasTokenUsage: false,
});

const cloneCodexSession = (session: CodexSession): CodexSession => ({
  ...session,
  end: session.end ? new Date(session.end) : null,
  models: [...session.models],
  phases: session.phases.map((phase) => ({
    ...phase,
    end: new Date(phase.end),
    start: new Date(phase.start),
  })),
  start: session.start ? new Date(session.start) : null,
});

const emptyDetailTokens = (): SessionDetailTokenCounts => ({
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  total: 0,
});

const addDetailTokens = (target: SessionDetailTokenCounts, delta: SessionDetailTokenCounts): void => {
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.input += delta.input;
  target.output += delta.output;
  target.total += delta.total;
};

const phaseTokenTotal = (phase: CodexSessionPhase): number => phase.tin + phase.tcr + phase.tout;

const dominantCodexModel = (session: CodexSession): string => {
  const totals = new Map<string, number>();
  for (const phase of session.phases) {
    totals.set(phase.model, (totals.get(phase.model) ?? 0) + phaseTokenTotal(phase));
  }
  let dominantModel = session.models[0] ?? session.model;
  let dominantTokens = -1;
  for (const model of session.models) {
    const tokens = totals.get(model) ?? 0;
    if (tokens > dominantTokens) {
      dominantModel = model;
      dominantTokens = tokens;
    }
  }
  return dominantModel;
};

const mergedIntervalDurationMs = (intervals: CodexTaskInterval[]): number => {
  const sortedIntervals = [...intervals].sort((left, right) => left.startMs - right.startMs);
  let mergedEndMs: number | null = null;
  let mergedStartMs: number | null = null;
  let totalMs = 0;
  for (const interval of sortedIntervals) {
    if (mergedStartMs === null || mergedEndMs === null) {
      mergedStartMs = interval.startMs;
      mergedEndMs = interval.endMs;
      continue;
    }
    if (interval.startMs <= mergedEndMs) {
      mergedEndMs = Math.max(mergedEndMs, interval.endMs);
      continue;
    }
    totalMs += mergedEndMs - mergedStartMs;
    mergedStartMs = interval.startMs;
    mergedEndMs = interval.endMs;
  }
  if (mergedStartMs !== null && mergedEndMs !== null) {
    totalMs += mergedEndMs - mergedStartMs;
  }
  return totalMs;
};

const textFromContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const text = nonEmpty(record.text) ?? nonEmpty(record.input_text);
    if (text) {
      return text;
    }
  }
  return null;
};

const userTextFromPayload = (payload: Record<string, unknown>): string | null => {
  if (payload.type === 'message' && payload.role === 'user') {
    return textFromContent(payload.content);
  }
  if (payload.type === 'user_message') {
    return nonEmpty(payload.message) ?? nonEmpty(payload.text) ?? textFromContent(payload.content);
  }
  return null;
};

const codexLinePrefix = (line: string) => (line.length > 300 ? line.slice(0, 300) : line);

const isCodexToolCallPrefix = (prefix: string) =>
  prefix.includes('"type":"function_call"') ||
  prefix.includes('"type":"custom_tool_call"') ||
  prefix.includes('"type":"web_search_call"') ||
  prefix.includes('"type":"tool_search_call"');

const shouldParseCodexPrefix = (prefix: string) =>
  prefix.includes('token_count') ||
  prefix.includes('session_meta') ||
  prefix.includes('turn_context') ||
  prefix.includes('task_started') ||
  prefix.includes('task_complete') ||
  prefix.includes('turn_aborted') ||
  prefix.includes('user_message') ||
  prefix.includes('"role":"user"') ||
  prefix.includes('"role": "user"');

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
      !(activeDuration === null || activeDuration.ok) ||
      models === null ||
      models.length !== rawModels?.length ||
      phases === null
    ) {
      return null;
    }
    const [turns, tools, maxTotal, tin, tcr, tout, rejectedMetricRecords] = counters;
    if (!(turns?.ok && tools?.ok && maxTotal?.ok && tin?.ok && tcr?.ok && tout?.ok && rejectedMetricRecords?.ok)) {
      return null;
    }
    return {
      activeDurationMs: activeDuration?.value ?? null,
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
      source: typeof value.source === 'string' ? value.source : null,
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
    };
  } catch {
    return null;
  }
};

const loadCodexSessionCache = async (storage: LocalHistoryStorageService) => {
  if (!fs.existsSync(codexSessionsDir(storage))) {
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

interface MutableCodexTask {
  canonicalPromptSeen: boolean;
  effort: string | null;
  hasContext: boolean;
  lastPromptAt: Date | null;
  lastPromptNormalized: string | null;
  model: string;
  observedEnd: Date;
  pendingResponsePrompt: { at: Date; text: string } | null;
  promptIds: string[];
  replayed: boolean;
  start: Date;
  tokens: SessionDetailTokenCounts;
  tools: number;
  turnId: string;
}

interface CodexTokenSnapshot {
  cacheRead: number;
  input: number;
  output: number;
  total: number;
}

type CodexUsageOwnership = 'root' | 'session' | 'unknown';

const truncatePrompt = (text: string, maximumBytes: number): { text: string; truncated: boolean } => {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= maximumBytes) {
    return { text, truncated: false };
  }
  return {
    text: encoded.subarray(0, maximumBytes).toString('utf8').replace(TRAILING_REPLACEMENT_CHARACTER, ''),
    truncated: true,
  };
};

const createCodexSessionParser = (captureDetail = false) => {
  const session = emptySession();
  const completedTasks: (MutableCodexTask & { durationMs: number; end: Date })[] = [];
  const observedTaskIntervals: CodexTaskInterval[] = [];
  const openTasks = new Map<string, MutableCodexTask>();
  const prompts: SessionDetailPrompt[] = [];
  let lines = 0;
  let parsedLines = 0;
  let skippedLines = 0;
  let currentEffort: string | null = null;
  let currentModel = 'codex';
  let hasContextualTokenSnapshot = false;
  let legacyMaxTokens: CodexTokenSnapshot | null = null;
  let previousTokens: CodexTokenSnapshot | null = null;
  let promptBytes = 0;
  let promptsTruncated = false;
  let taskObservedEnd: Date | null = null;
  let taskObservedStart: Date | null = null;
  let finalized = false;
  let timingPartial = false;
  const parseStartedAt = Date.now();

  const latestOpenTask = (): MutableCodexTask | null => {
    let latest: MutableCodexTask | null = null;
    for (const task of openTasks.values()) {
      if (!task.replayed) {
        latest = task;
      }
    }
    return latest;
  };

  const observeTask = (task: MutableCodexTask, at: Date): void => {
    if (at > task.observedEnd) {
      task.observedEnd = at;
    }
  };

  const addModel = (model: string): void => {
    if (!(session.models.includes(model) || session.models.length >= CODEX_DETAIL_MAX_PHASES)) {
      session.models.push(model);
    }
  };

  const ensurePhase = (at: Date): CodexSessionPhase | null => {
    const last = session.phases.at(-1);
    if (last?.model === currentModel && last.effort === currentEffort) {
      if (at > last.end) {
        last.end = at;
      }
      return last;
    }
    if (session.phases.length >= CODEX_DETAIL_MAX_PHASES) {
      return last ?? null;
    }
    if (last && at > last.end) {
      last.end = at;
    }
    const phaseStart = latestOpenTask()?.start ?? at;
    const phase = {
      effort: currentEffort,
      end: at < phaseStart ? phaseStart : at,
      model: currentModel,
      start: phaseStart,
      tcr: 0,
      tin: 0,
      tout: 0,
    };
    session.phases.push(phase);
    return phase;
  };

  const appendPrompt = (task: MutableCodexTask, text: string, at: Date): void => {
    const normalized = usablePrompt(text);
    if (!normalized) {
      return;
    }
    if (!session.firstUser) {
      session.firstUser = normalized.slice(0, 200);
    }
    if (!captureDetail) {
      return;
    }
    const adjacentDuplicate =
      normalized === task.lastPromptNormalized &&
      task.lastPromptAt !== null &&
      Math.abs(at.getTime() - task.lastPromptAt.getTime()) <= CODEX_DETAIL_DUPLICATE_PROMPT_WINDOW_MS;
    if (adjacentDuplicate) {
      task.lastPromptAt = at;
      return;
    }
    task.lastPromptAt = at;
    task.lastPromptNormalized = normalized;
    if (prompts.length >= CODEX_DETAIL_MAX_PROMPTS) {
      promptsTruncated = true;
      return;
    }
    const remainingBytes = CODEX_DETAIL_MAX_PROMPT_TOTAL_BYTES - promptBytes;
    if (remainingBytes <= 0) {
      promptsTruncated = true;
      return;
    }
    const maximumBytes = Math.min(CODEX_DETAIL_MAX_PROMPT_BYTES, remainingBytes);
    const bounded = truncatePrompt(text.trim(), maximumBytes);
    if (!bounded.text) {
      promptsTruncated = true;
      return;
    }
    if (Buffer.byteLength(text.trim(), 'utf8') > remainingBytes) {
      promptsTruncated = true;
    }
    const prompt = {
      id: `prompt-${prompts.length + 1}`,
      text: bounded.text,
      timestamp: at.toISOString(),
      truncated: bounded.truncated,
    };
    prompts.push(prompt);
    promptBytes += Buffer.byteLength(prompt.text, 'utf8');
    task.promptIds.push(prompt.id);
  };

  const recordPrompt = (task: MutableCodexTask | null, text: string, at: Date, canonical: boolean): void => {
    if (!task?.hasContext) {
      return;
    }
    observeTask(task, at);
    if (!canonical) {
      task.pendingResponsePrompt = { at, text };
      return;
    }
    task.canonicalPromptSeen = true;
    task.pendingResponsePrompt = null;
    appendPrompt(task, text, at);
  };

  const flushResponsePrompt = (task: MutableCodexTask): void => {
    if (!(task.canonicalPromptSeen || !task.pendingResponsePrompt)) {
      const pendingPrompt = task.pendingResponsePrompt;
      task.pendingResponsePrompt = null;
      appendPrompt(task, pendingPrompt.text, pendingPrompt.at);
    }
  };

  const tokenSnapshotFrom = (value: unknown): CodexTokenSnapshot | null => {
    if (!isRecord(value)) {
      return null;
    }
    const total = parseNonNegativeSafeInteger(value.total_tokens);
    const input = parseNonNegativeSafeInteger(value.input_tokens);
    const cacheRead = parseNonNegativeSafeInteger(value.cached_input_tokens);
    const output = parseNonNegativeSafeInteger(value.output_tokens);
    if (!(total.ok && input.ok && cacheRead.ok && output.ok) || cacheRead.value > input.value) {
      return null;
    }
    return { cacheRead: cacheRead.value, input: input.value, output: output.value, total: total.value };
  };

  const detailDelta = (current: CodexTokenSnapshot, baseline: CodexTokenSnapshot): SessionDetailTokenCounts => ({
    cacheRead: current.cacheRead - baseline.cacheRead,
    cacheWrite: 0,
    input: current.input - current.cacheRead - (baseline.input - baseline.cacheRead),
    output: current.output - baseline.output,
    total: current.input - baseline.input + (current.output - baseline.output),
  });

  const recordTokenDelta = (delta: SessionDetailTokenCounts, at: Date, task: MutableCodexTask): void => {
    if (delta.input < 0 || delta.cacheRead < 0 || delta.output < 0 || delta.total < 0) {
      session.rejectedMetricRecords++;
      return;
    }
    if (delta.total !== delta.input + delta.cacheRead + delta.output) {
      session.rejectedMetricRecords++;
      return;
    }
    session.tin += delta.input;
    session.tcr += delta.cacheRead;
    session.tout += delta.output;
    const phase = ensurePhase(at);
    if (phase) {
      phase.tin += delta.input;
      phase.tcr += delta.cacheRead;
      phase.tout += delta.output;
    }
    addDetailTokens(task.tokens, delta);
  };

  const recordTokens = (payload: Record<string, unknown>, at: Date): void => {
    const hasRateLimits = isRecord(payload.rate_limits);
    if (hasRateLimits) {
      session.subscription = true;
    }
    if (payload.info === null && hasRateLimits) {
      return;
    }
    const info = isRecord(payload.info) ? payload.info : null;
    const snapshot = tokenSnapshotFrom(isRecord(info?.total_token_usage) ? info.total_token_usage : null);
    if (!snapshot) {
      session.rejectedMetricRecords++;
      return;
    }
    const lastUsage = tokenSnapshotFrom(isRecord(info?.last_token_usage) ? info.last_token_usage : null);
    if (lastUsage && snapshot.total > lastUsage.total) {
      session.observedPriorTokenUsage = true;
    }
    session.hasTokenUsage = true;
    session.maxTotal = Math.max(session.maxTotal, snapshot.total);
    if (!legacyMaxTokens || snapshot.total > legacyMaxTokens.total) {
      legacyMaxTokens = snapshot;
    }
    const task = latestOpenTask();
    const contextualTask = task?.hasContext ? task : null;
    if (contextualTask) {
      observeTask(contextualTask, at);
      hasContextualTokenSnapshot = true;
    }
    if (!previousTokens) {
      previousTokens = snapshot;
      if (contextualTask) {
        const zero = { cacheRead: 0, input: 0, output: 0, total: 0 };
        recordTokenDelta(
          lastUsage && snapshot.total > lastUsage.total ? detailDelta(lastUsage, zero) : detailDelta(snapshot, zero),
          at,
          contextualTask,
        );
      }
      return;
    }
    const nonMonotonic =
      snapshot.total < previousTokens.total ||
      snapshot.input < previousTokens.input ||
      snapshot.cacheRead < previousTokens.cacheRead ||
      snapshot.output < previousTokens.output;
    if (nonMonotonic) {
      session.rejectedMetricRecords++;
      previousTokens = snapshot;
      if (lastUsage && contextualTask) {
        recordTokenDelta(detailDelta(lastUsage, { cacheRead: 0, input: 0, output: 0, total: 0 }), at, contextualTask);
      }
      return;
    }
    const delta = detailDelta(snapshot, previousTokens);
    previousTokens = snapshot;
    if (contextualTask) {
      recordTokenDelta(delta, at, contextualTask);
    }
  };

  const visit = (line: string): void => {
    if (!line) {
      return;
    }
    lines++;
    const prefix = codexLinePrefix(line);
    if (!(shouldParseCodexPrefix(prefix) || isCodexToolCallPrefix(prefix))) {
      skippedLines++;
      return;
    }
    parsedLines++;
    const event = safeJSON(line);
    if (!event) {
      return;
    }
    const timestamp =
      typeof event.timestamp === 'string' || typeof event.timestamp === 'number' ? event.timestamp : Number.NaN;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
      return;
    }
    if (!session.start || date < session.start) {
      session.start = date;
    }
    if (!session.end || date > session.end) {
      session.end = date;
    }

    const payload = isRecord(event.payload) ? event.payload : {};
    if (isCodexToolCallPrefix(prefix)) {
      const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough
        : null;
      const turnId = nonEmpty(metadata?.turn_id);
      const task = turnId ? (openTasks.get(turnId) ?? null) : latestOpenTask();
      if (task?.hasContext) {
        observeTask(task, date);
        session.tools++;
        task.tools++;
      }
    }
    if (event.type === 'session_meta' && !session.id) {
      session.id = typeof payload.id === 'string' ? payload.id : session.id;
      session.cwd = typeof payload.cwd === 'string' ? payload.cwd : session.cwd;
      session.source = payload.source == null ? session.source : JSON.stringify(payload.source);
      session.threadSource = typeof payload.thread_source === 'string' ? payload.thread_source : session.threadSource;
      const spawn = threadSpawnFromSource(payload.source);
      if (spawn) {
        session.parent = typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id : session.parent;
        session.agentNickname = nonEmpty(spawn.agent_nickname) ?? nonEmpty(spawn.agent_role) ?? session.agentNickname;
      }
    }
    if (event.type === 'turn_context' && typeof payload.model === 'string') {
      const turnId = nonEmpty(payload.turn_id);
      const task = turnId ? (openTasks.get(turnId) ?? null) : latestOpenTask();
      if (task && !task.replayed) {
        currentModel = payload.model;
        currentEffort = nonEmpty(payload.effort) ?? nonEmpty(payload.reasoning_effort);
        addModel(currentModel);
        if (!task.hasContext) {
          task.hasContext = true;
          session.turns++;
          if (!taskObservedStart || task.start < taskObservedStart) {
            taskObservedStart = task.start;
          }
        }
        observeTask(task, date);
        task.model = currentModel;
        task.effort = currentEffort;
        ensurePhase(date);
      }
    }
    const userText = userTextFromPayload(payload);
    if (userText) {
      const canonical = payload.type === 'user_message';
      const promptMetadata = isRecord(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough
        : null;
      const promptTurnId = nonEmpty(promptMetadata?.turn_id);
      const promptTask = promptTurnId ? (openTasks.get(promptTurnId) ?? null) : latestOpenTask();
      recordPrompt(promptTask, userText, date, canonical);
    }
    if (payload.type === 'task_started') {
      const turnId = nonEmpty(payload.turn_id) ?? `turn-${lines}`;
      const recordedTaskStart = unixDate(payload.started_at);
      const taskStart = recordedTaskStart ?? date;
      const recordedStartPredatesRollout = Boolean(
        recordedTaskStart && session.start && recordedTaskStart < session.start,
      );
      const replayed = Boolean(
        recordedTaskStart &&
          recordedStartPredatesRollout &&
          date.getTime() - recordedTaskStart.getTime() > CODEX_REPLAYED_TASK_EVENT_LAG_MS,
      );
      const hasReplayLineage = session.parent !== null || session.threadSource === 'subagent';
      if (replayed && !hasReplayLineage) {
        session.durationPartial = true;
        session.reportPartial = true;
      }
      if (!(openTasks.has(turnId) || openTasks.size < CODEX_DETAIL_MAX_TURNS)) {
        const oldestUnanchored = [...openTasks].find(([, task]) => !task.hasContext)?.[0];
        if (!oldestUnanchored) {
          return;
        }
        openTasks.delete(oldestUnanchored);
      }
      openTasks.set(turnId, {
        canonicalPromptSeen: false,
        effort: currentEffort,
        hasContext: false,
        lastPromptAt: null,
        lastPromptNormalized: null,
        model: currentModel,
        observedEnd: date < taskStart ? taskStart : date,
        pendingResponsePrompt: null,
        promptIds: [],
        replayed,
        start: taskStart,
        tokens: emptyDetailTokens(),
        tools: 0,
        turnId,
      });
    }
    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      const turnId = nonEmpty(payload.turn_id);
      const task = turnId ? (openTasks.get(turnId) ?? null) : latestOpenTask();
      const taskEnd = unixDate(payload.completed_at) ?? date;
      if (task && taskEnd >= task.start) {
        openTasks.delete(task.turnId);
        if (task.hasContext) {
          flushResponsePrompt(task);
          const parsedDuration = parseNonNegativeSafeInteger(payload.duration_ms);
          const recordedDurationMs = parsedDuration.ok
            ? parsedDuration.value
            : taskEnd.getTime() - task.start.getTime();
          const turnEnd = new Date(Math.min(taskEnd.getTime(), task.start.getTime() + recordedDurationMs));
          const durationMs = turnEnd.getTime() - task.start.getTime();
          observedTaskIntervals.push({
            endMs: turnEnd.getTime(),
            startMs: task.start.getTime(),
          });
          if (captureDetail && completedTasks.length < CODEX_DETAIL_MAX_TURNS) {
            completedTasks.push({ ...task, durationMs, end: turnEnd });
          }
          taskObservedEnd = !taskObservedEnd || taskEnd > taskObservedEnd ? taskEnd : taskObservedEnd;
          ensurePhase(taskEnd);
        }
      }
    }
    if (payload.type === 'token_count') {
      recordTokens(payload, date);
    }
  };

  const finalize = (): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    if (!hasContextualTokenSnapshot && legacyMaxTokens) {
      session.tin = legacyMaxTokens.input - legacyMaxTokens.cacheRead;
      session.tcr = legacyMaxTokens.cacheRead;
      session.tout = legacyMaxTokens.output;
    }
    if (session.models.length === 0) {
      addModel(currentModel);
    }
    for (const task of openTasks.values()) {
      if (!(task.hasContext && !task.replayed)) {
        continue;
      }
      session.durationPartial = true;
      session.reportPartial = true;
      timingPartial = true;
      flushResponsePrompt(task);
      observedTaskIntervals.push({
        endMs: task.observedEnd.getTime(),
        startMs: task.start.getTime(),
      });
      if (!taskObservedEnd || task.observedEnd > taskObservedEnd) {
        taskObservedEnd = task.observedEnd;
      }
    }
    if (taskObservedStart) {
      session.start = taskObservedStart;
    }
    if (taskObservedEnd) {
      session.end = taskObservedEnd;
    }
    session.model = dominantCodexModel(session);
    session.activeDurationMs = mergedIntervalDurationMs(observedTaskIntervals);
  };

  const detailPhases = (): SessionDetailPhase[] => {
    const sessionStart = session.start;
    const sessionEnd = session.end;
    if (!(sessionStart && sessionEnd)) {
      return [];
    }
    return session.phases.flatMap((phase) => {
      const start = phase.start < sessionStart ? sessionStart : phase.start;
      const end = phase.end > sessionEnd ? sessionEnd : phase.end;
      if (end < start) {
        return [];
      }
      const tokens = {
        cacheRead: phase.tcr,
        cacheWrite: 0,
        input: phase.tin,
        output: phase.tout,
        total: phaseTokenTotal(phase),
      };
      const pricing = priceFor(phase.model, { at: end });
      return [
        {
          cost: pricing.known
            ? approxCost(pricing.rates, { cr: phase.tcr, cw: 0, in: phase.tin, out: phase.tout })
            : null,
          costKind: pricing.known ? ('approximate' as const) : ('unknown' as const),
          effort: phase.effort,
          effortKind: phase.effort ? ('recorded' as const) : ('default' as const),
          endAt: end.toISOString(),
          model: phase.model,
          startAt: start.toISOString(),
          tokens,
        },
      ];
    });
  };

  const detailTurns = (): SessionDetailTurn[] => {
    const tasks = [...completedTasks];
    for (const task of openTasks.values()) {
      if (task.hasContext && !task.replayed) {
        tasks.push({
          ...task,
          durationMs: task.observedEnd.getTime() - task.start.getTime(),
          end: task.observedEnd,
        });
      }
    }
    tasks.sort((left, right) => left.start.getTime() - right.start.getTime());
    return tasks.slice(0, CODEX_DETAIL_MAX_TURNS).map((task, index) => ({
      durationMs: task.durationMs,
      effort: task.effort,
      effortKind: task.effort ? ('recorded' as const) : ('default' as const),
      endAt: task.end.toISOString(),
      index,
      intervals: [{ endAt: task.end.toISOString(), startAt: task.start.toISOString() }],
      model: task.model === 'codex' ? session.model : task.model,
      promptIds: task.promptIds,
      startAt: task.start.toISOString(),
      timingStatus: 'recorded',
      tokens: task.tokens,
      tools: task.tools,
    }));
  };

  const detail = (): SessionDetail | null => {
    if (!(captureDetail && session.id && session.start && session.end)) {
      return null;
    }
    const activeDurationMs = session.activeDurationMs ?? 0;
    const elapsedDurationMs = session.end.getTime() - session.start.getTime();
    const turns = detailTurns();
    return {
      activeDurationMs,
      durationStatus: timingPartial ? 'partial' : 'recorded',
      efforts: [...new Set(session.phases.flatMap((phase) => (phase.effort ? [phase.effort] : [])))],
      elapsedDurationMs,
      endedAt: session.end.toISOString(),
      idleDurationMs: Math.max(0, elapsedDurationMs - activeDurationMs),
      models: session.models,
      observedAt: new Date().toISOString(),
      phases: detailPhases(),
      prompts,
      promptsTruncated,
      sourceSessionId: session.id,
      startedAt: session.start.toISOString(),
      turns,
      turnsStatus: 'recorded',
    };
  };

  const analysis = (usageOwnership: CodexUsageOwnership = 'session'): LocalSessionAnalysis | null => {
    const parsedDetail = detail();
    if (!parsedDetail) {
      return null;
    }
    return {
      detail: parsedDetail,
      projection: codexProjectionFacts(session, usageOwnership),
    };
  };

  return {
    analysis,
    detail,
    finish: (): CodexSessionParseResult => {
      finalize();
      return {
        lines,
        parseMs: Date.now() - parseStartedAt,
        parsedLines,
        rejectedMetricRecords: session.rejectedMetricRecords,
        session,
        skippedLines,
      };
    },
    visit,
  };
};

const removeSelfParent = (session: CodexSession): CodexSession => {
  if (session.id && session.parent === session.id) {
    session.parent = null;
  }
  return session;
};

const mergeMetadata = (session: CodexSession, metadata: CodexThreadMetadata | undefined) => {
  if (!metadata) {
    return removeSelfParent(session);
  }
  session.parent = session.parent ?? metadata.parent;
  session.start = session.start ?? metadata.start;
  session.end = session.end ?? metadata.end;
  session.cwd = session.cwd ?? metadata.cwd;
  if (session.model === 'codex' && metadata.model) {
    session.model = metadata.model;
    session.models = session.models.map((model) => (model === 'codex' ? (metadata.model ?? model) : model));
    for (const phase of session.phases) {
      if (phase.model === 'codex') {
        phase.model = metadata.model;
      }
    }
  }
  session.source = session.source ?? metadata.source;
  session.threadSource = session.threadSource ?? metadata.threadSource;
  session.agentNickname = session.agentNickname ?? metadata.agentNickname;
  session.firstUser = session.firstUser ?? (metadata.firstUser ? usablePrompt(metadata.firstUser.slice(0, 200)) : null);
  return removeSelfParent(session);
};

const isGuardianSession = (session: CodexSession, candidateName: string | null) =>
  session.source?.includes('"guardian"') || candidateName?.startsWith('The following is the Codex agent history');

const REVIEWED_CODEX_SESSION_ID = /Reviewed Codex session id:\s*([0-9a-f-]{36})/i;

const guardianName = (candidateName: string | null) => {
  const reviewedId = candidateName?.match(REVIEWED_CODEX_SESSION_ID)?.[1];
  return reviewedId ? `Codex guardian approval (${reviewedId.slice(0, 8)})` : 'Codex guardian approval';
};

const codexSessionName = (
  session: CodexSession,
  indexedName: string | undefined,
  metadata: CodexThreadMetadata | undefined,
) => {
  if (session.agentNickname) {
    return session.agentNickname;
  }
  if (indexedName) {
    return indexedName;
  }
  const candidate = metadata?.title || session.firstUser;
  if (isGuardianSession(session, candidate ?? null)) {
    return guardianName(candidate ?? null);
  }
  return candidate || (session.id ? `codex ${session.id.slice(0, 8)}` : 'codex');
};

const codexTitleSource = (
  session: CodexSession,
  indexedName: string | undefined,
  metadata: CodexThreadMetadata | undefined,
  isSubagent: boolean,
) => {
  if (isSubagent && session.agentNickname) {
    return 'agent-role';
  }
  const candidate = indexedName || metadata?.title || session.firstUser;
  return candidate ? 'first-prompt' : 'id';
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
      const files = yield* listCodexSessionFiles;
      const parsedForCache: { filePath: string; session: CodexSession; stat: CodexSessionFileStat }[] = [];

      yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const cacheReadStartedAt = Date.now();
          const sessionCache = fs.existsSync(codexSessionsDir(storage))
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
  rejectedMetricRecords: number;
  sessions: CollectedSession[];
}

const resolveCodexRootId = (session: CodexSession, sessionsById: ReadonlyMap<string, CodexSession>): string | null => {
  const sourceSessionId = session.id;
  if (!sourceSessionId) {
    return null;
  }

  let current = session;
  const seen = new Set<string>();
  let traversedEdges = 0;
  while (current.id) {
    if (seen.has(current.id)) {
      return sourceSessionId;
    }
    seen.add(current.id);
    if (!current.parent) {
      return current.id;
    }
    if (traversedEdges >= CODEX_LINEAGE_MAX_DEPTH) {
      return sourceSessionId;
    }
    const parent = sessionsById.get(current.parent);
    if (!parent) {
      return sourceSessionId;
    }
    current = parent;
    traversedEdges++;
  }
  return sourceSessionId;
};

const codexModelSegments = (session: CodexSession): UsageModelSegment[] => {
  const segments = new Map<string, UsageModelSegment>();
  const addSegment = (model: string, tokens: { cr: number; in: number; out: number }, at: Date | null): void => {
    const pricing = priceFor(model, { at });
    const tokenBearing = tokens.in + tokens.cr + tokens.out > 0;
    const current = segments.get(model) ?? {
      costApprox: 0,
      costKnown: true,
      model,
      tokCr: 0,
      tokCw: 0,
      tokIn: 0,
      tokOut: 0,
    };
    current.costApprox += approxCost(pricing.rates, { ...tokens, cw: 0 });
    current.costKnown = current.costKnown && (!tokenBearing || pricing.known);
    current.tokCr += tokens.cr;
    current.tokIn += tokens.in;
    current.tokOut += tokens.out;
    segments.set(model, current);
  };

  if (session.phases.length === 0) {
    addSegment(session.model, { cr: session.tcr, in: session.tin, out: session.tout }, session.end);
  } else {
    for (const phase of session.phases) {
      addSegment(phase.model, { cr: phase.tcr, in: phase.tin, out: phase.tout }, phase.end);
    }
    const phaseTotals = [...segments.values()].reduce(
      (totals, segment) => ({
        cr: totals.cr + segment.tokCr,
        in: totals.in + segment.tokIn,
        out: totals.out + segment.tokOut,
      }),
      { cr: 0, in: 0, out: 0 },
    );
    const phasesReconcile =
      phaseTotals.cr === session.tcr && phaseTotals.in === session.tin && phaseTotals.out === session.tout;
    if (!phasesReconcile) {
      // A cumulative snapshot observed outside a contextual task can only be
      // attributed when every model observation agrees. Otherwise keep the
      // aggregate intact in an explicit unsegmented lower-bound bucket.
      const observedModels = new Set([...session.models, ...session.phases.map((phase) => phase.model)]);
      if (observedModels.size === 0) {
        observedModels.add(session.model);
      }
      const fallbackModel = observedModels.size === 1 ? ([...observedModels][0] ?? session.model) : null;
      segments.clear();
      addSegment(
        fallbackModel ?? UNSEGMENTED_MULTI_MODEL_LABEL,
        { cr: session.tcr, in: session.tin, out: session.tout },
        session.end,
      );
    }
  }
  return [...segments.values()];
};

const projectionTokens = (tokens: { cr: number; cw: number; in: number; out: number }): SessionDetailTokenCounts => ({
  cacheRead: tokens.cr,
  cacheWrite: tokens.cw,
  input: tokens.in,
  output: tokens.out,
  total: tokens.cr + tokens.cw + tokens.in + tokens.out,
});

const codexProjectionFacts = (session: CodexSession, usageOwnership: CodexUsageOwnership): SessionProjectionFacts => {
  let modelSegments: SessionProjectionFacts['modelSegments'];
  if (usageOwnership === 'unknown') {
    modelSegments = null;
  } else if (usageOwnership === 'root') {
    modelSegments =
      session.models.length > 1
        ? null
        : [{ model: session.model, tokens: projectionTokens({ cr: 0, cw: 0, in: 0, out: 0 }) }];
  } else {
    modelSegments = codexModelSegments(session)
      .map((segment) => ({
        model: segment.model,
        tokens: projectionTokens({ cr: segment.tokCr, cw: segment.tokCw, in: segment.tokIn, out: segment.tokOut }),
      }))
      .sort((left, right) => left.model.localeCompare(right.model));
  }
  const usageUnavailable = usageOwnership !== 'session' || !session.hasTokenUsage;
  return {
    calls: 1,
    durationMs: session.activeDurationMs ?? 0,
    modelSegments,
    partial: session.reportPartial,
    tokens: usageUnavailable ? null : projectionTokens({ cr: session.tcr, cw: 0, in: session.tin, out: session.tout }),
    tools: session.tools,
    turns: session.turns,
  };
};

const isCodexUsageOwnedByRoot = (session: CodexSession, sessionsById: ReadonlyMap<string, CodexSession>): boolean => {
  if (!(session.id && session.parent && session.observedPriorTokenUsage)) {
    return false;
  }
  if (session.phases.some((phase) => phaseTokenTotal(phase) > 0)) {
    return false;
  }
  const rootId = resolveCodexRootId(session, sessionsById);
  const root = rootId ? sessionsById.get(rootId) : undefined;
  return Boolean(rootId && root && root.id !== session.id && root.hasTokenUsage && root.maxTotal >= session.maxTotal);
};

export const readCodexUsageSessionsResult: Effect.Effect<
  CodexUsageSessionsResult,
  LocalHistoryError,
  LocalHistoryStorageService
> = withPerfSpan(
  'aiUsage.collect.codex.usageSessions',
  Effect.gen(function* () {
    const names = yield* readCodexThreadNames;
    const metadata = yield* readCodexThreadMetadata;
    const { rejectedMetricRecords, sessions } = yield* readCodexSessions(metadata);
    const byId = new Map<string, CodexSession>();
    for (const session of sessions) {
      if (session.id) {
        byId.set(session.id, session);
      }
    }
    const children = new Map<string, CodexSession[]>();
    const childIds = new Set<string>();
    for (const session of sessions) {
      if (session.id && session.parent && byId.has(session.parent)) {
        childIds.add(session.id);
        const siblings = children.get(session.parent) ?? [];
        siblings.push(session);
        children.set(session.parent, siblings);
      }
    }

    const usageSessions: CollectedSession[] = [];
    for (const session of sessions) {
      const kids = (session.id && children.get(session.id)) || [];
      const meta = session.id ? metadata.get(session.id) : undefined;
      const tokens = {
        in: session.tin,
        out: session.tout,
        cr: session.tcr,
        cw: 0,
      };
      const isSubagent = (session.id ? childIds.has(session.id) : false) || session.threadSource === 'subagent';
      const parentSession = session.parent ? byId.get(session.parent) : undefined;
      const subscription = session.subscription || Boolean(parentSession?.subscription);
      const indexedName = session.id ? names.get(session.id) : undefined;
      const usageOwnedByRoot = isCodexUsageOwnedByRoot(session, byId);
      const modelSegments = codexModelSegments(session);
      const costApprox = modelSegments.reduce((total, segment) => total + segment.costApprox, 0);
      const costKnown = modelSegments.every((segment) => segment.costKnown);
      usageSessions.push({
        source: {
          harnessKey: 'codex',
          sourceSessionId: session.id,
          ...(session.parent === null ? {} : { parentSourceSessionId: session.parent }),
          sourcePath: session.cwd,
        },
        projectPath: session.cwd,
        date: session.start,
        endDate: session.end,
        provider: subscription ? 'Codex sub' : 'Codex API',
        model: session.model,
        ...(usageOwnedByRoot ? {} : { modelSegments }),
        models: session.models,
        name: codexSessionName(session, indexedName, meta),
        titleSource: codexTitleSource(session, indexedName, meta, isSubagent),
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

    return { rejectedMetricRecords, sessions: usageSessions };
  }),
  (result) => ({ rejectedMetricRecords: result.rejectedMetricRecords, sessions: result.sessions.length }),
);

export const readCodexUsageSessions: Effect.Effect<CollectedSession[], LocalHistoryError, LocalHistoryStorageService> =
  readCodexUsageSessionsResult.pipe(Effect.map((result) => result.sessions));

const indexCodexRolloutFiles = (files: readonly string[]): ReadonlyMap<string, readonly string[]> => {
  const filesBySessionId = new Map<string, string[]>();
  for (const filePath of files) {
    const fileName = path.basename(filePath);
    if (!fileName.endsWith('.jsonl')) {
      continue;
    }
    const stem = fileName.slice(0, -'.jsonl'.length);
    const candidates = [stem];
    for (let separator = stem.indexOf('-'); separator >= 0; separator = stem.indexOf('-', separator + 1)) {
      candidates.push(stem.slice(separator + 1));
    }
    for (const [index, candidate] of candidates.entries()) {
      if (!SAFE_CODEX_SESSION_ID.test(candidate)) {
        continue;
      }
      const candidateFiles = filesBySessionId.get(candidate) ?? [];
      if (candidateFiles.includes(filePath)) {
        continue;
      }
      if (index === 0) {
        candidateFiles.unshift(filePath);
      } else {
        candidateFiles.push(filePath);
      }
      filesBySessionId.set(candidate, candidateFiles);
    }
  }
  return filesBySessionId;
};

export const readCodexSessionAnalysis = (
  sourceSessionId: string,
): Effect.Effect<LocalSessionAnalysis | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    if (!SAFE_CODEX_SESSION_ID.test(sourceSessionId)) {
      return null;
    }
    const storage = yield* LocalHistoryStorage;
    const files = yield* listCodexSessionFiles;
    const filesBySessionId = indexCodexRolloutFiles(files);
    const readIndexedSession = (sessionId: string, captureDetail: boolean, maximumBytes: number) =>
      Effect.gen(function* () {
        let bytes = 0;
        for (const filePath of filesBySessionId.get(sessionId) ?? []) {
          const parser = createCodexSessionParser(captureDetail);
          const read = yield* storage.readLines(filePath, parser.visit, {
            maxBytes: Math.max(0, maximumBytes - bytes),
            maxLineBytes: CODEX_DETAIL_MAX_LINE_BYTES,
          });
          bytes += read.bytes;
          const session = parser.finish().session;
          if (session.id === sessionId) {
            return { bytes, parser, session } as const;
          }
        }
        return { bytes, parser: null, session: null } as const;
      });
    const targetRead = yield* readIndexedSession(sourceSessionId, true, CODEX_DETAIL_MAX_TOTAL_BYTES);
    if (!(targetRead.parser && targetRead.session)) {
      return null;
    }
    const parser = targetRead.parser;
    const parsedSession = targetRead.session;
    const initialRemainingBytes = Math.max(0, CODEX_DETAIL_MAX_TOTAL_BYTES - targetRead.bytes);
    const analyzeWithMetadata = (database: LocalHistoryDatabase | null) =>
      Effect.gen(function* () {
        let remainingBytes = initialRemainingBytes;
        const metadata = database ? yield* readCodexThreadMetadataForSession(database, sourceSessionId) : null;
        mergeMetadata(parsedSession, metadata ?? undefined);

        const sessionsById = new Map<string, CodexSession>([[sourceSessionId, parsedSession]]);
        const seen = new Set([sourceSessionId]);
        let lineageBudgetTruncated = false;
        let ancestorId = parsedSession.parent;
        for (let depth = 0; ancestorId && depth < CODEX_LINEAGE_MAX_DEPTH; depth += 1) {
          const currentAncestorId = ancestorId;
          if (seen.has(currentAncestorId)) {
            break;
          }
          seen.add(currentAncestorId);
          if (!filesBySessionId.has(currentAncestorId)) {
            break;
          }
          const ancestorRead = yield* readIndexedSession(currentAncestorId, false, remainingBytes).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catchAll(() => Effect.succeed({ ok: false as const })),
          );
          if (!ancestorRead.ok) {
            lineageBudgetTruncated = true;
            break;
          }
          remainingBytes = Math.max(0, remainingBytes - ancestorRead.result.bytes);
          const ancestor = ancestorRead.result.session;
          if (!ancestor) {
            break;
          }
          const ancestorMetadata = database
            ? yield* readCodexThreadMetadataForSession(database, currentAncestorId)
            : null;
          mergeMetadata(ancestor, ancestorMetadata ?? undefined);
          sessionsById.set(currentAncestorId, ancestor);
          ancestorId = ancestor.parent;
        }

        let usageOwnership: CodexUsageOwnership = 'session';
        if (lineageBudgetTruncated) {
          usageOwnership = 'unknown';
        } else if (isCodexUsageOwnedByRoot(parsedSession, sessionsById)) {
          usageOwnership = 'root';
        }
        return parser.analysis(usageOwnership);
      });

    const dbPath = yield* firstExisting(storage, ...codexStateDbCandidates(storage));
    if (!dbPath) {
      return yield* analyzeWithMetadata(null);
    }
    const database = yield* storage.openDatabase(dbPath).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (!database) {
      return yield* analyzeWithMetadata(null);
    }
    return yield* analyzeWithMetadata(database).pipe(Effect.ensuring(database.close));
  });

const findLatestRawCodexRateLimits = (
  recentFileLimit = 40,
): Effect.Effect<RawCodexRateLimitSnapshot | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    let latest: RawCodexRateLimitSnapshot | null = null;
    const files = (yield* listCodexSessionFiles).sort();

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const threadSpawnFromSource = (source: unknown): Record<string, unknown> | null => {
  if (!isRecord(source)) {
    return null;
  }
  const { subagent } = source;
  if (!isRecord(subagent)) {
    return null;
  }
  const threadSpawn = subagent.thread_spawn;
  return isRecord(threadSpawn) ? threadSpawn : null;
};

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
