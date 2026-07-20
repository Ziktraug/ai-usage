import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeUsageRow } from '@ai-usage/report-core/report-data';
import { sessionProjectionFactsForSerializedRow } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { collectOpenCodeResult } from './collectors/opencode';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';
import { readOpenCodeSessionAnalysis } from './opencode-history';
import { buildOpenCodeProjectionSummary, decodeOpenCodeMessageRow, openCodeParentKind } from './opencode-session-facts';
import { seedHarnessHome } from './test-fixtures/harness-home';

const temporaryHomes: string[] = [];

afterEach(async () => {
  for (const home of temporaryHomes.splice(0)) {
    await rm(home, { force: true, recursive: true });
  }
});

describe('OpenCode session facts', () => {
  test('owns token, model, cost, interval, and parent semantics', () => {
    const first = decodeOpenCodeMessageRow({
      cost: 1.25,
      id: 'assistant-1',
      modelID: 'gpt-5',
      parentID: 'human-1',
      providerID: 'openai',
      role: 'assistant',
      time: { completed: 200, created: 100 },
      tokens: { cache: { read: 4, write: 2 }, input: 10, output: 5, reasoning: 3 },
      variant: 'high',
    });
    const second = decodeOpenCodeMessageRow({
      cost: null,
      id: 'assistant-2',
      modelID: 'claude-sonnet-4-6',
      parentID: 'internal-1',
      providerID: 'anthropic',
      role: 'assistant',
      time: { created: 150 },
      tokens: { cache: { read: 1, write: 0 }, input: 7, output: 2, reasoning: 1 },
    });
    if (first.kind !== 'fact' || second.kind !== 'fact') {
      throw new Error('Expected valid OpenCode facts');
    }

    const summary = buildOpenCodeProjectionSummary([second.value, first.value]);

    expect(first.value.tokens).toEqual({ cacheRead: 4, cacheWrite: 2, input: 10, output: 8, total: 24 });
    expect(summary).toMatchObject({
      calls: 2,
      durationMs: 100,
      models: ['anthropic/claude-sonnet-4-6', 'openai/gpt-5'],
      partial: true,
      reportedCost: 1.25,
      reportedCostKnown: false,
      tokens: { cacheRead: 5, cacheWrite: 2, input: 17, output: 11, total: 35 },
    });
    expect(
      summary?.modelSegments.map(({ model, tokCr, tokCw, tokIn, tokOut }) => ({
        model,
        tokCr,
        tokCw,
        tokIn,
        tokOut,
      })),
    ).toEqual([
      { model: 'anthropic/claude-sonnet-4-6', tokCr: 1, tokCw: 0, tokIn: 7, tokOut: 3 },
      { model: 'openai/gpt-5', tokCr: 4, tokCw: 2, tokIn: 10, tokOut: 8 },
    ]);
    const users = new Set(['human-1', 'internal-1']);
    expect(openCodeParentKind('human-1', users, new Set(['human-1']))).toBe('human');
    expect(openCodeParentKind('internal-1', users, new Set(['human-1']))).toBe('internal');
    expect(openCodeParentKind('missing', users, new Set(['human-1']))).toBe('unresolved');
  });

  test('rejects invalid and overflowing metrics without producing NaN', () => {
    expect(decodeOpenCodeMessageRow({ role: 'assistant', tokens: { input: Number.NaN } })).toEqual({
      kind: 'invalid',
    });
    const overflow = decodeOpenCodeMessageRow({
      role: 'assistant',
      tokens: { input: Number.MAX_SAFE_INTEGER, output: 1 },
    });
    expect(overflow).toEqual({ kind: 'invalid' });
  });

  test('ignores assistant messages without an object token payload', () => {
    expect(decodeOpenCodeMessageRow({ role: 'assistant' })).toEqual({ kind: 'ignored' });
    expect(decodeOpenCodeMessageRow({ role: 'assistant', tokens: null })).toEqual({ kind: 'ignored' });
  });

  test('keeps report and detail projection facts identical for a real database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ai-usage-opencode-facts-'));
    temporaryHomes.push(home);
    const fixture = await seedHarnessHome(home, { harnesses: ['opencode'] });
    const storage = createLocalHistoryStorage(home);
    const run = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>): Promise<A> =>
      Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

    const collection = await run(collectOpenCodeResult);
    const analysis = await run(readOpenCodeSessionAnalysis(fixture.ids.opencode));
    const reportRow = collection.rows.find((row) => row.source?.sourceSessionId === fixture.ids.opencode);
    if (!(reportRow && analysis)) {
      throw new Error('Expected matching OpenCode report and detail rows');
    }
    const { projectPath: _projectPath, source: _source, ...rowWithoutSource } = reportRow;
    const reportProjection = sessionProjectionFactsForSerializedRow(serializeUsageRow(rowWithoutSource));
    const expectedProjection = {
      calls: 3,
      durationMs: 90_000,
      modelSegments: [
        {
          model: 'anthropic/claude-sonnet-4-6',
          tokens: { cacheRead: 6, cacheWrite: 1, input: 30, output: 10, total: 47 },
        },
        {
          model: 'openai/gpt-5',
          tokens: { cacheRead: 23, cacheWrite: 4, input: 60, output: 18, total: 105 },
        },
      ],
      partial: true,
      tokens: { cacheRead: 29, cacheWrite: 5, input: 90, output: 28, total: 152 },
      tools: 1,
      turns: 1,
    };

    expect(reportProjection).toEqual(expectedProjection);
    expect(analysis.projection).toEqual(expectedProjection);
    expect(analysis.detail.turns.map(({ model, promptIds }) => ({ model, promptIds }))).toEqual([
      { model: 'openai/gpt-5', promptIds: ['opencode-user-part'] },
      { model: 'anthropic/claude-sonnet-4-6', promptIds: [] },
      { model: 'openai/gpt-5', promptIds: [] },
    ]);
    expect(analysis.detail.turnsStatus).toBe('partial');
  });
});
