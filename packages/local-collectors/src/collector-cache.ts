import fs from 'node:fs';
import path from 'node:path';
import { COLLECTOR_CACHE_MAX_BYTES } from './history-budgets';
import type { LocalHistoryStorage } from './local-history';
import { parseNonNegativeFiniteNumber, parseNonNegativeSafeInteger } from './metric-validation';
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNullableDate = (value: unknown): boolean => value === null || reviveDate(value) !== null;
const isNullableMetric = (value: unknown): boolean => value === null || parseNonNegativeFiniteNumber(value).ok;
const isNullableCounter = (value: unknown): boolean => value === null || parseNonNegativeSafeInteger(value).ok;
const isOptionalCounter = (value: unknown): boolean => value === undefined || parseNonNegativeSafeInteger(value).ok;
const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean';
const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

const isCollectorRowSource = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    typeof value.harnessKey === 'string' &&
    (value.sourceSessionId === null || typeof value.sourceSessionId === 'string') &&
    (value.artifactPath === undefined || value.artifactPath === null || typeof value.artifactPath === 'string') &&
    (value.machineId === undefined || typeof value.machineId === 'string') &&
    (value.machineLabel === undefined || typeof value.machineLabel === 'string') &&
    (value.parentSourceSessionId === undefined ||
      value.parentSourceSessionId === null ||
      typeof value.parentSourceSessionId === 'string') &&
    (value.rootSourceSessionId === undefined ||
      value.rootSourceSessionId === null ||
      typeof value.rootSourceSessionId === 'string') &&
    (value.sourcePath === undefined || value.sourcePath === null || typeof value.sourcePath === 'string'));

const isCachedCollectorRow = (value: unknown): value is CollectorRow & { date: unknown; endDate: unknown } => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    parseNonNegativeSafeInteger(value.calls).ok &&
    isNullableMetric(value.costActual) &&
    parseNonNegativeFiniteNumber(value.costApprox).ok &&
    typeof value.costKnown === 'boolean' &&
    (value.costQuota === undefined || isNullableMetric(value.costQuota)) &&
    isNullableDate(value.date) &&
    isNullableMetric(value.durationMs) &&
    isNullableDate(value.endDate) &&
    typeof value.harness === 'string' &&
    isNullableCounter(value.linesAdded) &&
    isNullableCounter(value.linesDeleted) &&
    typeof value.model === 'string' &&
    (value.models === undefined ||
      (Array.isArray(value.models) && value.models.every((model) => typeof model === 'string'))) &&
    typeof value.name === 'string' &&
    typeof value.project === 'string' &&
    typeof value.provider === 'string' &&
    parseNonNegativeSafeInteger(value.tokCr).ok &&
    parseNonNegativeSafeInteger(value.tokCw).ok &&
    parseNonNegativeSafeInteger(value.tokIn).ok &&
    parseNonNegativeSafeInteger(value.tokOut).ok &&
    parseNonNegativeSafeInteger(value.tools).ok &&
    parseNonNegativeSafeInteger(value.turns).ok &&
    isOptionalCounter(value.rtkCommandCount) &&
    isOptionalCounter(value.rtkInputTokens) &&
    isOptionalCounter(value.rtkOutputTokens) &&
    isOptionalCounter(value.rtkSavedTokens) &&
    isOptionalBoolean(value.ambiguous) &&
    isOptionalBoolean(value.partial) &&
    isOptionalBoolean(value.subagent) &&
    isOptionalBoolean(value.usageUnavailable) &&
    isOptionalString(value.projectPath) &&
    isOptionalString(value.titleSource) &&
    isCollectorRowSource(value.source)
  );
};

export const reviveCollectorRowsResult = (
  value: unknown,
): { rejectedMetricRecords: number; rows: CollectorRow[]; valid: boolean } => {
  if (!Array.isArray(value)) {
    return { rejectedMetricRecords: 0, rows: [], valid: false };
  }
  const validRows = value.filter(isCachedCollectorRow);
  return {
    rejectedMetricRecords: value.length - validRows.length,
    rows: validRows.map((record) => ({
      ...record,
      date: reviveDate(record.date),
      endDate: reviveDate(record.endDate),
    })),
    valid: true,
  };
};

export const reviveCollectorRows = (value: unknown): CollectorRow[] => reviveCollectorRowsResult(value).rows;

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
  rejectedMetricRecords: number;
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
          entries?: Record<string, DbStat & { rejectedMetricRecords?: unknown; rows: unknown }>;
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
      const rejectedMetricRecords = parseNonNegativeSafeInteger(entry.rejectedMetricRecords);
      const revived = reviveCollectorRowsResult(entry.rows);
      if (!(rejectedMetricRecords.ok && revived.valid && revived.rejectedMetricRecords === 0)) {
        continue;
      }
      entries[dbPath] = {
        ...entry,
        rejectedMetricRecords: rejectedMetricRecords.value,
        rows: revived.rows,
      };
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
  const collection = cachedDbCollection(cache, dbPath, stat);
  return collection?.rows ?? null;
};

export const cachedDbCollection = (
  cache: DbRowCache | null,
  dbPath: string,
  stat: DbStat | null,
): { rejectedMetricRecords: number; rows: CollectorRow[] } | null => {
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
    return { rejectedMetricRecords: cached.rejectedMetricRecords, rows: cached.rows };
  }
  return null;
};

/** Store freshly collected rows for a db path and mark the cache dirty. No-op without a cache or stat. */
export const storeDbRows = (
  cache: DbRowCache | null,
  dbPath: string,
  stat: DbStat | null,
  rows: CollectorRow[],
  rejectedMetricRecords = 0,
): void => {
  if (!(cache && stat)) {
    return;
  }
  cache.entries[dbPath] = { ...stat, rejectedMetricRecords, rows };
  cache.dirty = true;
};
