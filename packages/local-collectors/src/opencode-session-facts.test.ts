import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { readOpenCodeSessionAnalysis } from '@ai-usage/local-machine/opencode-session-analysis';
import {
  buildOpenCodeProjectionSummary,
  decodeOpenCodeMessageRow,
  decodeOpenCodeSkillPart,
  isOpenCodeForeignUsageProvider,
  openCodeParentKind,
  partitionOpenCodeUsageFacts,
} from '@ai-usage/local-machine/opencode-session-facts';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { seedOpenCodeV2Scenario } from '@ai-usage/local-machine/testing/opencode-v2-database';
import { serializeUsageRow } from '@ai-usage/report-core/report-data';
import { sessionProjectionFactsForSerializedRow } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { collectOpenCodeResult } from './collectors/opencode';

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

  test('decodes the session_v2 message shape: object model with variant, role supplied by the row type', () => {
    const decoded = decodeOpenCodeMessageRow({
      agent: 'build',
      cost: 0,
      finish: 'tool-calls',
      model: { id: 'gpt-6.1-sol', providerID: 'openai', variant: 'implementation' },
      role: 'assistant',
      time: { completed: 1_793_000_060_000, created: 1_793_000_000_000 },
      tokens: { cache: { read: 30, write: 4 }, input: 100, output: 20, reasoning: 5 },
    });

    expect(decoded).toEqual({
      kind: 'fact',
      value: {
        completedMs: 1_793_000_060_000,
        cost: 0,
        createdMs: 1_793_000_000_000,
        effort: 'implementation',
        id: null,
        model: 'openai/gpt-6.1-sol',
        modelId: 'gpt-6.1-sol',
        parentId: null,
        providerId: 'openai',
        reportedCostKnown: true,
        tokens: { cacheRead: 30, cacheWrite: 4, input: 100, output: 25, total: 159 },
      },
    });
    expect(
      decodeOpenCodeMessageRow({
        model: { id: 'opus', providerID: 'claude-agent' },
        role: 'assistant',
        tokens: { input: 1, output: 1 },
      }),
    ).toMatchObject({ kind: 'fact', value: { effort: null, model: 'claude-agent/opus', providerId: 'claude-agent' } });
  });

  test('decodes a session_v2 skill tool item embedded in message content', () => {
    const observation = decodeOpenCodeSkillPart({
      data: {
        id: 'call_skill_v2',
        name: 'skill',
        state: {
          input: { id: 'skill-id', name: 'fixture-skill' },
          metadata: { dir: '/work/fixture/.agents/skills/fixture-skill', name: 'fixture-skill' },
          status: 'error',
        },
        time: { completed: 1_793_000_013_000, created: 1_793_000_012_000 },
        type: 'tool',
      },
      projectPath: '/work/fixture',
      session_id: 'v2-session',
      time_created: 1_793_000_010_000,
    });

    expect(observation).toMatchObject({
      harnessKey: 'opencode',
      observationKey: 'call_skill_v2',
      observedAt: '2026-10-26T07:33:32.000Z',
      resolvedPath: '/work/fixture/.agents/skills/fixture-skill',
      sessionId: 'v2-session',
      skillName: 'fixture-skill',
      success: false,
      tier: 'declared',
    });
    expect(
      decodeOpenCodeSkillPart({ data: { id: 'call_read', name: 'read', type: 'tool' }, session_id: 's' }),
    ).toBeNull();
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

  test('keeps report and detail projection facts identical across the session_v2 and legacy schemas', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opencode-v2-parity-'));
    temporaryHomes.push(home);
    const scenario = await seedOpenCodeV2Scenario(home);
    const storage = createLocalHistoryStorage(home);
    const run = <A, E>(effect: Effect.Effect<A, E, LocalHistoryStorage>): Promise<A> =>
      Effect.runPromise(effect.pipe(Effect.provideService(LocalHistoryStorage, storage)));

    const collection = await run(collectOpenCodeResult);
    expect(collection.retiredSourceSessionIds).toEqual([scenario.ids.claudeAgentOnly]);
    for (const sourceSessionId of Object.values(scenario.ids)) {
      const analysis = await run(readOpenCodeSessionAnalysis(sourceSessionId));
      const reportRow = collection.rows.find((row) => row.source?.sourceSessionId === sourceSessionId);
      if (sourceSessionId === scenario.ids.claudeAgentOnly) {
        // No OpenCode usage on either side: nothing to reconcile.
        expect(reportRow).toBeUndefined();
        expect(analysis).toBeNull();
        continue;
      }
      if (!(reportRow && analysis)) {
        throw new Error(`Expected matching OpenCode report and detail rows for ${sourceSessionId}`);
      }
      const { projectPath: _projectPath, source: _source, ...rowWithoutSource } = reportRow;
      expect(sessionProjectionFactsForSerializedRow(serializeUsageRow(rowWithoutSource))).toEqual(analysis.projection);
    }
    const v2Content = await run(readOpenCodeSessionAnalysis(scenario.ids.v2Content));
    expect(v2Content?.projection).toEqual({
      calls: 3,
      durationMs: 71_000,
      modelSegments: [
        { model: 'openai/gpt-6.1-sol', tokens: { cacheRead: 20, cacheWrite: 4, input: 56, output: 17, total: 97 } },
      ],
      partial: false,
      tokens: { cacheRead: 20, cacheWrite: 4, input: 56, output: 17, total: 97 },
      tools: 3,
      turns: 1,
    });
    // The mixed session projects the owned turn only, on both sides, and says so.
    const mixed = await run(readOpenCodeSessionAnalysis(scenario.ids.mixed));
    expect(mixed?.projection).toEqual({
      calls: 1,
      durationMs: 3000,
      modelSegments: [
        { model: 'openai/gpt-5.5', tokens: { cacheRead: 0, cacheWrite: 0, input: 12, output: 3, total: 15 } },
      ],
      partial: true,
      tokens: { cacheRead: 0, cacheWrite: 0, input: 12, output: 3, total: 15 },
      tools: 1,
      turns: 2,
    });
  });

  test('partitions facts between OpenCode and the harness that executed the model call', () => {
    const fact = (providerId: string, id: string) => {
      const decoded = decodeOpenCodeMessageRow({
        id,
        model: { id: providerId === 'claude-agent' ? 'opus' : 'gpt-5.5', providerID: providerId },
        role: 'assistant',
        tokens: { input: 1, output: 1 },
      });
      if (decoded.kind !== 'fact') {
        throw new Error(`Expected a fact for ${providerId}`);
      }
      return decoded.value;
    };
    const claude = fact('claude-agent', 'claude');
    const openai = fact('openai', 'openai');

    expect(isOpenCodeForeignUsageProvider('claude-agent')).toBe(true);
    expect(isOpenCodeForeignUsageProvider('anthropic')).toBe(false);
    expect(partitionOpenCodeUsageFacts([claude, openai, claude])).toEqual({
      foreign: [claude, claude],
      owned: [openai],
    });
    expect(partitionOpenCodeUsageFacts([])).toEqual({ foreign: [], owned: [] });
  });
});
