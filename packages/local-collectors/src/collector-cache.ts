import fs from 'node:fs';
import path from 'node:path';
import { COLLECTOR_CACHE_MAX_BYTES } from './history-budgets';
import type { LocalHistoryStorage } from './local-history';
import { readPrivateJson, writePrivateJson } from './private-storage';
import type { CollectorRow } from './rtk-enrichment';

/**
 * Shared local-history caching primitives for the DB-backed collectors. Row
 * revival, file stats, and the mtime/size keyed row cache live here once instead
 * of being copy-pasted into each harness collector.
 */

export const reviveDate = (value: unknown): Date | null => {
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

export const reviveCollectorRows = (value: unknown): CollectorRow[] => {
  if (!Array.isArray(value)) {
    return [];
  }
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
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  walDev: number | null;
  walIno: number | null;
  walMtimeMs: number | null;
  walSize: number | null;
}

export const dbStat = (dbPath: string): DbStat | null => {
  try {
    const stat = fs.lstatSync(dbPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    const wal = fs.lstatSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    if (wal && (wal.isSymbolicLink() || !wal.isFile())) {
      return null;
    }
    return {
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      walDev: wal?.dev ?? null,
      walIno: wal?.ino ?? null,
      walMtimeMs: wal?.mtimeMs ?? null,
      walSize: wal?.size ?? null,
    };
  } catch {
    return null;
  }
};

export const collectorCachePath = (storage: LocalHistoryStorage, fileName: string) =>
  path.join(storage.home, '.config', 'ai-usage', fileName);

export interface DbRowCacheEntry extends DbStat {
  rows: CollectorRow[];
}

export interface DbRowCache {
  dirty: boolean;
  entries: Record<string, DbRowCacheEntry>;
  version: number;
}

/** Read a per-db row cache, returning an empty cache on a version mismatch and null on any IO failure. */
export const readDbRowCache = (storage: LocalHistoryStorage, fileName: string, version: number): DbRowCache | null => {
  try {
    if (!fs.existsSync(storage.home)) {
      return null;
    }
    const cachePath = collectorCachePath(storage, fileName);
    if (!fs.existsSync(cachePath)) {
      return { dirty: false, entries: {}, version };
    }
    const parsed = readPrivateJson(cachePath, COLLECTOR_CACHE_MAX_BYTES) as
      | {
          entries?: Record<string, DbStat & { rows: unknown }>;
          version?: number;
        }
      | undefined;
    if (!parsed) {
      return { dirty: false, entries: {}, version };
    }
    if (parsed.version !== version) {
      return { dirty: false, entries: {}, version };
    }
    const entries: Record<string, DbRowCacheEntry> = {};
    for (const [dbPath, entry] of Object.entries(parsed.entries ?? {})) {
      if (
        typeof entry.dev !== 'number' ||
        typeof entry.ino !== 'number' ||
        typeof entry.mtimeMs !== 'number' ||
        typeof entry.size !== 'number'
      ) {
        continue;
      }
      entries[dbPath] = { ...entry, rows: reviveCollectorRows(entry.rows) };
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
  if (!cache?.dirty) {
    return false;
  }
  const cachePath = collectorCachePath(storage, fileName);
  const value = { entries: cache.entries, version };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > COLLECTOR_CACHE_MAX_BYTES) {
    cache.dirty = false;
    return false;
  }
  writePrivateJson(cachePath, value);
  cache.dirty = false;
  return true;
};

/** Return cached rows for a db path when the cache entry matches the current file stat, else null. */
export const cachedDbRows = (cache: DbRowCache | null, dbPath: string, stat: DbStat | null): CollectorRow[] | null => {
  if (!(cache && stat)) {
    return null;
  }
  const cached = cache.entries[dbPath];
  if (
    cached &&
    cached.dev === stat.dev &&
    cached.ino === stat.ino &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.walDev === stat.walDev &&
    cached.walIno === stat.walIno &&
    cached.walSize === stat.walSize &&
    cached.walMtimeMs === stat.walMtimeMs
  ) {
    return cached.rows;
  }
  return null;
};

/** Store freshly collected rows for a db path and mark the cache dirty. No-op without a cache or stat. */
export const storeDbRows = (
  cache: DbRowCache | null,
  dbPath: string,
  stat: DbStat | null,
  rows: CollectorRow[],
): void => {
  if (!(cache && stat)) {
    return;
  }
  cache.entries[dbPath] = { ...stat, rows };
  cache.dirty = true;
};
