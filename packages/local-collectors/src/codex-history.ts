import fs from 'node:fs';
import path from 'node:path';
import { normalizeCodexRateLimitStatus, type ProviderStatus } from '@ai-usage/report-core/provider-status';
import { actualCost, approximateApiCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import type { CollectedSession } from './collected-session';
import type { LocalHistoryError } from './errors';
import {
  historyPath,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
  walkFiles,
} from './local-history';
import { parseNonNegativeSafeInteger } from './metric-validation';
import { withPerfSpan } from './perf';
import { firstExisting, resolvePaths } from './platform-paths';
import { base, safeJSON, usablePrompt } from './text';

interface CodexSession {
  agentNickname: string | null;
  cwd: string | null;
  end: Date | null;
  firstUser: string | null;
  hasTokenUsage: boolean;
  id: string | null;
  maxTotal: number;
  model: string;
  parent: string | null;
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
  sessions: CodexSession[];
  skippedLines: number;
}

interface CodexSessionParseResult {
  lines: number;
  parsedLines: number;
  parseMs: number;
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

const CODEX_SESSION_CACHE_VERSION = 3;

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

    yield* storage.readLines(indexPath, (line) => {
      const event = safeJSON(line);
      if (typeof event?.id === 'string' && typeof event.thread_name === 'string') {
        names.set(event.id, event.thread_name);
      }
    });
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

          const parents = new Map<string, string>();
          for (const edge of edges) {
            const child = nonEmpty(edge.child);
            const parent = nonEmpty(edge.parent);
            if (child && parent) {
              parents.set(child, parent);
            }
          }

          const metadata = new Map<string, CodexThreadMetadata>();
          for (const row of rows) {
            const id = nonEmpty(row.id);
            if (!id) {
              continue;
            }
            metadata.set(id, {
              id,
              parent: parents.get(id) ?? null,
              cwd: nonEmpty(row.cwd),
              title: nonEmpty(row.title),
              firstUser: nonEmpty(row.firstUser),
              source: nonEmpty(row.source),
              threadSource: nonEmpty(row.threadSource),
              agentNickname: agentNicknameFromSource(row.source),
              model: nonEmpty(row.model),
              start: unixDate(row.createdAt),
              end: unixDate(row.updatedAt),
            });
          }

          return metadata;
        }),
      (db) => db.close,
    ).pipe(Effect.catchAll(() => Effect.succeed(new Map<string, CodexThreadMetadata>())));
  }),
  (metadata) => ({ rows: metadata.size }),
);

