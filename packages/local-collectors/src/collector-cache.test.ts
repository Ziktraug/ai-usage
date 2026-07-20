import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_USAGE_MODEL_SEGMENTS } from '@ai-usage/report-core/usage-row';
import {
  cachedDbCollection,
  cachedDbRows,
  dbStat,
  readDbRowCache,
  reviveCollectorRowsResult,
  storeDbRows,
  writeDbRowCache,
} from './collector-cache';
import type { LocalHistoryStorage } from './local-history';
import type { CollectorRow } from './rtk-enrichment';

const storageAt = (home: string) => ({ home }) as unknown as LocalHistoryStorage;

const row = (date: string): CollectorRow => ({
  calls: 1,
  costActual: 0,
  costApprox: 0,
  costKnown: true,
  date: new Date(date),
  durationMs: null,
  endDate: null,
  harness: 'OpenCode',
  linesAdded: null,
  linesDeleted: null,
  model: 'fixture-model',
  name: 'fixture',
  project: 'fixture-project',
  provider: 'fixture-provider',
  tokCr: 0,
  tokCw: 0,
  tokIn: 1,
  tokOut: 0,
  tools: 0,
  turns: 1,
});

describe('shared collector row cache', () => {
  test('revives strict bounded VCS context and rejects unsafe or unknown source fields', () => {
    const vcs = {
      branches: [],
      headCommit: null,
      partial: false,
      pullRequests: [],
      repository: {
        host: 'github.com',
        ownerPath: 'example/project',
        provenance: 'local-derived' as const,
        webUrl: 'https://github.com/example/project',
      },
    };
    const valid = { ...row('2026-06-01T00:00:00.000Z'), source: { harnessKey: 'opencode', sourceSessionId: 'a', vcs } };

    expect(reviveCollectorRowsResult([valid]).rows[0]?.source?.vcs).toEqual(vcs);
    expect(
      reviveCollectorRowsResult([
        {
          ...valid,
          source: { ...valid.source, vcs: { ...vcs, repository: { ...vcs.repository, webUrl: 'file:///x' } } },
        },
        { ...valid, source: { ...valid.source, credentials: 'secret' } },
      ]),
    ).toMatchObject({ rejectedMetricRecords: 2, rows: [], valid: true });
  });

  test('round-trips rows by db path, reviving dates and serving fresh hits', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-cache-'));
    const dbPath = path.join(home, 'history.db');
    fs.writeFileSync(dbPath, 'db-bytes');
    const storage = storageAt(home);

    const cache = readDbRowCache(storage, 'opencode-db-cache.json', 1);
    expect(cache).toEqual({ dirty: false, entries: {}, version: 1 });

    const stat = dbStat(dbPath);
    expect(cachedDbRows(cache, dbPath, stat)).toBeNull(); // empty cache, no hit yet

    storeDbRows(cache, dbPath, stat, [row('2026-06-01T00:00:00.000Z')], 2);
    expect(cache?.dirty).toBe(true);
    expect(writeDbRowCache(storage, 'opencode-db-cache.json', 1, cache)).toBe(true);
    expect(cache?.dirty).toBe(false);

    const reloaded = readDbRowCache(storage, 'opencode-db-cache.json', 1);
    const revived = reloaded?.entries[dbPath]?.rows[0];
    expect(revived?.date).toBeInstanceOf(Date);
    expect(cachedDbRows(reloaded, dbPath, dbStat(dbPath))?.[0]?.name).toBe('fixture');
    expect(cachedDbCollection(reloaded, dbPath, dbStat(dbPath))?.rejectedMetricRecords).toBe(2);
    if (process.platform !== 'win32') {
      const cachePath = path.join(home, '.config', 'ai-usage', 'opencode-db-cache.json');
      expect(fs.lstatSync(cachePath).mode % 0o1000).toBe(0o600);
      expect(fs.lstatSync(path.dirname(cachePath)).mode % 0o1000).toBe(0o700);
    }
  });

  test('replaces a multiply-linked disposable cache without changing its alias', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-cache-'));
    const storage = storageAt(home);
    const cachePath = path.join(home, '.config', 'ai-usage', 'cursor-db-cache.json');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, '{"version":1,"entries":{}}\n', { mode: 0o644 });
    const aliasPath = path.join(home, 'cache-alias.json');
    fs.linkSync(cachePath, aliasPath);

    const cache = readDbRowCache(storage, 'cursor-db-cache.json', 1);
    expect(cache?.entries).toEqual({});
    if (cache) {
      cache.dirty = true;
    }
    expect(writeDbRowCache(storage, 'cursor-db-cache.json', 1, cache)).toBe(true);
    expect(fs.lstatSync(cachePath).nlink).toBe(1);
    expect(fs.readFileSync(aliasPath, 'utf8')).toBe('{"version":1,"entries":{}}\n');
    if (process.platform !== 'win32') {
      expect(fs.lstatSync(aliasPath).mode % 0o1000).toBe(0o644);
      expect(fs.lstatSync(cachePath).mode % 0o1000).toBe(0o600);
    }
  });

  test('discards entries written under a different cache version', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-cache-'));
    const dbPath = path.join(home, 'history.db');
    fs.writeFileSync(dbPath, 'db-bytes');
    const storage = storageAt(home);

    const cache = readDbRowCache(storage, 'cursor-db-cache.json', 1);
    storeDbRows(cache, dbPath, dbStat(dbPath), [row('2026-06-01T00:00:00.000Z')]);
    writeDbRowCache(storage, 'cursor-db-cache.json', 1, cache);

    const bumped = readDbRowCache(storage, 'cursor-db-cache.json', 2);
    expect(bumped?.entries).toEqual({});
  });

  test('drops cached rows with invalid metrics or dates', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-cache-'));
    const dbPath = path.join(home, 'history.db');
    fs.writeFileSync(dbPath, 'db-bytes');
    const storage = storageAt(home);
    const cache = readDbRowCache(storage, 'cursor-db-cache.json', 1);
    storeDbRows(cache, dbPath, dbStat(dbPath), [row('2026-06-01T00:00:00.000Z')]);
    writeDbRowCache(storage, 'cursor-db-cache.json', 1, cache);
    const cachePath = path.join(home, '.config', 'ai-usage', 'cursor-db-cache.json');
    const serialized = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      entries: Record<string, { rows: Record<string, unknown>[] }>;
    };
    const cachedRow = serialized.entries[dbPath]?.rows[0];
    if (!cachedRow) {
      throw new Error('Expected cached fixture row');
    }
    cachedRow.tokIn = -1;
    fs.writeFileSync(cachePath, JSON.stringify(serialized), { mode: 0o600 });
    const reloaded = readDbRowCache(storage, 'cursor-db-cache.json', 1);
    expect(reloaded?.entries[dbPath]).toBeUndefined();
    expect(cachedDbCollection(reloaded, dbPath, dbStat(dbPath))).toBeNull();
  });

  test('drops cached rows whose model segments do not reconcile with row totals', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-cache-'));
    const dbPath = path.join(home, 'history.db');
    fs.writeFileSync(dbPath, 'db-bytes');
    const storage = storageAt(home);
    const cache = readDbRowCache(storage, 'cursor-db-cache.json', 1);
    storeDbRows(cache, dbPath, dbStat(dbPath), [row('2026-06-01T00:00:00.000Z')]);
    writeDbRowCache(storage, 'cursor-db-cache.json', 1, cache);
    const cachePath = path.join(home, '.config', 'ai-usage', 'cursor-db-cache.json');
    const serialized = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      entries: Record<string, { rows: Record<string, unknown>[] }>;
    };
    const cachedRow = serialized.entries[dbPath]?.rows[0];
    if (!cachedRow) {
      throw new Error('Expected cached fixture row');
    }
    cachedRow.modelSegments = [
      {
        model: 'fixture-model',
        tokCr: 0,
        tokCw: 0,
        tokIn: 2,
        tokOut: 0,
        costApprox: 0,
        costKnown: true,
      },
    ];
    fs.writeFileSync(cachePath, JSON.stringify(serialized), { mode: 0o600 });

    const reloaded = readDbRowCache(storage, 'cursor-db-cache.json', 1);

    expect(reloaded?.entries[dbPath]).toBeUndefined();
    expect(cachedDbCollection(reloaded, dbPath, dbStat(dbPath))).toBeNull();
  });

  test('rejects cached model attribution beyond the shared limit or without its dominant model', () => {
    const baseRow = row('2026-06-01T00:00:00.000Z');
    const excessiveSegments = Array.from({ length: MAX_USAGE_MODEL_SEGMENTS + 1 }, (_, index) => ({
      costApprox: 1,
      costKnown: true,
      model: `model-${index}`,
      tokCr: 0,
      tokCw: 0,
      tokIn: 1,
      tokOut: 0,
    }));
    const excessive = {
      ...baseRow,
      costApprox: MAX_USAGE_MODEL_SEGMENTS + 1,
      model: 'model-0',
      modelSegments: excessiveSegments,
      models: excessiveSegments.map((segment) => segment.model),
      tokIn: MAX_USAGE_MODEL_SEGMENTS + 1,
    };
    const incoherentSegments = [
      {
        costApprox: 0,
        costKnown: true,
        model: 'model-a',
        tokCr: 0,
        tokCw: 0,
        tokIn: 1,
        tokOut: 0,
      },
      {
        costApprox: 0,
        costKnown: true,
        model: 'model-b',
        tokCr: 0,
        tokCw: 0,
        tokIn: 0,
        tokOut: 0,
      },
    ];
    const incoherent = {
      ...baseRow,
      model: 'missing-model',
      modelSegments: incoherentSegments,
      models: ['model-a', 'model-b'],
    };

    expect(reviveCollectorRowsResult([excessive, incoherent])).toMatchObject({
      rejectedMetricRecords: 2,
      rows: [],
      valid: true,
    });
  });

  test('invalidates on WAL changes but ignores SHM churn', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-cache-'));
    const dbPath = path.join(home, 'history.db');
    fs.writeFileSync(dbPath, 'db-bytes');
    fs.writeFileSync(`${dbPath}-wal`, 'wal-one');
    const storage = storageAt(home);
    const cache = readDbRowCache(storage, 'cursor-db-cache.json', 3);
    storeDbRows(cache, dbPath, dbStat(dbPath), [row('2026-06-01T00:00:00.000Z')]);
    writeDbRowCache(storage, 'cursor-db-cache.json', 3, cache);
    const reloaded = readDbRowCache(storage, 'cursor-db-cache.json', 3);
    fs.writeFileSync(`${dbPath}-shm`, 'coordination');
    expect(cachedDbRows(reloaded, dbPath, dbStat(dbPath))).toHaveLength(1);
    fs.appendFileSync(`${dbPath}-wal`, '-changed');
    expect(cachedDbRows(reloaded, dbPath, dbStat(dbPath))).toBeNull();
  });
});
