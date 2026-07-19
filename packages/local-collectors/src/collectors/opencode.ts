import { approxCost, priceFor } from '@ai-usage/report-core/pricing';
import type { TitleSource, UsageModelSegment } from '@ai-usage/report-core/types';
import { actualCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import {
  cachedDbCollection,
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
  metricValidationWarning,
  parseOptionalNonNegativeFiniteNumber,
  parseOptionalNonNegativeSafeInteger,
} from '../metric-validation';
import { OPENCODE_DIRECT_USER_PART_PREDICATE } from '../opencode-schema';
import { withPerfSpan } from '../perf';
import { resolvePathCandidates } from '../platform-paths';
import type { CollectorRow } from '../rtk-enrichment';
import { base, dominant, isJsonObject, safeJSON } from '../text';

const DEFAULT_ACP_SESSION_TITLE = /^(new session\s*[.…]*|acp(?: session)?)$/i;

interface Agg {
  calls: number;
  cost: number;
  end: Date | null;
  hasIncompleteInterval: boolean;
  intervals: { endMs: number; startMs: number }[];
  modelIdentities: Map<string, { modelId: string; providerId: string }>;
  modelOrder: string[];
  modelSegments: Map<string, UsageModelSegment>;
  modelWeights: Map<string, number>;
  providerCosts: Map<string, number>;
  providerCostsKnown: Map<string, boolean>;
  reason: number;
  reportedCostKnown: boolean;
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

const OPENCODE_DB_CACHE_VERSION = 7;
const OPENCODE_DB_CACHE_FILE = 'opencode-db-cache.json';
const SESSION_SQL = 'SELECT id, parent_id, title, directory, summary_additions, summary_deletions FROM session';
const TOOL_COUNT_SQL = `SELECT session_id, count(*) n FROM part WHERE data LIKE '%"type":"tool"%' GROUP BY session_id`;
const TURN_COUNT_SQL = `SELECT m.session_id, count(DISTINCT m.id) n FROM message m JOIN part p ON p.message_id = m.id WHERE json_extract(m.data, '$.role') = 'user' AND ${OPENCODE_DIRECT_USER_PART_PREDICATE} GROUP BY m.session_id`;
const MESSAGE_SQL = 'SELECT session_id, data FROM message ORDER BY session_id, time_created, id';

const modelIdentityKey = (providerId: string, modelId: string): string => `${providerId}\u0000${modelId}`;
const modelIdentityLabel = (providerId: string, modelId: string): string => `${providerId}/${modelId}`;

const mergedIntervalDurationMs = (intervals: readonly { endMs: number; startMs: number }[]): number => {
  const ordered = [...intervals].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const first = ordered[0];
  if (!first) {
    return 0;
  }
  let durationMs = 0;
  let currentStartMs = first.startMs;
  let currentEndMs = first.endMs;
  for (const interval of ordered.slice(1)) {
    if (interval.startMs > currentEndMs) {
      durationMs += currentEndMs - currentStartMs;
      currentStartMs = interval.startMs;
      currentEndMs = interval.endMs;
      continue;
    }
    currentEndMs = Math.max(currentEndMs, interval.endMs);
  }
  return durationMs + currentEndMs - currentStartMs;
};

const collectFromDb = (
  dbPath: string,
  storage: import('../local-history').LocalHistoryStorage,
  source: 'live' | 'stable',
  cache: DbRowCache | null,
): Effect.Effect<
  { rejectedMetricRecords: number; rows: CollectorRow[] },
  import('../errors').LocalHistoryError,
  never
> =>
  withPerfSpan(
    'aiUsage.collect.opencode.db',
    Effect.gen(function* () {
      const exists = yield* withPerfSpan(
        'aiUsage.collect.opencode.db.exists',
        storage.exists(dbPath).pipe(Effect.catchAll(() => Effect.succeed(false))),
        (value) => ({ db: source, exists: value }),
      );
      if (!exists) {
        return { rejectedMetricRecords: 0, rows: [] };
      }

      const stat = dbStat(dbPath);
      const cached = cachedDbCollection(cache, dbPath, stat);
      if (cached) {
        return yield* withPerfSpan('aiUsage.collect.opencode.cache.hit', Effect.succeed(cached), (result) => ({
          db: source,
          rows: result.rows.length,
        }));
      }

      const meta = new Map<string, { parentId: string | null; title: string; dir: string; add: number; del: number }>();
      const toolCount = new Map<string, number>();
      const turnCount = new Map<string, number>();
      const agg = new Map<string, Agg>();
      let rejectedMetricRecords = 0;

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
              const additions = parseOptionalNonNegativeSafeInteger(row.summary_additions);
              const deletions = parseOptionalNonNegativeSafeInteger(row.summary_deletions);
              if (!(typeof row.id === 'string' && additions.ok && deletions.ok)) {
                rejectedMetricRecords++;
                continue;
              }
              meta.set(row.id, {
                parentId: row.parent_id || null,
                title: row.title || '',
                dir: row.directory || '',
                add: additions.value,
                del: deletions.value,
              });
            }

            const toolRows = yield* withPerfSpan(
              'aiUsage.collect.opencode.db.query.toolCounts',
              db.all<CountRow>(TOOL_COUNT_SQL),
              (rows) => ({ db: source, rows: rows.length }),
            );
            for (const row of toolRows) {
              const count = parseOptionalNonNegativeSafeInteger(row.n);
              if (!(typeof row.session_id === 'string' && count.ok)) {
                rejectedMetricRecords++;
                continue;
              }
              toolCount.set(row.session_id, count.value);
            }

            const turnRows = yield* withPerfSpan(
              'aiUsage.collect.opencode.db.query.turnCounts',
              db.all<CountRow>(TURN_COUNT_SQL),
              (rows) => ({ db: source, rows: rows.length }),
            );
            for (const row of turnRows) {
              const count = parseOptionalNonNegativeSafeInteger(row.n);
              if (!(typeof row.session_id === 'string' && count.ok)) {
                rejectedMetricRecords++;
                continue;
              }
              turnCount.set(row.session_id, count.value);
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
                      hasIncompleteInterval: false,
                      intervals: [],
                      modelIdentities: new Map(),
                      modelOrder: [],
                      modelSegments: new Map(),
                      modelWeights: new Map(),
                      providerCosts: new Map(),
                      providerCostsKnown: new Map(),
                      reportedCostKnown: true,
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
                  const reportedCostKnown = data.cost !== undefined && data.cost !== null;
                  if (!(input.ok && output.ok && cacheRead.ok && cacheWrite.ok && reasoning.ok && cost.ok)) {
                    rejectedMetricRecords++;
                    continue;
                  }
                  const nextInput = addNonNegativeSafeIntegers(current.tin, input.value);
                  const nextOutput = addNonNegativeSafeIntegers(current.tout, output.value);
                  const nextCacheRead = addNonNegativeSafeIntegers(current.tcr, cacheRead.value);
                  const nextCacheWrite = addNonNegativeSafeIntegers(current.tcw, cacheWrite.value);
                  const nextReasoning = addNonNegativeSafeIntegers(current.reason, reasoning.value);
                  const nextCalls = addNonNegativeSafeIntegers(current.calls, 1);
                  const nextCost = addNonNegativeFiniteNumbers(current.cost, cost.value);
                  const outputWithReasoning = addNonNegativeSafeIntegers(output.value, reasoning.value);
                  const freshTokens = outputWithReasoning.ok
                    ? addNonNegativeSafeIntegers(input.value, outputWithReasoning.value)
                    : outputWithReasoning;
                  const cachedTokens = addNonNegativeSafeIntegers(cacheRead.value, cacheWrite.value);
                  const total =
                    freshTokens.ok && cachedTokens.ok
                      ? addNonNegativeSafeIntegers(freshTokens.value, cachedTokens.value)
                      : { ok: false as const };
                  const providerId = typeof data.providerID === 'string' ? data.providerID : '?';
                  const modelId = typeof data.modelID === 'string' ? data.modelID : '?';
                  const identityKey = modelIdentityKey(providerId, modelId);
                  const nextModelWeight = total.ok
                    ? addNonNegativeSafeIntegers(current.modelWeights.get(identityKey) ?? 0, total.value)
                    : total;
                  const nextProviderCost = addNonNegativeFiniteNumbers(
                    current.providerCosts.get(providerId) ?? 0,
                    cost.value,
                  );
                  const time = isJsonObject(data.time) ? data.time : null;
                  const createdCandidate = time?.created;
                  const completedCandidate = time?.completed;
                  const createdDate =
                    typeof createdCandidate === 'string' || typeof createdCandidate === 'number'
                      ? new Date(createdCandidate)
                      : null;
                  const completedDate =
                    typeof completedCandidate === 'string' || typeof completedCandidate === 'number'
                      ? new Date(completedCandidate)
                      : null;
                  const validCreated = createdDate && Number.isFinite(createdDate.getTime()) ? createdDate : null;
                  const validCompleted =
                    completedDate && Number.isFinite(completedDate.getTime()) ? completedDate : null;
                  const pricing = priceFor(modelId, { at: validCompleted ?? validCreated });
                  const messageCostApprox =
                    pricing.known && outputWithReasoning.ok
                      ? approxCost(pricing.rates, {
                          cr: cacheRead.value,
                          cw: cacheWrite.value,
                          in: input.value,
                          out: outputWithReasoning.value,
                        })
                      : 0;
                  const currentModelSegment = current.modelSegments.get(identityKey) ?? {
                    costApprox: 0,
                    costKnown: true,
                    model: modelIdentityLabel(providerId, modelId),
                    tokCr: 0,
                    tokCw: 0,
                    tokIn: 0,
                    tokOut: 0,
                  };
                  const nextModelInput = addNonNegativeSafeIntegers(currentModelSegment.tokIn, input.value);
                  const nextModelOutput = addNonNegativeSafeIntegers(
                    currentModelSegment.tokOut,
                    outputWithReasoning.ok ? outputWithReasoning.value : 0,
                  );
                  const nextModelCacheRead = addNonNegativeSafeIntegers(currentModelSegment.tokCr, cacheRead.value);
                  const nextModelCacheWrite = addNonNegativeSafeIntegers(currentModelSegment.tokCw, cacheWrite.value);
                  const nextModelCostApprox = addNonNegativeFiniteNumbers(
                    currentModelSegment.costApprox,
                    messageCostApprox,
                  );
                  if (
                    !(
                      nextInput.ok &&
                      nextOutput.ok &&
                      nextCacheRead.ok &&
                      nextCacheWrite.ok &&
                      nextReasoning.ok &&
                      nextCalls.ok &&
                      nextCost.ok &&
                      outputWithReasoning.ok &&
                      total.ok &&
                      nextModelWeight.ok &&
                      nextProviderCost.ok &&
                      nextModelInput.ok &&
                      nextModelOutput.ok &&
                      nextModelCacheRead.ok &&
                      nextModelCacheWrite.ok &&
                      nextModelCostApprox.ok
                    )
                  ) {
                    rejectedMetricRecords++;
                    continue;
                  }
                  current.tin = nextInput.value;
                  current.tout = nextOutput.value;
                  current.tcr = nextCacheRead.value;
                  current.tcw = nextCacheWrite.value;
                  current.reason = nextReasoning.value;
                  current.cost = nextCost.value;
                  current.reportedCostKnown = current.reportedCostKnown && reportedCostKnown;
                  current.calls = nextCalls.value;
                  current.modelSegments.set(identityKey, {
                    ...currentModelSegment,
                    costApprox: nextModelCostApprox.value,
                    costKnown: currentModelSegment.costKnown && (total.value === 0 || pricing.known),
                    tokCr: nextModelCacheRead.value,
                    tokCw: nextModelCacheWrite.value,
                    tokIn: nextModelInput.value,
                    tokOut: nextModelOutput.value,
                  });
                  current.modelWeights.set(identityKey, nextModelWeight.value);
                  current.modelIdentities.set(identityKey, { modelId, providerId });
                  current.providerCosts.set(providerId, nextProviderCost.value);
                  current.providerCostsKnown.set(
                    providerId,
                    (current.providerCostsKnown.get(providerId) ?? true) && reportedCostKnown,
                  );
                  if (!current.modelOrder.includes(identityKey)) {
                    current.modelOrder.push(identityKey);
                  }
                  if (validCreated && (!current.start || validCreated < current.start)) {
                    current.start = validCreated;
                  }
                  const observedEnd = validCompleted ?? validCreated;
                  if (observedEnd && (!current.end || observedEnd > current.end)) {
                    current.end = observedEnd;
                  }
                  if (validCreated && validCompleted && validCompleted >= validCreated) {
                    current.intervals.push({ endMs: validCompleted.getTime(), startMs: validCreated.getTime() });
                  } else {
                    current.hasIncompleteInterval = true;
                    if (validCreated && validCompleted && validCreated > current.end!) {
                      current.end = validCreated;
                    }
                  }
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

      const provLabel = (providerId: string, cost: number, costKnown: boolean) => {
        if (providerId === 'openai') {
          if (!costKnown) {
            return 'OpenAI via OpenCode';
          }
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
            const dominantIdentityKey = dominant(current.modelWeights);
            const dominantIdentity = current.modelIdentities.get(dominantIdentityKey) ?? {
              modelId: 'unknown',
              providerId: 'unknown',
            };
            const models = current.modelOrder.map((identityKey) => {
              const identity = current.modelIdentities.get(identityKey);
              return identity
                ? modelIdentityLabel(identity.providerId, identity.modelId)
                : modelIdentityLabel('unknown', 'unknown');
            });
            const modelSegments = current.modelOrder.flatMap((identityKey) => {
              const segment = current.modelSegments.get(identityKey);
              return segment ? [segment] : [];
            });
            const output = addNonNegativeSafeIntegers(current.tout, current.reason);
            if (!output.ok) {
              rejectedMetricRecords++;
              continue;
            }
            const tokens = {
              in: current.tin,
              out: output.value,
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
              provider: provLabel(
                dominantIdentity.providerId,
                current.providerCosts.get(dominantIdentity.providerId) ?? 0,
                current.providerCostsKnown.get(dominantIdentity.providerId) ?? false,
              ),
              name: title.name,
              titleSource: title.source,
              model: modelIdentityLabel(dominantIdentity.providerId, dominantIdentity.modelId),
              models,
              modelSegments,
              pricingModel: dominantIdentity.modelId,
              project: base(sessionMeta?.dir),
              tokens,
              cost: actualCost(current.reportedCostKnown ? current.cost : null),
              calls: current.calls,
              durationMs: mergedIntervalDurationMs(current.intervals),
              partial: current.hasIncompleteInterval,
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
        storeDbRows(cache, dbPath, afterStat, sessions, rejectedMetricRecords);
      }
      return { rejectedMetricRecords, rows: sessions };
    }),
    (result) => ({ db: source, rows: result.rows.length }),
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
  let rejectedMetricRecords = 0;
  const appendRows = (target: CollectorRow[], result: { rejectedMetricRecords: number; rows: CollectorRow[] }) => {
    rejectedMetricRecords += result.rejectedMetricRecords;
    for (const row of result.rows) {
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
        onSuccess: (result) => ({ _tag: 'success' as const, result }),
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
      appendRows(liveRows, result.result);
    }
  }

  const stableRows: CollectorRow[] = [];
  for (const dbPath of paths.stableDb) {
    const result = yield* collectFromDb(dbPath, storage, 'stable', cache).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: 'failure' as const, error }),
        onSuccess: (result) => ({ _tag: 'success' as const, result }),
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
      appendRows(stableRows, result.result);
    }
  }

  yield* withPerfSpan(
    'aiUsage.collect.opencode.cache.write',
    Effect.sync(() => writeDbRowCache(storage, OPENCODE_DB_CACHE_FILE, OPENCODE_DB_CACHE_VERSION, cache)),
    (wrote) => ({ wrote }),
  );

  const metricWarning = metricValidationWarning('opencode', rejectedMetricRecords);
  if (metricWarning) {
    warnings.push(metricWarning);
  }
  return { rows: [...liveRows, ...stableRows], warnings };
});
