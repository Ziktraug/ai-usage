import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeSessionFacts } from '@ai-usage/local-machine/claude-session-facts';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { serializeUsageRow } from '@ai-usage/report-core/report-data';
import { normalizeSessionLineage } from '@ai-usage/report-core/session-lineage';
import { projectSessionPage } from '@ai-usage/report-core/session-query';
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

const jsonl = (...records: unknown[]): string => `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

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

const launch = (parent: string, child: string, tool = 'Agent'): unknown[] => {
  const event = assistant(parent);
  const toolUseId = `launch-${parent}-${child}`;
  return [
    {
      ...event,
      message: {
        ...event.message,
        content: [{ type: 'tool_use', id: toolUseId, name: tool, input: { to: child, description: 'Review fixture' } }],
      },
    },
    {
      type: 'user',
      timestamp: event.timestamp,
      toolUseResult: { agentId: child },
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Launched' }] },
    },
  ];
};

const delegatedId = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const delegatedLaunches = (count: number) => {
  const event = assistant('synthetic-parent');
  return {
    ...event,
    message: {
      ...event.message,
      content: Array.from({ length: count }, (_, index) => ({
        type: 'tool_use',
        id: `synthetic-launch-${index}`,
        name: 'Bash',
        input: { command: `codex exec resume ${delegatedId(index)}` },
      })),
    },
  };
};

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
  test.each([1, 33])(
    'reads a delegation-bearing transcript once across cold and warm scans: %i launches',
    async (count) => {
      const { alpha, beta, reads, run } = await fixture();
      const transcript = delegatedLaunches(count);
      await writeFile(alpha, jsonl(transcript));
      const cold = await run();
      const parent = cold.rows.find((entry) => entry.source?.sourceSessionId === 'alpha');
      expect(parent?.source?.delegatedSessions).toEqual(
        Array.from({ length: Math.min(count, 32) }, (_, index) => ({
          harness: 'codex',
          sourceSessionId: delegatedId(index),
        })),
      );
      const facts = parseClaudeSessionFacts({ records: [transcript], repository: null, sourceSessionId: 'alpha' });
      expect(facts?.codexLaunchesTruncated).toBe(count > 32);
      if (count > 32) {
        expect(parent?.partial).toBe(true);
        expect(facts?.detailFacts.coverage.childDiscovery).toEqual({
          omittedCount: 1,
          reasons: ['child-budget'],
          status: 'partial',
        });
        expect(cold.warnings).toContainEqual(
          expect.objectContaining({ operation: 'claude.lineage-partial', affectedSessions: 1 }),
        );
      } else {
        expect(cold.warnings).toEqual([]);
      }
      expect(reads).toEqual(
        new Map([
          [alpha, 1],
          [beta, 1],
        ]),
      );
      expect(await run()).toEqual(cold);
      expect(await run()).toEqual(cold);
      expect(reads).toEqual(
        new Map([
          [alpha, 1],
          [beta, 1],
        ]),
      );
    },
  );

  test('invalidates version 16 once to recover delegation facts, then serves warm hits', async () => {
    const { alpha, beta, cachePath, reads, run } = await fixture();
    await writeFile(alpha, jsonl(delegatedLaunches(1)));
    const cold = await run();
    const cache = await readCache(cachePath);
    expect(cache.version).toBe(17);
    cache.version = 16;
    const cachedRows = record(cache.files[alpha]).rows;
    if (!Array.isArray(cachedRows)) {
      throw new Error('Expected cached synthetic rows');
    }
    for (const cachedRow of cachedRows) {
      record(record(cachedRow).source).delegatedSessions = undefined;
    }
    await writeFile(cachePath, JSON.stringify(cache));
    expect(await run()).toEqual(cold);
    expect(reads).toEqual(
      new Map([
        [alpha, 2],
        [beta, 2],
      ]),
    );
    expect((await readCache(cachePath)).version).toBe(17);
    expect(await run()).toEqual(cold);
    expect(reads).toEqual(
      new Map([
        [alpha, 2],
        [beta, 2],
      ]),
    );
  });

  test.each(['Agent', 'Task'])(
    'links an explicit %s launch on cold and warm scans without caching derived parents',
    async (tool) => {
      const { alpha, directory, cachePath, reads, run } = await fixture();
      const child = path.join(directory, 'agent-child.jsonl');
      await writeFile(alpha, jsonl(...launch('alpha', 'child', tool)));
      await writeFile(child, jsonl(assistant('child')));
      const cold = await run();
      expect(cold.rows.find((row) => row.source?.sourceSessionId === 'agent-child')?.source).toMatchObject({
        harnessKey: 'claude',
        parentSourceSessionId: 'alpha',
      });
      expect(cold.warnings).toEqual([]);
      const serialized = normalizeSessionLineage(cold.rows).map(serializeUsageRow);
      expect(serialized.find((row) => row.source?.sourceSessionId === 'agent-child')).toMatchObject({
        origin: 'subagent',
        subagent: true,
        source: { parentSourceSessionId: 'alpha', rootSourceSessionId: 'alpha' },
      });
      const page = projectSessionPage(serialized, {
        cursor: null,
        filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
        pageSize: 10,
        range: { from: null, to: null },
        revision: 'collector-lineage-fixture',
        sort: [{ desc: true, id: 'date' }],
      });
      expect(page).toMatchObject({ itemCount: 2, sessionCount: 3 });
      expect(page.items.find((item) => item.row.source?.sourceSessionId === 'alpha')?.row.campaignTotalCount).toBe(2);
      const cache = await readCache(cachePath);
      expect(record(cache.files[alpha]).declaredChildSourceSessionIds).toEqual(['agent-child']);
      expect(record(cache.files[child]).rows).toEqual([
        expect.objectContaining({ source: expect.not.objectContaining({ parentSourceSessionId: 'alpha' }) }),
      ]);
      reads.clear();
      expect(await run()).toEqual(cold);
      expect(reads.size).toBe(0);

      await rm(alpha);
      const orphan = await run();
      expect(
        orphan.rows.find((row) => row.source?.sourceSessionId === 'agent-child')?.source?.parentSourceSessionId,
      ).toBeUndefined();
      expect(reads.size).toBe(0);
    },
  );

  test('invalidates version 15 entries to recover previously dropped launches', async () => {
    const { alpha, beta, directory, cachePath, reads, run } = await fixture();
    const child = path.join(directory, 'agent-child.jsonl');
    await writeFile(alpha, jsonl(...launch('alpha', 'child')));
    await writeFile(child, jsonl(assistant('child')));
    const cold = await run();
    const cache = await readCache(cachePath);
    cache.version = 15;
    await writeFile(cachePath, JSON.stringify(cache));
    reads.clear();
    expect(await run()).toEqual(cold);
    expect([...reads.keys()].sort()).toEqual([alpha, beta, child].sort());
    expect((await readCache(cachePath)).version).toBe(17);
  });

  test('keeps competing declarations unresolved on cold and warm scans, then rechecks the remaining evidence', async () => {
    const { alpha, beta, directory, reads, run } = await fixture();
    await writeFile(alpha, jsonl(...launch('alpha', 'child')));
    await writeFile(beta, jsonl(...launch('beta', 'child')));
    await writeFile(path.join(directory, 'agent-child.jsonl'), jsonl(assistant('child')));
    const cold = await run();
    expect(
      cold.rows.find((row) => row.source?.sourceSessionId === 'agent-child')?.source?.parentSourceSessionId,
    ).toBeUndefined();
    expect(cold.warnings).toEqual([
      expect.objectContaining({ operation: 'claude.lineage-conflict', affectedSessions: 1 }),
    ]);
    reads.clear();
    expect(await run()).toEqual(cold);
    expect(reads.size).toBe(0);
    await rm(beta);
    const resolved = await run();
    expect(
      resolved.rows.find((row) => row.source?.sourceSessionId === 'agent-child')?.source?.parentSourceSessionId,
    ).toBe('alpha');
    expect(resolved.warnings).toEqual([]);
    expect(reads.size).toBe(0);
  });

  test('preserves a direct parent when a different session claims the launch and reports a subsequently missing parent', async () => {
    const { alpha, beta, directory, reads, run } = await fixture();
    await writeFile(alpha, jsonl(...launch('alpha', 'child')));
    await writeFile(path.join(directory, 'agent-child.jsonl'), jsonl({ ...assistant('child'), sessionId: 'beta' }));
    const cold = await run();
    expect(cold.rows.find((row) => row.source?.sourceSessionId === 'agent-child')?.source?.parentSourceSessionId).toBe(
      'beta',
    );
    expect(cold.warnings).toEqual([
      expect.objectContaining({ operation: 'claude.lineage-conflict', affectedSessions: 1 }),
    ]);
    reads.clear();
    expect(await run()).toEqual(cold);
    expect(reads.size).toBe(0);
    await rm(beta);
    const missing = await run();
    expect(
      missing.rows.find((row) => row.source?.sourceSessionId === 'agent-child')?.source?.parentSourceSessionId,
    ).toBe('beta');
    expect(missing.warnings.map((warning) => warning.operation)).toEqual([
      'claude.lineage-unresolved',
      'claude.lineage-conflict',
    ]);
    expect(await run()).toEqual(missing);
    expect(reads.size).toBe(0);
  });

  test('reports a missing declared child until it is collected, reusing the parent cache', async () => {
    const { alpha, directory, reads, run } = await fixture();
    await writeFile(alpha, jsonl(...launch('alpha', 'child')));
    const missing = await run();
    expect(missing.warnings).toEqual([
      expect.objectContaining({ operation: 'claude.lineage-unresolved', affectedSessions: 1 }),
    ]);
    reads.clear();
    expect(await run()).toEqual(missing);
    expect(reads.size).toBe(0);
    const child = path.join(directory, 'agent-child.jsonl');
    await writeFile(child, jsonl(assistant('child')));
    const resolved = await run();
    expect(
      resolved.rows.find((row) => row.source?.sourceSessionId === 'agent-child')?.source?.parentSourceSessionId,
    ).toBe('alpha');
    expect(resolved.warnings).toEqual([]);
    expect(reads).toEqual(new Map([[child, 1]]));
  });

  test('keeps incomplete launch-result coverage visible on warm scans', async () => {
    const { alpha, reads, run } = await fixture();
    await writeFile(alpha, jsonl(launch('alpha', 'child')[0]));
    const cold = await run();
    expect(cold.warnings).toEqual([
      expect.objectContaining({ operation: 'claude.lineage-partial', affectedSessions: 1 }),
    ]);
    reads.clear();
    expect(await run()).toEqual(cold);
    expect(reads.size).toBe(0);
  });

  test('does not infer parentage from a SendMessage recipient or coincident timestamps and titles', async () => {
    const { alpha, directory, reads, run } = await fixture();
    await writeFile(alpha, jsonl(...launch('same-title', 'child', 'SendMessage')));
    await writeFile(path.join(directory, 'agent-child.jsonl'), jsonl(assistant('same-title')));
    const cold = await run();
    expect(
      cold.rows.find((row) => row.source?.sourceSessionId === 'agent-child')?.source?.parentSourceSessionId,
    ).toBeUndefined();
    expect(cold.warnings).toEqual([]);
    reads.clear();
    expect(await run()).toEqual(cold);
    expect(reads.size).toBe(0);
  });

  test('rejects cyclic declarations and duplicate session identities', async () => {
    const { directory, reads, run } = await fixture();
    await writeFile(path.join(directory, 'agent-left.jsonl'), jsonl(...launch('left', 'right')));
    await writeFile(path.join(directory, 'agent-right.jsonl'), jsonl(...launch('right', 'left')));
    const cold = await run();
    expect(cold.rows.filter((row) => row.subagent).every((row) => !row.source?.parentSourceSessionId)).toBe(true);
    expect(cold.warnings).toEqual([
      expect.objectContaining({ operation: 'claude.lineage-conflict', affectedSessions: 2 }),
    ]);
    reads.clear();
    expect(await run()).toEqual(cold);
    expect(reads.size).toBe(0);
    const duplicateDirectory = path.join(directory, 'duplicate');
    await mkdir(duplicateDirectory);
    await writeFile(path.join(duplicateDirectory, 'agent-right.jsonl'), jsonl(assistant('duplicate')));
    const duplicate = await run();
    expect(
      duplicate.rows
        .filter((row) => row.source?.sourceSessionId === 'agent-right')
        .every((row) => !row.source?.parentSourceSessionId),
    ).toBe(true);
    expect(duplicate.warnings.some((warning) => warning.operation === 'claude.lineage-conflict')).toBe(true);
  });

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
    expect(cache.version).toBe(17);
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

  test('re-parses cached transcripts whose project origin repository changed', async () => {
    const { alpha, beta, directory, home, reads, run } = await fixture();
    const project = path.join(home, 'project');
    const gitConfig = path.join(project, '.git', 'config');
    await mkdir(path.dirname(gitConfig), { recursive: true });
    const origin = (url: string) => writeFile(gitConfig, `[remote "origin"]\n\turl = ${url}\n`);
    await origin('https://github.com/acme/before.git');
    const inProject = path.join(directory, 'in-project.jsonl');
    await writeFile(inProject, jsonl({ ...assistant('in-project'), cwd: project }));
    const repositoryOf = (result: Awaited<ReturnType<typeof run>>) =>
      result.rows.find((row) => row.source?.sourceSessionId === 'in-project')?.source?.vcs?.repository?.ownerPath;

    expect(repositoryOf(await run())).toBe('acme/before');
    reads.clear();
    expect(repositoryOf(await run())).toBe('acme/before');
    expect(reads.size).toBe(0);

    await origin('https://github.com/acme/after.git');
    const moved = await run();
    expect(repositoryOf(moved)).toBe('acme/after');
    expect(reads).toEqual(new Map([[inProject, 1]]));
    expect(reads.has(alpha) || reads.has(beta)).toBe(false);
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

  test('ignores version 14 caches and rewrites them as version 17 after a full parse', async () => {
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
    expect(cache.version).toBe(17);
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
    { field: 'declaredChildSourceSessionIds', value: [null] },
    { field: 'lineageIncomplete', value: null },
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
