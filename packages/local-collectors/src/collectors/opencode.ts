import { parseSessionVcsContext, type SessionVcsContext } from '@ai-usage/report-core/session-vcs';
import type { TitleSource } from '@ai-usage/report-core/types';
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
import { readLocalGitRepository } from '../local-git';
import { LocalHistoryStorage } from '../local-history';
import { metricValidationWarning, parseOptionalNonNegativeSafeInteger } from '../metric-validation';
import { OPENCODE_DIRECT_USER_PART_PREDICATE, OPENCODE_TOOL_PART_PREDICATE } from '../opencode-schema';
import {
  buildOpenCodeProjectionSummary,
  decodeOpenCodeMessageRow,
  type OpenCodeMessageFact,
} from '../opencode-session-facts';
import { withPerfSpan } from '../perf';
import { resolvePathCandidates } from '../platform-paths';
import type { CollectorRow } from '../rtk-enrichment';
import { base, safeJSON } from '../text';

const DEFAULT_ACP_SESSION_TITLE = /^(new session\s*[.…]*|acp(?: session)?)$/i;

interface Agg {
  facts: OpenCodeMessageFact[];
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
  time_created?: unknown;
}
export interface OpenCodeCollectionResult {
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

const OPENCODE_DB_CACHE_VERSION = 9;
const OPENCODE_DB_CACHE_FILE = 'opencode-db-cache.json';
const SESSION_SQL = 'SELECT id, parent_id, title, directory, summary_additions, summary_deletions FROM session';
const TOOL_COUNT_SQL = `SELECT session_id, count(*) n FROM part WHERE ${OPENCODE_TOOL_PART_PREDICATE} GROUP BY session_id`;
const TURN_COUNT_SQL = `SELECT m.session_id, count(DISTINCT m.id) n FROM message m JOIN part p ON p.message_id = m.id WHERE json_valid(m.data) AND json_valid(p.data) AND json_extract(m.data, '$.role') = 'user' AND ${OPENCODE_DIRECT_USER_PART_PREDICATE} GROUP BY m.session_id`;
const MESSAGE_SQL = 'SELECT session_id, data, time_created FROM message ORDER BY session_id, time_created, id';

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
                  const decoded = decodeOpenCodeMessageRow({ ...data, created: row.time_created });
                  if (decoded.kind === 'ignored') {
                    continue;
                  }
                  if (decoded.kind === 'invalid') {
                    rejectedMetricRecords++;
                    continue;
                  }
                  tokenRows++;
                  let current = agg.get(row.session_id);
                  if (!current) {
                    current = { facts: [] };
                    agg.set(row.session_id, current);
                  }
                  current.facts.push(decoded.value);
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
          const vcsByDirectory = new Map<string, SessionVcsContext | undefined>();
          const vcsForDirectory = (directory: string): SessionVcsContext | undefined => {
            if (vcsByDirectory.has(directory)) {
              return vcsByDirectory.get(directory);
            }
            const repository = readLocalGitRepository(directory || null);
            const vcs = repository
              ? parseSessionVcsContext({
                  branches: [],
                  headCommit: null,
                  partial: false,
                  pullRequests: [],
                  repository,
                })
              : undefined;
            vcsByDirectory.set(directory, vcs);
            return vcs;
          };
          for (const [sid, current] of agg) {
            const summary = buildOpenCodeProjectionSummary(current.facts);
            if (!summary) {
              rejectedMetricRecords++;
              continue;
            }
            const sessionMeta = meta.get(sid);
            const tokens = {
              in: summary.tokens.input,
              out: summary.tokens.output,
              cr: summary.tokens.cacheRead,
              cw: summary.tokens.cacheWrite,
            };
            const title = classifyOpenCodeTitle(sessionMeta?.title ?? null, sid);
            const sourcePath = sessionMeta?.dir ?? null;
            const vcs = vcsForDirectory(sourcePath ?? '');
            sessions.push({
              source: {
                harnessKey: 'opencode',
                sourceSessionId: sid,
                ...(sessionMeta?.parentId ? { parentSourceSessionId: sessionMeta.parentId } : {}),
                sourcePath,
                ...(vcs ? { vcs } : {}),
              },
              projectPath: sessionMeta?.dir ?? null,
              date: summary.startMs === null ? null : new Date(summary.startMs),
              endDate: summary.endMs === null ? null : new Date(summary.endMs),
              provider: provLabel(
                summary.dominantProviderId,
                summary.providerCosts.get(summary.dominantProviderId) ?? 0,
                summary.providerCostsKnown.get(summary.dominantProviderId) ?? false,
              ),
              name: title.name,
              titleSource: title.source,
              model: `${summary.dominantProviderId}/${summary.dominantModelId}`,
              models: summary.models,
              modelSegments: summary.modelSegments,
              pricingModel: summary.dominantModelId,
              project: base(sessionMeta?.dir),
              tokens,
              cost: actualCost(summary.reportedCostKnown ? summary.reportedCost : null),
              costApprox: summary.costApprox,
              costKnown: summary.costKnown,
              calls: summary.calls,
              durationMs: summary.durationMs,
              partial: summary.partial,
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
