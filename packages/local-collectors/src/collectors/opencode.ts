import fs from 'node:fs';
import path from 'node:path';
import { actualCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import { type LocalHistoryWarning, localHistoryWarningFromError } from '../errors';
import { LocalHistoryStorage } from '../local-history';
import { withPerfSpan } from '../perf';
import { resolvePathCandidates } from '../platform-paths';
import type { CollectorRow } from '../rtk-enrichment';
import { base, dominant, safeJSON } from '../text';

type Agg = {
  tin: number;
  tout: number;
  tcr: number;
  tcw: number;
  reason: number;
  cost: number;
  calls: number;
  start: Date | null;
  end: Date | null;
  prov: Map<string, number>;
  model: Map<string, number>;
};

type SessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  summary_additions: number | null;
  summary_deletions: number | null;
};

type CountRow = { session_id: string; n: number };
type MessageRow = { session_id: string; data: string };
type OpenCodeDbCacheEntry = { mtimeMs: number; rows: CollectorRow[]; size: number };
type OpenCodeDbCache = { dirty: boolean; entries: Record<string, OpenCodeDbCacheEntry>; version: number };

export interface OpenCodeCollectionResult {
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

const OPENCODE_DB_CACHE_VERSION = 1;
const SESSION_SQL = 'SELECT id, title, directory, summary_additions, summary_deletions FROM session';
const TOOL_COUNT_SQL = `SELECT session_id, count(*) n FROM part WHERE data LIKE '%"type":"tool"%' GROUP BY session_id`;
const MESSAGE_SQL = 'SELECT session_id, data FROM message';

const opencodeDbCachePath = (storage: import('../local-history').LocalHistoryStorage) =>
  path.join(storage.home, '.config', 'ai-usage', 'opencode-db-cache.json');

const reviveDate = (value: unknown): Date | null => {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const reviveCollectorRows = (value: unknown): CollectorRow[] => {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const record = row as CollectorRow;
    return {
      ...record,
      date: reviveDate(record.date),
      endDate: reviveDate(record.endDate),
    };
  });
};

const readOpenCodeDbCache = (storage: import('../local-history').LocalHistoryStorage): OpenCodeDbCache | null => {
  try {
    if (!fs.existsSync(storage.home)) return null;
    const cachePath = opencodeDbCachePath(storage);
    if (!fs.existsSync(cachePath)) return { dirty: false, entries: {}, version: OPENCODE_DB_CACHE_VERSION };
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      entries?: Record<string, { mtimeMs: number; rows: unknown; size: number }>;
      version?: number;
    };
    if (parsed.version !== OPENCODE_DB_CACHE_VERSION) {
      return { dirty: false, entries: {}, version: OPENCODE_DB_CACHE_VERSION };
    }
    const entries: Record<string, OpenCodeDbCacheEntry> = {};
    for (const [dbPath, entry] of Object.entries(parsed.entries ?? {})) {
      if (typeof entry.mtimeMs !== 'number' || typeof entry.size !== 'number') continue;
      entries[dbPath] = { mtimeMs: entry.mtimeMs, rows: reviveCollectorRows(entry.rows), size: entry.size };
    }
    return { dirty: false, entries, version: OPENCODE_DB_CACHE_VERSION };
  } catch {
    return null;
  }
};

const writeOpenCodeDbCache = (
  storage: import('../local-history').LocalHistoryStorage,
  cache: OpenCodeDbCache | null,
) => {
  if (!cache?.dirty) return false;
  const cachePath = opencodeDbCachePath(storage);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    `${JSON.stringify({ entries: cache.entries, version: OPENCODE_DB_CACHE_VERSION })}\n`,
    'utf8',
  );
  cache.dirty = false;
  return true;
};

