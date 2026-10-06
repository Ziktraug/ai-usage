import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readClaudeSessionAnalysis } from '@ai-usage/local-machine/claude-session-analysis';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL, seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { serializeUsageRow } from '@ai-usage/report-core/report-data';
import {
  compareSessionProjectionFacts,
  parseSessionDetail,
  sessionProjectionFactsForSerializedRow,
} from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { collectClaude } from './collectors/claude';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { force: true, recursive: true });
  }
});

const makeHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-claude-detail-'));
  homes.push(home);
  return home;
};

const run = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>, home: string) =>
  Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home))));

describe('readClaudeSessionAnalysis', () => {
  test('recollects previously unpriced Sonnet 5.5 rows from an older cost cache', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['claude'] });
    const transcript = Bun.file(fixture.paths.claudeRootTranscript);
    await Bun.write(
      fixture.paths.claudeRootTranscript,
      (await transcript.text())
        .replaceAll('claude-sonnet-4-6', 'claude-sonnet-5-5')
        .replaceAll('claude-opus-4-1', 'claude-sonnet-5-5'),
    );
    await run(collectClaude, home);

    const cachePath = path.join(home, '.config', 'ai-usage', 'claude-cache.json');
    const cache: {
      version: number;
      rows: {
        costApprox: number;
        costKnown: boolean;
        modelSegments?: { costApprox: number; costKnown: boolean }[];
      }[];
    } = await Bun.file(cachePath).json();
    cache.version = 11;
    for (const row of cache.rows) {
      row.costApprox = 0;
      row.costKnown = false;
      for (const segment of row.modelSegments ?? []) {
        segment.costApprox = 0;
        segment.costKnown = false;
      }
    }
    await Bun.write(cachePath, JSON.stringify(cache));

    // No transcript changes: a fingerprint cache hit must not retain the old zero cost.
    const row = (await run(collectClaude, home)).find(({ source }) => source?.sourceSessionId === fixture.ids.claude);
    expect(row?.model).toBe('claude-sonnet-5-5');
    expect(row?.costKnown).toBe(true);
    expect(row?.costApprox).toBeCloseTo(0.000_667, 10);
    expect(row?.modelSegments?.[0]?.costKnown).toBe(true);
  });

  test('reads one bounded transcript and returns the same semantic facts without caching prompts', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['claude'] });
    const analysis = await run(readClaudeSessionAnalysis(fixture.ids.claude), home);

    expect(analysis?.detail.sourceSessionId).toBe(fixture.ids.claude);
    expect(analysis?.detail.durationStatus).toBe('partial');
    expect(analysis?.detail.prompts.map(({ text }) => text)).toEqual([
      HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL,
      'Add the golden assertions',
    ]);
    expect(analysis?.projection).toMatchObject({ calls: 2, tools: 1, turns: 2 });
    expect(analysis?.projection.tokens).toEqual({ cacheRead: 35, cacheWrite: 12, input: 140, output: 35, total: 222 });
    expect(() => parseSessionDetail(JSON.parse(JSON.stringify(analysis?.detail)))).not.toThrow();
  });

  test('returns null for invalid and missing identities', async () => {
    const home = await makeHome();
    await seedHarnessHome(home, { harnesses: ['claude'] });
    expect(await run(readClaudeSessionAnalysis('../escape'), home)).toBeNull();
    expect(await run(readClaudeSessionAnalysis('missing-session'), home)).toBeNull();
  });

  test('surfaces a typed failure for a no-follow unsafe transcript', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['claude'] });
    const target = `${fixture.paths.claudeRootTranscript}.target`;
    await Bun.write(target, '{}\n');
    await rm(fixture.paths.claudeRootTranscript);
    await symlink(target, fixture.paths.claudeRootTranscript);

    const exit = await Effect.runPromiseExit(
      readClaudeSessionAnalysis(fixture.ids.claude).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
      ),
    );
    expect(exit._tag).toBe('Failure');
    expect(JSON.stringify(exit)).toContain('readClaudeSessionAnalysis.unsafeFile');
  });

  test('demonstrates report match, exact local divergence, and match after recollection', async () => {
    const home = await makeHome();
    const fixture = await seedHarnessHome(home, { harnesses: ['claude'] });
    const storage = createLocalHistoryStorage(home);
    const collect = () => Effect.runPromise(collectClaude.pipe(Effect.provideService(LocalHistoryStorage, storage)));
    const analyze = () =>
      Effect.runPromise(
        readClaudeSessionAnalysis(fixture.ids.claude).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
    const initialRow = (await collect()).find(({ source }) => source?.sourceSessionId === fixture.ids.claude);
    const initialAnalysis = await analyze();
    if (!(initialRow && initialAnalysis)) {
      throw new Error('Expected Claude row and analysis');
    }
    const { projectPath: _initialProjectPath, source: _initialSource, ...initialRowWithoutSource } = initialRow;
    const initialProjection = sessionProjectionFactsForSerializedRow(serializeUsageRow(initialRowWithoutSource));
    expect(compareSessionProjectionFacts(initialProjection, initialAnalysis.projection).status).toBe('matches-report');

    await appendFile(
      fixture.paths.claudeRootTranscript,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-01T08:04:40.000Z',
        uuid: 'claude-assistant-after-report',
        parentUuid: 'claude-user-2',
        requestId: 'claude-request-after-report',
        message: {
          id: 'claude-message-after-report',
          model: 'claude-opus-4-1',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n`,
    );
    const changedAnalysis = await analyze();
    expect(changedAnalysis).not.toBeNull();
    expect(compareSessionProjectionFacts(initialProjection, changedAnalysis!.projection).status).toBe(
      'differs-from-report',
    );

    const updatedRow = (await collect()).find(({ source }) => source?.sourceSessionId === fixture.ids.claude);
    if (!updatedRow) {
      throw new Error('Expected recollected Claude row');
    }
    const { projectPath: _updatedProjectPath, source: _updatedSource, ...updatedRowWithoutSource } = updatedRow;
    const updatedProjection = sessionProjectionFactsForSerializedRow(serializeUsageRow(updatedRowWithoutSource));
    expect(compareSessionProjectionFacts(updatedProjection, changedAnalysis!.projection).status).toBe('matches-report');
  });
});
