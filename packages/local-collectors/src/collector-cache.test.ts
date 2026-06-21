import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedDbRows, dbStat, readDbRowCache, storeDbRows, writeDbRowCache } from './collector-cache';
import type { LocalHistoryStorage } from './local-history';
import type { CollectorRow } from './rtk-enrichment';

const storageAt = (home: string) => ({ home }) as unknown as LocalHistoryStorage;

const row = (date: string): CollectorRow =>
  ({ date: new Date(date), endDate: null, name: 'fixture', harness: 'OpenCode' }) as unknown as CollectorRow;

describe('shared collector row cache', () => {
  test('round-trips rows by db path, reviving dates and serving fresh hits', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-cache-'));
    const dbPath = path.join(home, 'history.db');
    fs.writeFileSync(dbPath, 'db-bytes');
    const storage = storageAt(home);

    const cache = readDbRowCache(storage, 'opencode-db-cache.json', 1);
    expect(cache).toEqual({ dirty: false, entries: {}, version: 1 });

    const stat = dbStat(dbPath);
    expect(cachedDbRows(cache, dbPath, stat)).toBeNull(); // empty cache, no hit yet

    storeDbRows(cache, dbPath, stat, [row('2026-06-01T00:00:00.000Z')]);
    expect(cache?.dirty).toBe(true);
    expect(writeDbRowCache(storage, 'opencode-db-cache.json', 1, cache)).toBe(true);
    expect(cache?.dirty).toBe(false);

    const reloaded = readDbRowCache(storage, 'opencode-db-cache.json', 1);
    const revived = reloaded?.entries[dbPath]?.rows[0];
    expect(revived?.date).toBeInstanceOf(Date);
    expect(cachedDbRows(reloaded, dbPath, dbStat(dbPath))?.[0]?.name).toBe('fixture');
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
});