const dbStat = (dbPath: string) => {
  try {
    const stat = fs.statSync(dbPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
};

const collectFromDb = (
  dbPath: string,
  storage: import('../local-history').LocalHistoryStorage,
  source: 'live' | 'stable',
  cache: OpenCodeDbCache | null,
): Effect.Effect<CollectorRow[], import('../errors').LocalHistoryError, never> =>
  withPerfSpan(
    'aiUsage.collect.opencode.db',
    Effect.gen(function* () {
      const exists = yield* withPerfSpan(
        'aiUsage.collect.opencode.db.exists',
        storage.exists(dbPath).pipe(Effect.catchAll(() => Effect.succeed(false))),
        (value) => ({ db: source, exists: value }),
      );
      if (!exists) return [];

      const stat = dbStat(dbPath);
      if (cache && stat) {
        const cached = cache.entries[dbPath];
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          return yield* withPerfSpan('aiUsage.collect.opencode.cache.hit', Effect.succeed(cached.rows), (rows) => ({
            db: source,
            rows: rows.length,
          }));
        }
      }

      const meta = new Map<string, { title: string; dir: string; add: number; del: number }>();
      const toolCount = new Map<string, number>();
      const turnCount = new Map<string, number>();
      const agg = new Map<string, Agg>();

      yield* Effect.acquireUseRelease(
        withPerfSpan('aiUsage.collect.opencode.db.open', storage.openDatabase(dbPath), () => ({ db: source })),
        (db) =>
          Effect.gen(function* () {
            const sessionRows = yield* withPerfSpan(
              'aiUsage.collect.opencode.db.query.sessions',
              db.all<SessionRow>(SESSION_SQL),
              (rows) => ({ db: source, rows: rows.length }),
            );
            for (const row of sessionRows) {
              meta.set(row.id, {
                title: row.title || '',
                dir: row.directory || '',
                add: row.summary_additions || 0,
                del: row.summary_deletions || 0,
              });
            }

            const toolRows = yield* withPerfSpan(
              'aiUsage.collect.opencode.db.query.toolCounts',
              db.all<CountRow>(TOOL_COUNT_SQL),
              (rows) => ({ db: source, rows: rows.length }),
            );
            for (const row of toolRows) {
              toolCount.set(row.session_id, row.n);
            }

            const messageRows = yield* withPerfSpan(
              'aiUsage.collect.opencode.db.query.messages',
              db.all<MessageRow>(MESSAGE_SQL),
              (rows) => ({ db: source, rows: rows.length }),
            );
            yield* withPerfSpan(
              'aiUsage.collect.opencode.parse.messages',
              Effect.sync(() => {
                let assistantRows = 0;
                let tokenRows = 0;
                let userRows = 0;
                for (const row of messageRows) {
                  const data = safeJSON(row.data);
                  if (data?.role === 'user') {
                    userRows++;
                    turnCount.set(row.session_id, (turnCount.get(row.session_id) || 0) + 1);
                    continue;
                  }
                  if (data?.role !== 'assistant') continue;
                  assistantRows++;
                  const tokens = data.tokens;
                  if (!tokens) continue;
                  tokenRows++;
                  let current = agg.get(row.session_id);
                  if (!current) {
                    current = {
                      tin: 0,
                      tout: 0,
                      tcr: 0,
                      tcw: 0,
                      reason: 0,
                      cost: 0,
                      calls: 0,
                      start: null,
                      end: null,
                      prov: new Map(),
                      model: new Map(),
                    };
                    agg.set(row.session_id, current);
                  }
                  const input = tokens.input || 0;
                  const output = tokens.output || 0;
                  const cacheRead = tokens.cache?.read || 0;
                  const cacheWrite = tokens.cache?.write || 0;
                  const reasoning = tokens.reasoning || 0;
                  current.tin += input;
                  current.tout += output;
                  current.tcr += cacheRead;
                  current.tcw += cacheWrite;
                  current.reason += reasoning;
                  current.cost += data.cost || 0;
                  current.calls++;
                  const created = data.time?.created;
                  if (created) {
                    const date = new Date(created);
                    if (!current.start || date < current.start) current.start = date;
                  }
                  const completed = data.time?.completed || data.time?.created;
                  if (completed) {
                    const date = new Date(completed);
                    if (!current.end || date > current.end) current.end = date;
                  }
                  const total = input + output + cacheRead + cacheWrite;
                  current.prov.set(data.providerID || '?', (current.prov.get(data.providerID || '?') || 0) + total);
                  current.model.set(data.modelID || '?', (current.model.get(data.modelID || '?') || 0) + total);
                }
                return { assistantRows, tokenRows, userRows };
              }),
              (result) => ({
                db: source,
                rows: messageRows.length,
                sessions: agg.size,
                assistantRows: result.assistantRows,
                tokenRows: result.tokenRows,
                userRows: result.userRows,
              }),
            );
          }),
        (db) => db.close,
      );

      const provLabel = (providerId: string, cost: number) => {
        if (providerId === 'openai') return cost > 0 ? 'OpenAI API' : 'Codex sub (OC)';
        if (providerId === 'anthropic') return 'Anthropic API';
        if (providerId === 'opencode') return 'OpenCode Zen';
        if (providerId === 'cursor') return 'via Cursor (OC)';
        return providerId;
      };

      const sessions = yield* withPerfSpan(
        'aiUsage.collect.opencode.mapSessions',
        Effect.sync(() => {
          const sessions: CollectedSession[] = [];
          for (const [sid, current] of agg) {
            const sessionMeta = meta.get(sid);
            const providerId = dominant(current.prov);
            const model = dominant(current.model);
            const tokens = {
              in: current.tin,
              out: current.tout + current.reason,
              cr: current.tcr,
              cw: current.tcw,
            };
            const title = sessionMeta?.title && !/^ACP Session /i.test(sessionMeta.title) ? sessionMeta.title : '';
            sessions.push({
              source: { harnessKey: 'opencode', sourceSessionId: sid, sourcePath: sessionMeta?.dir ?? null },
              projectPath: sessionMeta?.dir ?? null,
              date: current.start,
              endDate: current.end,
              provider: provLabel(providerId, current.cost),
              name: title || (sessionMeta?.title ? 'ACP session' : '') || sid.slice(0, 10),
              model: `${providerId}/${model}`,
              pricingModel: model,
              project: base(sessionMeta?.dir),
              tokens,
              cost: actualCost(current.cost),
              calls: current.calls,
              turns: turnCount.get(sid) || 0,
              tools: toolCount.get(sid) || 0,
              linesAdded: sessionMeta?.add ?? null,
              linesDeleted: sessionMeta?.del ?? null,
            });
          }
          return sessions.map(sessionToUsageRow);
        }),
        (rows) => ({ db: source, rows: rows.length, sessions: rows.length }),
      );
      if (cache && stat) {
        cache.entries[dbPath] = { mtimeMs: stat.mtimeMs, rows: sessions, size: stat.size };
        cache.dirty = true;
      }
      return sessions;
    }),
    (rows) => ({ db: source, rows: rows.length }),
  );

export const collectOpenCode = Effect.gen(function* () {
  const result = yield* collectOpenCodeResult;
  return result.rows;
});

export const collectOpenCodeResult: Effect.Effect<
  OpenCodeCollectionResult,
  never,
  import('../local-history').LocalHistoryStorage
> = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const paths = resolvePathCandidates(storage).opencode;
  const cache = yield* withPerfSpan(
    'aiUsage.collect.opencode.cache.read',
    Effect.sync(() => readOpenCodeDbCache(storage)),
    (value) => ({ enabled: value !== null, entries: value ? Object.keys(value.entries).length : 0 }),
  );
  const seen = new Set<string>();
  const warnings: LocalHistoryWarning[] = [];
  const appendRows = (target: CollectorRow[], rows: CollectorRow[]) => {
    for (const row of rows) {
      const sessionId = row.source?.sourceSessionId;
      if (sessionId && seen.has(sessionId)) continue;
      if (sessionId) seen.add(sessionId);
      target.push(row);
    }
  };

  const liveRows: CollectorRow[] = [];
  for (const dbPath of paths.liveDb) {
    const result = yield* collectFromDb(dbPath, storage, 'live', cache).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: 'failure' as const, error }),
        onSuccess: (rows) => ({ _tag: 'success' as const, rows }),
      }),
    );
    if (result._tag === 'failure') {
      warnings.push(
        localHistoryWarningFromError(result.error, {
          harness: 'opencode',
          message: 'Failed to read OpenCode live database',
        }),
      );
    } else {
      appendRows(liveRows, result.rows);
    }
  }

  const stableRows: CollectorRow[] = [];
  for (const dbPath of paths.stableDb) {
    const result = yield* collectFromDb(dbPath, storage, 'stable', cache).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: 'failure' as const, error }),
        onSuccess: (rows) => ({ _tag: 'success' as const, rows }),
      }),
    );
    if (result._tag === 'failure') {
      warnings.push(
        localHistoryWarningFromError(result.error, {
          harness: 'opencode',
          message: 'Failed to read OpenCode stable database',
        }),
      );
    } else {
      appendRows(stableRows, result.rows);
    }
  }

  yield* withPerfSpan(
    'aiUsage.collect.opencode.cache.write',
    Effect.sync(() => writeOpenCodeDbCache(storage, cache)),
    (wrote) => ({ wrote }),
  );

  return { rows: [...liveRows, ...stableRows], warnings };
});
