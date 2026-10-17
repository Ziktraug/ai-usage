import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { MAX_SKILL_OBSERVATIONS_PER_SESSION } from '@ai-usage/report-core/skill-observation';
import { Effect } from 'effect';
import { collectorCachePath } from './collector-cache';
import { collectClaudeResult } from './collectors/claude';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { force: true, recursive: true });
  }
});

const jsonl = (...records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

const skillCall = (id: string) => ({ type: 'tool_use', id, name: 'Skill', input: { skill: 'review' } });

const assistant = (id: string, inputTokens = 10) => ({
  type: 'assistant',
  timestamp: '2026-04-25T08:00:00.000Z',
  requestId: id,
  message: {
    id,
    model: 'claude-sonnet-4-6',
    content: [skillCall(`skill-${id}`)],
    usage: { input_tokens: inputTokens, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error('Expected a cache object');
  }
  return value;
};

const readCache = async (
  cachePath: string,
): Promise<{ files: Record<string, unknown>; provider: unknown; version: unknown }> => {
  const value: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
  const cache = record(value);
  return { files: record(cache.files), provider: cache.provider, version: cache.version };
};

const fixture = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-claude-cache-'));
  homes.push(home);
  const directory = path.join(home, '.claude', 'projects', 'fixture');
  await mkdir(directory, { recursive: true });
  const alpha = path.join(directory, 'alpha.jsonl');
  const beta = path.join(directory, 'beta.jsonl');
  await writeFile(alpha, jsonl(assistant('alpha')));
  await writeFile(beta, jsonl(assistant('beta', 20)));
  const baseStorage = createLocalHistoryStorage(home);
  const reads = new Map<string, number>();
  const storage: LocalHistoryStorage = {
    ...baseStorage,
    readLines: (filePath, visit, limits) =>
      Effect.suspend(() => {
        reads.set(filePath, (reads.get(filePath) ?? 0) + 1);
        return baseStorage.readLines(filePath, visit, limits);
      }),
  };
  const run = (selectedStorage = storage) =>
    Effect.runPromise(collectClaudeResult.pipe(Effect.provideService(LocalHistoryStorage, selectedStorage)));
  return {
    alpha,
    beta,
    cachePath: collectorCachePath(storage, 'claude-cache.json'),
    directory,
    home,
    reads,
    run,
    storage,
  };
};

describe('Claude per-file collector cache', () => {
  test('parses every transcript on a cold run and writes one entry per file', async () => {
    const { alpha, beta, cachePath, directory, reads, run } = await fixture();
    const empty = path.join(directory, 'empty.jsonl');
    await writeFile(empty, '');
    const result = await run();
    expect(reads).toEqual(
      new Map([
        [alpha, 1],
        [beta, 1],
        [empty, 1],
      ]),
    );
    expect(result.rows).toHaveLength(2);
    const cache = await readCache(cachePath);
    expect(cache.version).toBe(15);
    expect(cache.provider).toBe('Claude sub');
    expect(Object.keys(cache.files)).toEqual([...reads.keys()]);
    expect(result.rows.map((row) => row.source?.sourceSessionId)).toEqual(
      [...reads.keys()].filter((filePath) => filePath !== empty).map((filePath) => path.basename(filePath, '.jsonl')),
    );
    for (const filePath of [alpha, beta, empty]) {
      const metadata = await stat(filePath);
      expect(cache.files[filePath]).toMatchObject({
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
        observationsTruncated: false,
        oversizedLines: 0,
        rejectedMetricRecords: 0,
        rejectedObservations: 0,
      });
    }
    expect(record(cache.files[empty]).rows).toEqual([]);
  });

  test('reuses unchanged transcripts and preserves results without rewriting the cache', async () => {
    const { cachePath, home, reads, run } = await fixture();
    const historyPath = path.join(home, '.claude', 'history.jsonl');
    await writeFile(
      historyPath,
      jsonl({ sessionId: 'fallback', display: 'Build the report', timestamp: 1_750_000_000_000 }),
    );
    const cold = await run();
    const before = await stat(cachePath);
    reads.clear();
    const warm = await run();
    expect(reads).toEqual(new Map([[historyPath, 1]]));
    expect(warm).toEqual(cold);
    expect(warm.observations).toHaveLength(2);
    expect(warm.rows).toHaveLength(3);
    const after = await stat(cachePath);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
  });

  test('yields to the host between parsed files without yielding for cache hits', async () => {
    const { alpha, run, storage } = await fixture();
    let parsedFiles = 0;
    let hostRan = false;
    const observingStorage: LocalHistoryStorage = {
      ...storage,
      readLines: (filePath, visit, limits) =>
        Effect.suspend(() => {
          parsedFiles++;
          if (parsedFiles === 1) {
            setImmediate(() => {
              hostRan = true;
            });
          } else {
            expect(hostRan).toBe(true);
          }
          return storage.readLines(filePath, visit, limits);
        }),
    };
    const cold = await run(observingStorage);
    expect(parsedFiles).toBe(2);
    const collect = collectClaudeResult.pipe(Effect.provideService(LocalHistoryStorage, storage));
    expect(Effect.runSync(collect)).toEqual(cold);
    // One miss among hits does not require a host yield either.
    await appendFile(alpha, '\n');
    expect(Effect.runSync(collect)).toEqual(cold);
  });

  test('appending to one transcript re-reads only that file and changes only its row', async () => {
    const { alpha, reads, run } = await fixture();
    const cold = await run();
    const before = await stat(alpha);
    await appendFile(alpha, jsonl(assistant('alpha-second', 30)));
    await utimes(alpha, new Date(), new Date(before.mtimeMs + 2000));
    reads.clear();
    const updated = await run();
    expect(reads).toEqual(new Map([[alpha, 1]]));
    const previousAlpha = cold.rows.find((row) => row.source?.sourceSessionId === 'alpha');
    const updatedAlpha = updated.rows.find((row) => row.source?.sourceSessionId === 'alpha');
    expect(updatedAlpha).not.toEqual(previousAlpha);
    expect(updatedAlpha?.tokIn).toBe(40);
    expect(updated.rows.find((row) => row.source?.sourceSessionId === 'beta')).toEqual(
      cold.rows.find((row) => row.source?.sourceSessionId === 'beta'),
    );
  });

  test('deleting a transcript drops its row and prunes its cache entry', async () => {
    const { alpha, beta, cachePath, reads, run } = await fixture();
    const cold = await run();
    await rm(alpha);
    reads.clear();
    const updated = await run();
    expect(reads.size).toBe(0);
    expect(updated.rows).toEqual(cold.rows.filter((row) => row.source?.sourceSessionId === 'beta'));
    expect(updated.observations).toEqual(cold.observations.filter((observation) => observation.sessionId === 'beta'));
    expect(Object.keys((await readCache(cachePath)).files)).toEqual([beta]);
  });

  test('ignores version 14 caches and rewrites them as version 15 after a full parse', async () => {
    const { alpha, beta, cachePath, reads, run } = await fixture();
    const cold = await run();
    await writeFile(
      cachePath,
      JSON.stringify({ version: 14, fingerprintKey: 'legacy', rows: cold.rows, observations: [] }),
    );
    reads.clear();
    expect(await run()).toEqual(cold);
    expect(reads).toEqual(
      new Map([
        [alpha, 1],
        [beta, 1],
      ]),
    );
    const cache = await readCache(cachePath);
    expect(cache.version).toBe(15);
    expect(Object.keys(cache.files)).toEqual([...reads.keys()]);
  });

  test('re-parses all transcripts when the global pricing provider changes', async () => {
    const { alpha, beta, cachePath, home, reads, run } = await fixture();
    const subscription = await run();
    expect(subscription.rows.every((row) => row.provider === 'Claude sub' && row.costActual === 0)).toBe(true);
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ hasApiKey: true }));
    reads.clear();
    const api = await run();
    expect(reads).toEqual(
      new Map([
        [alpha, 1],
        [beta, 1],
      ]),
    );
    expect(
      api.rows.every((row) => row.provider === 'Claude API' && row.costActual === row.costApprox && row.costApprox > 0),
    ).toBe(true);
    expect((await readCache(cachePath)).provider).toBe('Claude API');
    reads.clear();
    expect(await run()).toEqual(api);
    expect(reads.size).toBe(0);
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ hasApiKey: false }));
    expect(await run()).toEqual(subscription);
    expect(reads).toEqual(
      new Map([
        [alpha, 1],
        [beta, 1],
      ]),
    );
  });

  test('refreshes prompt-history fallbacks while every transcript remains a cache hit', async () => {
    const { home, reads, run } = await fixture();
    const cold = await run();
    const historyPath = path.join(home, '.claude', 'history.jsonl');
    await writeFile(
      historyPath,
      jsonl({ sessionId: 'fallback', display: 'Build the report', timestamp: 1_750_000_000_000 }),
    );
    reads.clear();
    const updated = await run();
    expect(reads).toEqual(new Map([[historyPath, 1]]));
    expect(updated.rows.slice(0, 2)).toEqual(cold.rows);
    expect(updated.rows[2]?.source?.sourceSessionId).toBe('fallback');
    expect(updated.rows[2]?.usageUnavailable).toBe(true);
  });

  test.each([
    { field: 'rows', value: [{}] },
    { field: 'observations', value: [{}] },
    { field: 'rejectedMetricRecords', value: -1 },
    { field: 'rejectedObservations', value: -1 },
    { field: 'oversizedLines', value: -1 },
    { field: 'observationsTruncated', value: 'false' },
    { field: 'size', value: -1 },
    { field: 'mtimeMs', value: 'invalid' },
  ])('re-parses only the entry with invalid $field', async ({ field, value }) => {
    const { alpha, cachePath, reads, run } = await fixture();
    const cold = await run();
    const cache = await readCache(cachePath);
    cache.files[alpha] = { ...record(cache.files[alpha]), [field]: value };
    await writeFile(cachePath, JSON.stringify(cache));
    reads.clear();
    expect(await run()).toEqual(cold);
    expect(reads).toEqual(new Map([[alpha, 1]]));
  });

  test('caches observations even when their transcript has no usage row', async () => {
    const { cachePath, directory, reads, run } = await fixture();
    const observationOnly = path.join(directory, 'observation-only.jsonl');
    await writeFile(
      observationOnly,
      jsonl({
        type: 'system',
        timestamp: '2026-04-25T08:00:00.000Z',
        message: { content: [skillCall('standalone-skill')] },
      }),
    );
    const cold = await run();
    expect(cold.rows).toHaveLength(2);
    expect(cold.observations).toHaveLength(3);
    const entry = record((await readCache(cachePath)).files[observationOnly]);
    expect(entry.rows).toEqual([]);
    expect(entry.observations).toHaveLength(1);
    reads.clear();
    expect(await run()).toEqual(cold);
    expect(reads.size).toBe(0);
  });

  test('preserves rejection, truncation and oversized-line state across warm and mixed scans', async () => {
    const { alpha, beta, cachePath, reads, run, storage } = await fixture();
    await appendFile(
      alpha,
      `${jsonl({
        ...assistant('invalid-metric'),
        message: { id: 'invalid-metric', usage: { input_tokens: -1 } },
      })}{incomplete\n${'x'.repeat(1025)}\n`,
    );
    const betaRecord = assistant('beta');
    await writeFile(
      beta,
      jsonl({
        ...betaRecord,
        message: {
          ...betaRecord.message,
          content: Array.from({ length: MAX_SKILL_OBSERVATIONS_PER_SESSION + 1 }, (_, index) =>
            skillCall(`skill-${index}`),
          ),
        },
      }),
    );
    const boundedStorage: LocalHistoryStorage = {
      ...storage,
      readLines: (filePath, visit, limits) =>
        storage.readLines(filePath, visit, filePath === alpha ? { ...limits, maxLineBytes: 1024 } : limits),
    };
    const cold = await run(boundedStorage);
    expect(cold.observationCompleteness.invocation).toEqual({ rejected: 1, truncated: true });
    expect(cold.warnings).toHaveLength(4);
    const cache = await readCache(cachePath);
    expect(cache.files[alpha]).toMatchObject({
      rejectedMetricRecords: 1,
      rejectedObservations: 1,
      oversizedLines: 1,
      observationsTruncated: false,
    });
    expect(record(cache.files[beta]).observationsTruncated).toBe(true);
    reads.clear();
    expect(await run(boundedStorage)).toEqual(cold);
    expect(reads.size).toBe(0);
    await appendFile(alpha, '{another-incomplete\n');
    const metadata = await stat(alpha);
    await utimes(alpha, new Date(), new Date(metadata.mtimeMs + 2000));
    const mixed = await run(boundedStorage);
    expect(reads).toEqual(new Map([[alpha, 1]]));
    expect(mixed.observationCompleteness.invocation).toEqual({ rejected: 2, truncated: true });
    await rm(cachePath);
    expect(await run(boundedStorage)).toEqual(mixed);
  });
});