const emptySession = (): CodexSession => ({
  id: null,
  parent: null,
  start: null,
  end: null,
  cwd: null,
  model: 'codex',
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

const reviveCachedSession = (json: string): CodexSession | null => {
  try {
    const value = JSON.parse(json) as Partial<CodexSession>;
    return {
      id: typeof value.id === 'string' ? value.id : null,
      parent: typeof value.parent === 'string' ? value.parent : null,
      start: reviveDate(value.start),
      end: reviveDate(value.end),
      cwd: typeof value.cwd === 'string' ? value.cwd : null,
      model: typeof value.model === 'string' ? value.model : 'codex',
      source: typeof value.source === 'string' ? value.source : null,
      threadSource: typeof value.threadSource === 'string' ? value.threadSource : null,
      agentNickname: typeof value.agentNickname === 'string' ? value.agentNickname : null,
      subscription: value.subscription === true,
      firstUser: typeof value.firstUser === 'string' ? value.firstUser : null,
      turns: typeof value.turns === 'number' ? value.turns : 0,
      tools: typeof value.tools === 'number' ? value.tools : 0,
      maxTotal: typeof value.maxTotal === 'number' ? value.maxTotal : 0,
      tin: typeof value.tin === 'number' ? value.tin : 0,
      tcr: typeof value.tcr === 'number' ? value.tcr : 0,
      tout: typeof value.tout === 'number' ? value.tout : 0,
      hasTokenUsage: value.hasTokenUsage === true,
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

const createCodexSessionParser = () => {
  const session = emptySession();
  let lines = 0;
  let parsedLines = 0;
  let skippedLines = 0;
  const parseStartedAt = Date.now();

  const visit = (line: string): void => {
    if (!line) {
      return;
    }
    lines++;
    const prefix = codexLinePrefix(line);
    if (prefix.includes('"type":"task_started"')) {
      session.turns++;
    }
    if (isCodexToolCallPrefix(prefix)) {
      session.tools++;
    }
    if (!shouldParseCodexPrefix(prefix)) {
      skippedLines++;
      return;
    }
    parsedLines++;
    const event = safeJSON(line);
    if (!event) {
      return;
    }
    if (typeof event.timestamp === 'string' || typeof event.timestamp === 'number') {
      const date = new Date(event.timestamp);
      if (Number.isFinite(date.getTime())) {
        if (!session.start || date < session.start) {
          session.start = date;
        }
        if (!session.end || date > session.end) {
          session.end = date;
        }
      }
    }

    const payload = isRecord(event.payload) ? event.payload : {};
    if (event.type === 'session_meta') {
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
      session.model = payload.model;
    }
    const userText = userTextFromPayload(payload);
    if (userText && !session.firstUser) {
      session.firstUser = usablePrompt(userText.slice(0, 200));
    }
    if (payload.type === 'token_count') {
      if (payload.rate_limits) {
        session.subscription = true;
      }
      const info = isRecord(payload.info) ? payload.info : null;
      const usage = isRecord(info?.total_token_usage) ? info.total_token_usage : null;
      const total = parseNonNegativeSafeInteger(usage?.total_tokens);
      const input = parseNonNegativeSafeInteger(usage?.input_tokens);
      const cachedInput = parseNonNegativeSafeInteger(usage?.cached_input_tokens);
      const output = parseNonNegativeSafeInteger(usage?.output_tokens);
      if (
        usage &&
        total.ok &&
        input.ok &&
        cachedInput.ok &&
        output.ok &&
        cachedInput.value <= input.value &&
        total.value > session.maxTotal
      ) {
        session.hasTokenUsage = true;
        session.maxTotal = total.value;
        session.tin = input.value - cachedInput.value;
        session.tcr = cachedInput.value;
        session.tout = output.value;
      }
    }
  };

  return {
    finish: (): CodexSessionParseResult => ({
      lines,
      parseMs: Date.now() - parseStartedAt,
      parsedLines,
      session,
      skippedLines,
    }),
    visit,
  };
};

const mergeMetadata = (session: CodexSession, metadata: CodexThreadMetadata | undefined) => {
  if (!metadata) {
    return session;
  }
  session.parent = session.parent ?? metadata.parent;
  session.start = session.start ?? metadata.start;
  session.end = session.end ?? metadata.end;
  session.cwd = session.cwd ?? metadata.cwd;
  session.model = session.model === 'codex' && metadata.model ? metadata.model : session.model;
  session.source = session.source ?? metadata.source;
  session.threadSource = session.threadSource ?? metadata.threadSource;
  session.agentNickname = session.agentNickname ?? metadata.agentNickname;
  session.firstUser = session.firstUser ?? (metadata.firstUser ? usablePrompt(metadata.firstUser.slice(0, 200)) : null);
  return session;
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
                mergeMetadata(cached.session, cached.session.id ? metadata.get(cached.session.id) : undefined);
                if (cached.session.id || cached.session.start) {
                  sessions.push(cached.session);
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
              skippedLines += parsed.skippedLines;
              const session = parsed.session;
              if (stat) {
                parsedForCache.push({ filePath, session: { ...session }, stat });
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
      sessions: result.sessions.length,
      skippedLines: result.skippedLines,
    }),
  );

export const readCodexUsageSessions: Effect.Effect<CollectedSession[], LocalHistoryError, LocalHistoryStorageService> =
  withPerfSpan(
    'aiUsage.collect.codex.usageSessions',
    Effect.gen(function* () {
      const names = yield* readCodexThreadNames;
      const metadata = yield* readCodexThreadMetadata;
      const { sessions } = yield* readCodexSessions(metadata);
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
          name: codexSessionName(session, indexedName, meta),
          titleSource: codexTitleSource(session, indexedName, meta, isSubagent),
          project: base(session.cwd),
          tokens,
          cost: subscription ? actualCost(0) : approximateApiCost,
          calls: 1,
          turns: session.turns,
          tools: session.tools,
          linesAdded: null,
          linesDeleted: null,
          subagent: isSubagent || kids.length > 0,
          usageUnavailable: !session.hasTokenUsage,
        });
      }

      return usageSessions;
    }),
    (sessions) => ({ sessions: sessions.length }),
  );

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
