import type { TitleSource } from '@ai-usage/report-core/types';
import { actualCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import {
  cachedDbRows,
  type DbRowCache,
  dbStat,
  readDbRowCache,
  storeDbRows,
  writeDbRowCache,
} from '../collector-cache';
import { type LocalHistoryWarning, localHistoryWarningFromError } from '../errors';
import { LocalHistoryStorage } from '../local-history';
import {
  addNonNegativeFiniteNumbers,
  addNonNegativeSafeIntegers,
  parseOptionalNonNegativeFiniteNumber,
  parseOptionalNonNegativeSafeInteger,
} from '../metric-validation';
import { withPerfSpan } from '../perf';
import { resolvePathCandidates } from '../platform-paths';
import type { CollectorRow } from '../rtk-enrichment';
import { base, dominant, isJsonObject, safeJSON } from '../text';

const DEFAULT_ACP_SESSION_TITLE = /^(new session\s*[.…]*|acp(?: session)?)$/i;

interface Agg {
  calls: number;
  cost: number;
  end: Date | null;
  model: Map<string, number>;
  prov: Map<string, number>;
  reason: number;
  start: Date | null;
  tcr: number;
  tcw: number;
  tin: number;
  tout: number;
}

interface SessionRow {
  directory: string | null;
  id: string;
  parent_id: string | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  title: string | null;
}

interface CountRow {
  n: number;
  session_id: string;
}
interface MessageRow {
  data: string;
  session_id: string;
}
export interface OpenCodeCollectionResult {
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

const OPENCODE_DB_CACHE_VERSION = 3;
const OPENCODE_DB_CACHE_FILE = 'opencode-db-cache.json';
const SESSION_SQL = 'SELECT id, parent_id, title, directory, summary_additions, summary_deletions FROM session';
const TOOL_COUNT_SQL = `SELECT session_id, count(*) n FROM part WHERE data LIKE '%"type":"tool"%' GROUP BY session_id`;
const MESSAGE_SQL = 'SELECT session_id, data FROM message';

const collectFromDb = (
  dbPath: string,
  storage: import('../local-history').LocalHistoryStorage,
  source: 'live' | 'stable',
  cache: DbRowCache | null,
): Effect.Effect<CollectorRow[], import('../errors').LocalHistoryError, never> =>
  withPerfSpan(
    'aiUsage.collect.opencode.db',
    Effect.gen(function* () {
      const exists = yield* withPerfSpan(
        'aiUsage.collect.opencode.db.exists',
        storage.exists(dbPath).pipe(Effect.catchAll(() => Effect.succeed(false))),
        (value) => ({ db: source, exists: value }),
      );
      if (!exists) {
        return [];
      }

      const stat = dbStat(dbPath);
      const cachedRows = cachedDbRows(cache, dbPath, stat);
      if (cachedRows) {
        return yield* withPerfSpan('aiUsage.collect.opencode.cache.hit', Effect.succeed(cachedRows), (rows) => ({
          db: source,
          rows: rows.length,
        }));
      }

      const meta = new Map<string, { parentId: string | null; title: string; dir: string; add: number; del: number }>();
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
                parentId: row.parent_id || null,
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
                  if (data?.role !== 'assistant') {
                    continue;
                  }
                  assistantRows++;
                  const tokens = isJsonObject(data.tokens) ? data.tokens : null;
                  if (!tokens) {
                    continue;
                  }
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
                  const input = parseOptionalNonNegativeSafeInteger(tokens.input);
                  const output = parseOptionalNonNegativeSafeInteger(tokens.output);
                  const cache = isJsonObject(tokens.cache) ? tokens.cache : null;
                  const cacheRead = parseOptionalNonNegativeSafeInteger(cache?.read);
                  const cacheWrite = parseOptionalNonNegativeSafeInteger(cache?.write);
                  const reasoning = parseOptionalNonNegativeSafeInteger(tokens.reasoning);
                  const cost = parseOptionalNonNegativeFiniteNumber(data.cost);
                  if (!(input.ok && output.ok && cacheRead.ok && cacheWrite.ok && reasoning.ok && cost.ok)) {
                    continue;
                  }
                  const nextInput = addNonNegativeSafeIntegers(current.tin, input.value);
                  const nextOutput = addNonNegativeSafeIntegers(current.tout, output.value);
                  const nextCacheRead = addNonNegativeSafeIntegers(current.tcr, cacheRead.value);
                  const nextCacheWrite = addNonNegativeSafeIntegers(current.tcw, cacheWrite.value);
                  const nextReasoning = addNonNegativeSafeIntegers(current.reason, reasoning.value);
                  const nextCalls = addNonNegativeSafeIntegers(current.calls, 1);
                  const nextCost = addNonNegativeFiniteNumbers(current.cost, cost.value);
                  if (
                    !(
                      nextInput.ok &&
                      nextOutput.ok &&
                      nextCacheRead.ok &&
                      nextCacheWrite.ok &&
                      nextReasoning.ok &&
                      nextCalls.ok &&
                      nextCost.ok
                    )
                  ) {
                    continue;
                  }
                  current.tin = nextInput.value;
                  current.tout = nextOutput.value;
                  current.tcr = nextCacheRead.value;
                  current.tcw = nextCacheWrite.value;
                  current.reason = nextReasoning.value;
                  current.cost = nextCost.value;
                  current.calls = nextCalls.value;
                  const time = isJsonObject(data.time) ? data.time : null;
                  const created = time?.created;
                  if (typeof created === 'string' || typeof created === 'number') {
                    const date = new Date(created);
                    if (!current.start || date < current.start) {
                      current.start = date;
                    }
                  }
                  const completed = time?.completed || time?.created;
                  if (typeof completed === 'string' || typeof completed === 'number') {
                    const date = new Date(completed);
                    if (!current.end || date > current.end) {
                      current.end = date;
                    }
                  }
                  const total = input.value + output.value + cacheRead.value + cacheWrite.value;
                  const providerId = typeof data.providerID === 'string' ? data.providerID : '?';
                  const modelId = typeof data.modelID === 'string' ? data.modelID : '?';
                  current.prov.set(providerId, (current.prov.get(providerId) || 0) + total);
                  current.model.set(modelId, (current.model.get(modelId) || 0) + total);
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
        if (providerId === 'openai') {
          return cost > 0 ? 'OpenAI API' : 'Codex sub (OC)';
        }
        if (providerId === 'anthropic') {
          return 'Anthropic API';
        }
        if (providerId === 'opencode') {
          return 'OpenCode Zen';
        }
        if (providerId === 'cursor') {
          return 'via Cursor (OC)';
        }
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
            const title = classifyOpenCodeTitle(sessionMeta?.title ?? null, sid);
            sessions.push({
              source: {
                harnessKey: 'opencode',
                sourceSessionId: sid,
                ...(sessionMeta?.parentId ? { parentSourceSessionId: sessionMeta.parentId } : {}),
                sourcePath: sessionMeta?.dir ?? null,
              },
              projectPath: sessionMeta?.dir ?? null,
              date: current.start,
              endDate: current.end,
              provider: provLabel(providerId, current.cost),
              name: title.name,
              titleSource: title.source,
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
      const afterStat = dbStat(dbPath);
      if (JSON.stringify(stat) === JSON.stringify(afterStat)) {
        storeDbRows(cache, dbPath, afterStat, sessions);
      }
      return sessions;
    }),
    (rows) => ({ db: source, rows: rows.length }),
  );

export const classifyOpenCodeTitle = (
  title: string | null,
  sessionId: string,
): { name: string; source: TitleSource } => {
  const normalized = title?.trim().replace(/\s+/g, ' ') ?? '';
  if (!normalized) {
    return { name: sessionId.slice(0, 10), source: 'id' };
  }
  if (DEFAULT_ACP_SESSION_TITLE.test(normalized)) {
    return { name: normalized.toLowerCase().startsWith('acp') ? 'ACP session' : sessionId.slice(0, 10), source: 'id' };
  }
  return { name: normalized, source: 'ai' };
};

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
    Effect.sync(() => readDbRowCache(storage, OPENCODE_DB_CACHE_FILE, OPENCODE_DB_CACHE_VERSION)),
    (value) => ({ enabled: value !== null, entries: value ? Object.keys(value.entries).length : 0 }),
  );
  const seen = new Set<string>();
  const warnings: LocalHistoryWarning[] = [];
  const appendRows = (target: CollectorRow[], rows: CollectorRow[]) => {
    for (const row of rows) {
      const sessionId = row.source?.sourceSessionId;
      if (sessionId && seen.has(sessionId)) {
        continue;
      }
      if (sessionId) {
        seen.add(sessionId);
      }
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
    Effect.sync(() => writeDbRowCache(storage, OPENCODE_DB_CACHE_FILE, OPENCODE_DB_CACHE_VERSION, cache)),
    (wrote) => ({ wrote }),
  );

  return { rows: [...liveRows, ...stableRows], warnings };
});
