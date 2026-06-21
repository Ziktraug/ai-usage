import fs from 'node:fs';
import path from 'node:path';
import type { LocalHistoryStorage } from './local-history';
import type { CollectorRow } from './rtk-enrichment';

/**
 * Shared local-history caching primitives for the DB-backed collectors. Row
 * revival, file stats, and the mtime/size keyed row cache live here once instead
 * of being copy-pasted into each harness collector.
 */

export const reviveDate = (value: unknown): Date | null => {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

export const reviveCollectorRows = (value: unknown): CollectorRow[] => {
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

export interface DbStat {
  mtimeMs: number;
  size: number;
}

export const dbStat = (dbPath: string): DbStat | null => {
  try {
    const stat = fs.statSync(dbPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
};

export const collectorCachePath = (storage: LocalHistoryStorage, fileName: string) =>
  path.join(storage.home, '.config', 'ai-usage', fileName);

export interface DbRowCacheEntry {
  mtimeMs: number;
  rows: CollectorRow[];
  size: number;
}

export interface DbRowCache {
  dirty: boolean;
  entries: Record<string, DbRowCacheEntry>;
  version: number;
}

/** Read a per-db row cache, returning an empty cache on a version mismatch and null on any IO failure. */
export const readDbRowCache = (
  storage: LocalHistoryStorage,
  fileName: string,
  version: number,
): DbRowCache | null => {
  try {
    if (!fs.existsSync(storage.home)) return null;
    const cachePath = collectorCachePath(storage, fileName);
    if (!fs.existsSync(cachePath)) return { dirty: false, entries: {}, version };
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      entries?: Record<string, { mtimeMs: number; rows: unknown; size: number }>;
      version?: number;
    };
    if (parsed.version !== version) return { dirty: false, entries: {}, version };
    const entries: Record<string, DbRowCacheEntry> = {};
    for (const [dbPath, entry] of Object.entries(parsed.entries ?? {})) {
      if (typeof entry.mtimeMs !== 'number' || typeof entry.size !== 'number') continue;
      entries[dbPath] = { mtimeMs: entry.mtimeMs, rows: reviveCollectorRows(entry.rows), size: entry.size };
    }
    return { dirty: false, entries, version };
  } catch {
    return null;
  }
};

/** Persist a dirty per-db row cache. Returns whether a write happened. */
export const writeDbRowCache = (
  storage: LocalHistoryStorage,
  fileName: string,
  version: number,
  cache: DbRowCache | null,
): boolean => {
  if (!cache?.dirty) return false;
  const cachePath = collectorCachePath(storage, fileName);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify({ entries: cache.entries, version })}\n`, 'utf8');
  cache.dirty = false;
  return true;
};

/** Return cached rows for a db path when the cache entry matches the current file stat, else null. */
export const cachedDbRows = (
  cache: DbRowCache | null,
  dbPath: string,
  stat: DbStat | null,
): CollectorRow[] | null => {
  if (!cache || !stat) return null;
  const cached = cache.entries[dbPath];
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.rows;
  return null;
};

/** Store freshly collected rows for a db path and mark the cache dirty. No-op without a cache or stat. */
export const storeDbRows = (
  cache: DbRowCache | null,
  dbPath: string,
  stat: DbStat | null,
  rows: CollectorRow[],
): void => {
  if (!cache || !stat) return;
  cache.entries[dbPath] = { mtimeMs: stat.mtimeMs, rows, size: stat.size };
  cache.dirty = true;
};
