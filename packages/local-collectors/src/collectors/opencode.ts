import { actualCost } from '@ai-usage/core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import { type LocalHistoryWarning, localHistoryWarningFromError } from '../errors';
import { LocalHistoryStorage } from '../local-history';
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

export interface OpenCodeCollectionResult {
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

const SESSION_SQL = 'SELECT id, title, directory, summary_additions, summary_deletions FROM session';
const TOOL_COUNT_SQL =
  "SELECT session_id, count(*) n FROM part WHERE json_extract(data,'$.type')='tool' GROUP BY session_id";
const MESSAGE_SQL = 'SELECT session_id, data FROM message';

const collectFromDb = (
  dbPath: string,
  storage: import('../local-history').LocalHistoryStorage,
  seen: Set<string>,
): Effect.Effect<CollectorRow[], import('../errors').LocalHistoryError, never> =>
  Effect.gen(function* () {
    if (!(yield* storage.exists(dbPath).pipe(Effect.catchAll(() => Effect.succeed(false))))) return [];

    const meta = new Map<string, { title: string; dir: string; add: number; del: number }>();
    const toolCount = new Map<string, number>();
    const turnCount = new Map<string, number>();
    const agg = new Map<string, Agg>();

    yield* Effect.acquireUseRelease(
      storage.openDatabase(dbPath),
      (db) =>
        Effect.gen(function* () {
          for (const row of yield* db.all<SessionRow>(SESSION_SQL)) {
            meta.set(row.id, {
              title: row.title || '',
              dir: row.directory || '',
              add: row.summary_additions || 0,
              del: row.summary_deletions || 0,
            });
          }

          for (const row of yield* db.all<CountRow>(TOOL_COUNT_SQL)) {
            toolCount.set(row.session_id, row.n);
          }

          for (const row of yield* db.all<MessageRow>(MESSAGE_SQL)) {
            const data = safeJSON(row.data);
            if (data?.role === 'user') turnCount.set(row.session_id, (turnCount.get(row.session_id) || 0) + 1);
          }

          for (const row of yield* db.all<MessageRow>(MESSAGE_SQL)) {
            const data = safeJSON(row.data);
            if (data?.role !== 'assistant') continue;
            const tokens = data.tokens;
            if (!tokens) continue;
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

    const sessions: CollectedSession[] = [];
    for (const [sid, current] of agg) {
      if (seen.has(sid)) continue;
      seen.add(sid);
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
  });

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
  const seen = new Set<string>();
  const warnings: LocalHistoryWarning[] = [];

  const liveRows: CollectorRow[] = [];
  for (const dbPath of paths.liveDb) {
    const result = yield* collectFromDb(dbPath, storage, seen).pipe(
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
      liveRows.push(...result.rows);
    }
  }

  const stableRows: CollectorRow[] = [];
  for (const dbPath of paths.stableDb) {
    const result = yield* collectFromDb(dbPath, storage, seen).pipe(
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
      stableRows.push(...result.rows);
    }
  }

  return { rows: [...liveRows, ...stableRows], warnings };
});
