import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot } from '@ai-usage/web-contract/skills';
import { createRouterClient } from '@orpc/server';
import { createSkillsRouter, type SkillsCapability, type SkillsCapabilityResult } from '../server/rpc/skills';
import { createSkillsClient } from './skills-client';

const snapshot: SkillManagementSnapshot = {
  config: {},
  configured: false,
  diagnostics: [],
  nativeRuleFindings: [],
  projections: [],
  skills: [],
  sourceState: { skillEnabledByName: {}, version: 1 },
  summary: {
    activeSkillCount: 0,
    diagnosticCount: 0,
    healthyProjectionCount: 0,
    skillCount: 0,
    targetCount: 0,
    unhealthyProjectionCount: 0,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
};

const ok = <T>(data: T): SkillsCapabilityResult<T> => ({ data, ok: true });

const fixtureCapability = (): SkillsCapability => ({
  createTargetDirectory: () => ok(snapshot),
  previewReconcileAll: () => ok({ actions: [], snapshot }),
  readKnownProjectPaths: () => ok([]),
  readMarkdown: (skillName) =>
    ok({
      content: '# Synthetic',
      path: '/synthetic/source/example/SKILL.md',
      sha256: 'a'.repeat(64),
      skillName,
    }),
  readObservations: () =>
    ok({
      harnesses: [
        { harnessKey: 'claude', label: 'Claude Code', observability: 'observable' as const },
        { harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' as const },
      ],
      invocationLowerBound: false,
      lowerBound: false,
      producerCompletenessMissing: false,
      skills: [],
      skipped: 0,
    }),
  readProjectInventories: () => ok([]),
  readProjectMarkdown: (input) =>
    ok({
      content: '# Synthetic',
      path: '/synthetic/project/.agents/skills/example/SKILL.md',
      skillName: input.skillName,
      truncated: false,
    }),
  readSnapshot: () => ok(snapshot),
  reconcileAll: () => ok({ actions: [], snapshot }),
  reconcileSkill: () => ok({ actions: [], snapshot }),
  refreshSnapshot: () => ok(snapshot),
  saveConfig: () => ok(snapshot),
  saveMarkdown: () => ok({ reason: 'conflict' }),
  toggleSkill: () => ok({ actions: [], snapshot }),
});

const clientFor = (capability: SkillsCapability) =>
  createSkillsClient(createRouterClient(createSkillsRouter(() => capability)));

describe('Skills browser RPC adapter', () => {
  test('preserves legacy result envelopes and forwards inputs and AbortSignal', async () => {
    const fixture = fixtureCapability();
    let observedSignal: AbortSignal | undefined;
    let observedSkillName = '';
    fixture.readMarkdown = (skillName, options) => {
      observedSignal = options.signal;
      observedSkillName = skillName;
      return ok({
        content: '# Synthetic',
        path: '/synthetic/source/example/SKILL.md',
        sha256: 'a'.repeat(64),
        skillName,
      });
    };
    const controller = new AbortController();
    const result = await clientFor(fixture).getManagedSkillMarkdown('example', {
      signal: controller.signal,
    });
    expect(result).toEqual({
      data: {
        content: '# Synthetic',
        path: '/synthetic/source/example/SKILL.md',
        sha256: 'a'.repeat(64),
        skillName: 'example',
      },
      ok: true,
    });
    expect(observedSkillName).toBe('example');
    expect(observedSignal).toBe(controller.signal);
  });

  test('keeps conflict save outcomes as successful data for dirty draft handling', async () => {
    expect(
      await clientFor(fixtureCapability()).saveManagedSkillMarkdown({
        baseSha256: 'a'.repeat(64),
        content: '# Dirty draft',
        skillName: 'example',
      }),
    ).toEqual({ data: { reason: 'conflict' }, ok: true });
  });

  test('converts sanitized defined errors to the legacy failure envelope', async () => {
    const fixture = fixtureCapability();
    fixture.readSnapshot = () => ({
      error: {
        message: 'private state at /home/maintainer',
        tag: 'ForbiddenDemo',
      },
      ok: false,
    });
    expect(await clientFor(fixture).getSkillManagementSnapshot()).toEqual({
      error: {
        message: 'Skills are unavailable in demo mode.',
        tag: 'ForbiddenDemo',
      },
      ok: false,
    });
  });

  test('does not leak unexpected server failures', async () => {
    const rpcClient = createRouterClient(
      createSkillsRouter(() => {
        throw new Error('private path /home/maintainer/.agents');
      }),
    );
    expect(await createSkillsClient(rpcClient).getSkillManagementSnapshot()).toEqual({
      error: {
        message: 'Skills are unavailable.',
        tag: 'Unavailable',
      },
      ok: false,
    });
  });

  test('preserves a pre-abort reason without transport acquisition or read', async () => {
    const calls: string[] = [];
    let acquisitions = 0;
    const fixture = fixtureCapability();
    fixture.readSnapshot = () => {
      calls.push('readSnapshot');
      return ok(snapshot);
    };
    const client = createSkillsClient(
      createRouterClient(
        createSkillsRouter(() => {
          acquisitions += 1;
          return fixture;
        }),
      ),
    );
    const controller = new AbortController();
    const reason = new Error('synthetic pre-abort');
    controller.abort(reason);

    await expect(client.getSkillManagementSnapshot({ signal: controller.signal })).rejects.toBe(reason);
    expect(acquisitions).toBe(0);
    expect(calls).toEqual([]);
  });

  test('does not turn a late aborted resolution into a success envelope', async () => {
    const callStarted = Promise.withResolvers<void>();
    const callResult = Promise.withResolvers<SkillsCapabilityResult<SkillManagementSnapshot>>();
    const fixture = fixtureCapability();
    fixture.readSnapshot = () => {
      callStarted.resolve();
      return callResult.promise;
    };
    const controller = new AbortController();
    const reason = new Error('synthetic late abort');
    const pending = clientFor(fixture).getSkillManagementSnapshot({ signal: controller.signal });

    await callStarted.promise;
    controller.abort(reason);
    callResult.resolve(ok(snapshot));

    await expect(pending).rejects.toBe(reason);
  });
});
