import { actualCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import { cachedDbRows, dbStat, readDbRowCache, storeDbRows, writeDbRowCache } from '../collector-cache';
import { type LocalHistoryWarning, localHistoryWarningFromError } from '../errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from '../local-history';
import { withPerfSpan } from '../perf';
import { firstExisting, resolvePathCandidates } from '../platform-paths';
import type { CollectorRow } from '../rtk-enrichment';
import { safeJSON, usablePrompt } from '../text';
import { type CursorCsvOptions, collectCursorCsvTurns } from './cursor-csv';
import { reconcileCursorSessions } from './cursor-reconcile';

interface KeyValueRow {
  key: string;
  value: string;
}
interface CursorBubbleData {
  text?: string;
  type?: number;
}
interface CursorComposerData {
  createdAt?: number;
  modelConfig?: {
    model?: string;
    modelName?: string;
  };
  name?: string;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}
interface CursorTokenData {
  tokenCount?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

const COMPOSER_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'";
const TOKEN_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"inputTokens\"%'";
const USER_BUBBLE_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"type\":1%'";

const CURSOR_DB_CACHE_VERSION = 1;
const CURSOR_DB_CACHE_FILE = 'cursor-db-cache.json';

export type CursorCsvIngestionOptions = Partial<CursorCsvOptions> & {
  maxSessionSpanMs?: number;
  reconcileWindowMs?: number;
};

export interface CursorCollectionResult {
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

const hasCursorCsvInput = (cursorCsv: CursorCsvIngestionOptions | undefined) =>
  Boolean(cursorCsv?.usageExportPaths?.length || cursorCsv?.usageExportDir);

const cursorCsvTurnsOptions = (cursorCsv: CursorCsvIngestionOptions): CursorCsvOptions => ({
  usageExportPaths: cursorCsv.usageExportPaths ?? [],
  ...(cursorCsv.usageExportDir ? { usageExportDir: cursorCsv.usageExportDir } : {}),
  clusterGapMs: cursorCsv.clusterGapMs ?? 5 * 60_000,
  ...(cursorCsv.user ? { user: cursorCsv.user } : {}),
});

const cursorCsvReconcileOptions = (cursorCsv: CursorCsvIngestionOptions) => ({
  clusterGapMs: cursorCsv.clusterGapMs ?? 5 * 60_000,
  maxSessionSpanMs: cursorCsv.maxSessionSpanMs ?? 60 * 60_000,
  reconcileWindowMs: cursorCsv.reconcileWindowMs ?? 3 * 60_000,
});

const cursorSessionsToRows = (sessions: CollectedSession[]) => sessions.map(sessionToUsageRow);

const collectCursorSessionsFromDb = (storage: LocalHistoryStorageService, dbPath: string) =>
  Effect.gen(function* () {
    const comp = new Map<string, { name: string; model: string; created: number; add: number; del: number }>();
    const agg = new Map<string, { in: number; out: number; cr: number; cw: number; calls: number }>();
    const naming = new Map<string, { turns: number; first: string | null }>();

    yield* Effect.acquireUseRelease(
      withPerfSpan('aiUsage.collect.cursor.db.open', storage.openDatabase(dbPath)),
      (db) =>
        Effect.gen(function* () {
          const composerRows = yield* withPerfSpan(
            'aiUsage.collect.cursor.db.query.composers',
            db.all<KeyValueRow>(COMPOSER_SQL),
            (rows) => ({ rows: rows.length }),
          );
          yield* withPerfSpan(
            'aiUsage.collect.cursor.parse.composers',
            Effect.sync(() => {
              for (const row of composerRows) {
                const id = row.key.slice('composerData:'.length);
                const data = safeJSON<CursorComposerData>(row.value);
                if (!data) {
                  continue;
                }
                comp.set(id, {
                  name: data.name || '',
                  model: data.modelConfig?.modelName || data.modelConfig?.model || 'cursor',
                  created: data.createdAt || 0,
                  add: data.totalLinesAdded || 0,
                  del: data.totalLinesRemoved || 0,
                });
              }
            }),
            () => ({ rows: composerRows.length, composers: comp.size }),
          );

          const tokenRows = yield* withPerfSpan(
            'aiUsage.collect.cursor.db.query.tokens',
            db.all<KeyValueRow>(TOKEN_SQL),
            (rows) => ({ rows: rows.length }),
          );
          yield* withPerfSpan(
            'aiUsage.collect.cursor.parse.tokens',
            Effect.sync(() => {
              for (const row of tokenRows) {
                const parts = String(row.key).split(':');
                const composerId = parts[1];
                const data = safeJSON<CursorTokenData>(row.value);
                const tokenCount = data?.tokenCount;
                if (!(tokenCount && composerId)) {
                  continue;
                }
                const input = tokenCount.inputTokens || 0;
                const output = tokenCount.outputTokens || 0;
                const cacheRead = tokenCount.cacheReadTokens || 0;
                const cacheWrite = tokenCount.cacheWriteTokens || 0;
                if (input + output + cacheRead + cacheWrite === 0) {
                  continue;
                }
                let current = agg.get(composerId);
                if (!current) {
                  current = { in: 0, out: 0, cr: 0, cw: 0, calls: 0 };
                  agg.set(composerId, current);
                }
                current.in += input;
                current.out += output;
                current.cr += cacheRead;
                current.cw += cacheWrite;
                current.calls++;
              }
            }),
            () => ({ rows: tokenRows.length, sessions: agg.size }),
          );

          const namedComposerIds = new Set(comp.keys());
          const userRows = yield* withPerfSpan(
            'aiUsage.collect.cursor.db.query.userBubbles',
            db.all<KeyValueRow>(USER_BUBBLE_SQL),
            (rows) => ({ rows: rows.length }),
          );
          yield* withPerfSpan(
            'aiUsage.collect.cursor.parse.userBubbles',
            Effect.sync(() => {
              for (const row of userRows) {
                const composerId = String(row.key).split(':')[1];
                if (!(composerId && namedComposerIds.has(composerId))) {
                  continue;
                }
                const data = safeJSON<CursorBubbleData>(row.value);
                if (data?.type !== 1) {
                  continue;
                }
                const current = naming.get(composerId) ?? { turns: 0, first: null };
                current.turns++;
                if (!current.first) {
                  current.first = usablePrompt(data.text);
                }
                naming.set(composerId, current);
              }
            }),
            () => ({ rows: userRows.length, sessions: naming.size }),
          );
        }),
      (db) => db.close,
    );

    return yield* withPerfSpan(
      'aiUsage.collect.cursor.mapSessions',
      Effect.sync(() => {
        const sessions: CollectedSession[] = [];
        for (const [composerId, current] of agg) {
          const composer = comp.get(composerId);
          const name = naming.get(composerId);
          const model = composer?.model || 'cursor';
          const tokens = {
            in: current.in,
            out: current.out,
            cr: current.cr,
            cw: current.cw,
          };
          sessions.push({
            source: { harnessKey: 'cursor', sourceSessionId: composerId },
            date: composer?.created ? new Date(composer.created) : null,
            endDate: null,
            provider: 'Cursor sub',
            name: composer?.name || name?.first || `cursor ${composerId.slice(0, 8)}`,
            model,
            project: '',
            tokens,
            cost: actualCost(0),
            calls: current.calls,
            turns: name?.turns || 0,
            tools: 0,
            linesAdded: composer?.add ?? null,
            linesDeleted: composer?.del ?? null,
            partial: true,
          });
        }

        // Cursor stopped persisting per-bubble token counts around Feb 2026, so recent
        // composers carry no usable tokens. Surface them as usage-unavailable rows (like
        // the Claude prompt-history fallback) so the timeline still reflects the sessions.
        for (const [composerId, composer] of comp) {
          if (agg.has(composerId)) {
            continue;
          }
          const name = naming.get(composerId);
          if (!name || name.turns === 0) {
            continue;
          }
          sessions.push({
            source: { harnessKey: 'cursor', sourceSessionId: composerId },
            date: composer.created ? new Date(composer.created) : null,
            endDate: null,
            provider: 'Cursor sub',
            name: composer.name || name.first || `cursor ${composerId.slice(0, 8)}`,
            model: 'usage unavailable',
            project: '',
            tokens: { in: 0, out: 0, cr: 0, cw: 0 },
            cost: actualCost(null),
            calls: 0,
            turns: name.turns,
            tools: 0,
            linesAdded: composer.add ?? null,
            linesDeleted: composer.del ?? null,
            usageUnavailable: true,
          });
        }
        return sessions;
      }),
      (sessions) => ({ rows: sessions.length }),
    );
  });

export const collectCursor = withPerfSpan(
  'aiUsage.collect.cursor.details',
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const dbPath = yield* withPerfSpan(
      'aiUsage.collect.cursor.findDb',
      firstExisting(storage, ...resolvePathCandidates(storage).cursor.stateVscdb),
      (path) => ({ found: path !== null }),
    );
    if (!dbPath) {
      return [];
    }

    const cache = yield* withPerfSpan(
      'aiUsage.collect.cursor.cache.read',
      Effect.sync(() => readDbRowCache(storage, CURSOR_DB_CACHE_FILE, CURSOR_DB_CACHE_VERSION)),
      (value) => ({ enabled: value !== null, entries: value ? Object.keys(value.entries).length : 0 }),
    );
    const stat = dbStat(dbPath);
    const cachedRows = cachedDbRows(cache, dbPath, stat);
    if (cachedRows) {
      return yield* withPerfSpan('aiUsage.collect.cursor.cache.hit', Effect.succeed(cachedRows), (rows) => ({
        rows: rows.length,
      }));
    }
    const sessions = yield* collectCursorSessionsFromDb(storage, dbPath);
    const rows = cursorSessionsToRows(sessions);
    storeDbRows(cache, dbPath, stat, rows);
    yield* withPerfSpan(
      'aiUsage.collect.cursor.cache.write',
      Effect.sync(() => writeDbRowCache(storage, CURSOR_DB_CACHE_FILE, CURSOR_DB_CACHE_VERSION, cache)),
      (wrote) => ({ wrote }),
    );
    return rows;
  }),
  (rows) => ({ rows: rows.length }),
);

export const collectCursorResult = (
  cursorCsv?: CursorCsvIngestionOptions,
): Effect.Effect<CursorCollectionResult, import('../errors').LocalHistoryError, LocalHistoryStorageService> =>
  withPerfSpan(
    'aiUsage.collect.cursor.ingestion',
    Effect.gen(function* () {
      const storage = yield* LocalHistoryStorage;
      const dbPath = yield* withPerfSpan(
        'aiUsage.collect.cursor.findDb',
        firstExisting(storage, ...resolvePathCandidates(storage).cursor.stateVscdb),
        (path) => ({ found: path !== null }),
      );
      const warnings: LocalHistoryWarning[] = [];
      let sessions: CollectedSession[] = [];

      if (dbPath) {
        const dbResult = yield* collectCursorSessionsFromDb(storage, dbPath).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'failure' as const, error }),
            onSuccess: (dbSessions) => ({ _tag: 'success' as const, dbSessions }),
          }),
        );

        if (dbResult._tag === 'failure') {
          warnings.push(
            localHistoryWarningFromError(dbResult.error, {
              harness: 'cursor',
              message: 'Failed to read Cursor database',
            }),
          );
        } else {
          sessions = dbResult.dbSessions;
        }
      }

      if (cursorCsv && hasCursorCsvInput(cursorCsv)) {
        const turnsResult = yield* withPerfSpan(
          'aiUsage.collect.cursorCsv',
          collectCursorCsvTurns(cursorCsvTurnsOptions(cursorCsv)).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: 'failure' as const, error }),
              onSuccess: (turns) => ({ _tag: 'success' as const, turns }),
            }),
          ),
          (result) => ({ status: result._tag, turns: result._tag === 'success' ? result.turns.length : 0 }),
        );

        if (turnsResult._tag === 'failure') {
          warnings.push(
            localHistoryWarningFromError(turnsResult.error, {
              harness: 'cursor',
              message: 'Failed to import Cursor CSV usage export',
            }),
          );
        } else {
          sessions = reconcileCursorSessions(sessions, turnsResult.turns, cursorCsvReconcileOptions(cursorCsv));
        }
      }

      return { rows: cursorSessionsToRows(sessions), warnings };
    }),
    (result) => ({ rows: result.rows.length, warnings: result.warnings.length }),
  );
