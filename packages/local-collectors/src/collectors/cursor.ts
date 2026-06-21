import fs from 'node:fs';
import path from 'node:path';
import { actualCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import { LocalHistoryStorage } from '../local-history';
import { withPerfSpan } from '../perf';
import { firstExisting, resolvePathCandidates } from '../platform-paths';
import type { CollectorRow } from '../rtk-enrichment';
import { safeJSON, usablePrompt } from '../text';

type KeyValueRow = { key: string; value: string };
type CursorDbCacheEntry = { mtimeMs: number; rows: CollectorRow[]; size: number };
type CursorDbCache = { dirty: boolean; entries: Record<string, CursorDbCacheEntry>; version: number };

const COMPOSER_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'";
const TOKEN_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"inputTokens\"%'";
const USER_BUBBLE_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"type\":1%'";

const CURSOR_DB_CACHE_VERSION = 1;

const cursorDbCachePath = (storage: import('../local-history').LocalHistoryStorage) =>
  path.join(storage.home, '.config', 'ai-usage', 'cursor-db-cache.json');

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

const readCursorDbCache = (storage: import('../local-history').LocalHistoryStorage): CursorDbCache | null => {
  try {
    if (!fs.existsSync(storage.home)) return null;
    const cachePath = cursorDbCachePath(storage);
    if (!fs.existsSync(cachePath)) return { dirty: false, entries: {}, version: CURSOR_DB_CACHE_VERSION };
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      entries?: Record<string, { mtimeMs: number; rows: unknown; size: number }>;
      version?: number;
    };
    if (parsed.version !== CURSOR_DB_CACHE_VERSION) {
      return { dirty: false, entries: {}, version: CURSOR_DB_CACHE_VERSION };
    }
    const entries: Record<string, CursorDbCacheEntry> = {};
    for (const [dbPath, entry] of Object.entries(parsed.entries ?? {})) {
      if (typeof entry.mtimeMs !== 'number' || typeof entry.size !== 'number') continue;
      entries[dbPath] = { mtimeMs: entry.mtimeMs, rows: reviveCollectorRows(entry.rows), size: entry.size };
    }
    return { dirty: false, entries, version: CURSOR_DB_CACHE_VERSION };
  } catch {
    return null;
  }
};

const writeCursorDbCache = (storage: import('../local-history').LocalHistoryStorage, cache: CursorDbCache | null) => {
  if (!cache?.dirty) return false;
  const cachePath = cursorDbCachePath(storage);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    `${JSON.stringify({ entries: cache.entries, version: CURSOR_DB_CACHE_VERSION })}\n`,
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

export const collectCursor = withPerfSpan(
  'aiUsage.collect.cursor.details',
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const dbPath = yield* withPerfSpan(
      'aiUsage.collect.cursor.findDb',
      firstExisting(storage, ...resolvePathCandidates(storage).cursor.stateVscdb),
      (path) => ({ found: path !== null }),
    );
    if (!dbPath) return [];

    const cache = yield* withPerfSpan(
      'aiUsage.collect.cursor.cache.read',
      Effect.sync(() => readCursorDbCache(storage)),
      (value) => ({ enabled: value !== null, entries: value ? Object.keys(value.entries).length : 0 }),
    );
    const stat = dbStat(dbPath);
    if (cache && stat) {
      const cached = cache.entries[dbPath];
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return yield* withPerfSpan('aiUsage.collect.cursor.cache.hit', Effect.succeed(cached.rows), (rows) => ({
          rows: rows.length,
        }));
      }
    }

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
                const data = safeJSON(row.value);
                if (!data) continue;
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
                const data = safeJSON(row.value);
                const tokenCount = data?.tokenCount;
                if (!tokenCount || !composerId) continue;
                const input = tokenCount.inputTokens || 0;
                const output = tokenCount.outputTokens || 0;
                const cacheRead = tokenCount.cacheReadTokens || 0;
                const cacheWrite = tokenCount.cacheWriteTokens || 0;
                if (input + output + cacheRead + cacheWrite === 0) continue;
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
                if (!composerId || !namedComposerIds.has(composerId)) continue;
                const data = safeJSON(row.value);
                if (data?.type !== 1) continue;
                const current = naming.get(composerId) ?? { turns: 0, first: null };
                current.turns++;
                if (!current.first) current.first = usablePrompt(data.text);
                naming.set(composerId, current);
              }
            }),
            () => ({ rows: userRows.length, sessions: naming.size }),
          );
        }),
      (db) => db.close,
    );

    const sessions = yield* withPerfSpan(
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
          if (agg.has(composerId)) continue;
          const name = naming.get(composerId);
          if (!name || name.turns === 0) continue;
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
        return sessions.map(sessionToUsageRow);
      }),
      (rows) => ({ rows: rows.length }),
    );
    if (cache && stat) {
      cache.entries[dbPath] = { mtimeMs: stat.mtimeMs, rows: sessions, size: stat.size };
      cache.dirty = true;
    }
    yield* withPerfSpan(
      'aiUsage.collect.cursor.cache.write',
      Effect.sync(() => writeCursorDbCache(storage, cache)),
      (wrote) => ({ wrote }),
    );
    return sessions;
  }),
  (rows) => ({ rows: rows.length }),
);
