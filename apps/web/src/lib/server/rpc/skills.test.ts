import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot } from '@ai-usage/web-contract/skills';
import { createRouterClient, ORPCError } from '@orpc/server';
import {
  createSkillsRouter,
  type SkillsCallOptions,
  type SkillsCapability,
  type SkillsCapabilityResult,
  skillsValidationErrorFor,
} from './skills';

const snapshot: SkillManagementSnapshot = {
  config: { sourceRepoPath: '/synthetic/source' },
  configured: true,
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

const capability = (calls: string[] = []): SkillsCapability => ({
  createTargetDirectory: () => {
    calls.push('createTargetDirectory');
    return ok(snapshot);
  },
  previewReconcileAll: () => {
    calls.push('previewReconcileAll');
    return ok({ actions: [], snapshot });
  },
  readKnownProjectPaths: () => {
    calls.push('readKnownProjectPaths');
    return ok([]);
  },
  readMarkdown: () => {
    calls.push('readMarkdown');
    return ok({
      content: '# Synthetic',
      path: '/synthetic/source/example/SKILL.md',
      sha256: 'a'.repeat(64),
      skillName: 'example',
    });
  },
  readProjectInventories: () => {
    calls.push('readProjectInventories');
    return ok([]);
  },
  readProjectMarkdown: (input) => {
    calls.push('readProjectMarkdown');
    return ok({
      content: '# Synthetic',
      path: '/synthetic/project/.agents/skills/example/SKILL.md',
      skillName: input.skillName,
      truncated: false,
    });
  },
  readSnapshot: () => {
    calls.push('readSnapshot');
    return ok(snapshot);
  },
  reconcileAll: () => {
    calls.push('reconcileAll');
    return ok({ actions: [], snapshot });
  },
  reconcileSkill: () => {
    calls.push('reconcileSkill');
    return ok({ actions: [], snapshot });
  },
  refreshSnapshot: () => {
    calls.push('refreshSnapshot');
    return ok(snapshot);
  },
  saveConfig: () => {
    calls.push('saveConfig');
    return ok(snapshot);
  },
  saveMarkdown: () => {
    calls.push('saveMarkdown');
    return ok({ reason: 'conflict' });
  },
  toggleSkill: () => {
    calls.push('toggleSkill');
    return ok({ actions: [], snapshot });
  },
});

describe('Skills server RPC leaf', () => {
  test('routes all thirteen procedures to the injected capability', async () => {
    const calls: string[] = [];
    const client = createRouterClient(createSkillsRouter(() => capability(calls)));
    await client.createTargetDirectory({ targetId: 'agents' });
    await client.projectInventories({});
    await client.knownProjectPaths({});
    await client.managedMarkdown({ skillName: 'example' });
    await client.previewReconcileAll({});
    await client.projectMarkdown({
      projectPath: '/synthetic/project',
      runtimeDirId: 'agents-project',
      skillName: 'example',
    });
    await client.reconcileAll({});
    await client.reconcileOne({ skillName: 'example' });
    await client.refreshSnapshot({});
    await client.saveConfig({ sourceRepoPath: '/synthetic/source' });
    await client.saveManagedMarkdown({
      baseSha256: 'a'.repeat(64),
      content: '# Synthetic',
      skillName: 'example',
    });
    await client.snapshot({});
    await client.toggleProjection({ enabled: true, skillName: 'example' });

    expect(calls).toEqual([
      'createTargetDirectory',
      'readProjectInventories',
      'readKnownProjectPaths',
      'readMarkdown',
      'previewReconcileAll',
      'readProjectMarkdown',
      'reconcileAll',
      'reconcileSkill',
      'refreshSnapshot',
      'saveConfig',
      'saveMarkdown',
      'readSnapshot',
      'toggleSkill',
    ]);
  });

  test('rejects demo mode through preflight before live capability acquisition', async () => {
    let liveAcquisitions = 0;
    const router = createSkillsRouter(
      () => {
        liveAcquisitions += 1;
        return capability();
      },
      () => ({ allowed: false, tag: 'ForbiddenDemo' }),
    );
    expect(liveAcquisitions).toBe(0);
    try {
      await createRouterClient(router).snapshot({});
      throw new Error('Expected demo snapshot to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      if (error instanceof ORPCError) {
        expect(error.code).toBe('ForbiddenDemo');
      }
    }
    expect(liveAcquisitions).toBe(0);
  });

  test('maps schema BAD_REQUEST to the frozen InvalidInput seam without capability acquisition', async () => {
    let acquisitions = 0;
    const client = createRouterClient(
      createSkillsRouter(() => {
        acquisitions += 1;
        return capability();
      }),
    );
    try {
      await client.saveConfig({ sourceRepoPath: '   ' } as never);
      throw new Error('Expected invalid config to reject');
    } catch (error) {
      const mapped = skillsValidationErrorFor(error);
      expect(mapped).toBeInstanceOf(ORPCError);
      expect(mapped?.code).toBe('InvalidInput');
      expect(mapped?.defined).toBe(true);
      expect(mapped?.message).toBe('The Skills request is invalid.');
    }
    expect(acquisitions).toBe(0);
  });

  test('preserves pre-abort reason without capability acquisition or read', async () => {
    let acquisitions = 0;
    const calls: string[] = [];
    const controller = new AbortController();
    const reason = new Error('synthetic pre-abort');
    controller.abort(reason);
    const pending = createRouterClient(
      createSkillsRouter(() => {
        acquisitions += 1;
        return capability(calls);
      }),
    ).snapshot({}, { signal: controller.signal });

    await expect(pending).rejects.toBe(reason);
    expect(acquisitions).toBe(0);
    expect(calls).toEqual([]);
  });

  test('rechecks cancellation after awaited capability acquisition', async () => {
    const acquisition = Promise.withResolvers<SkillsCapability>();
    const acquisitionStarted = Promise.withResolvers<void>();
    const calls: string[] = [];
    let acquisitions = 0;
    const controller = new AbortController();
    const reason = new Error('synthetic acquisition abort');
    const pending = createRouterClient(
      createSkillsRouter(() => {
        acquisitions += 1;
        acquisitionStarted.resolve();
        return acquisition.promise;
      }),
    ).snapshot({}, { signal: controller.signal });

    await acquisitionStarted.promise;
    expect(acquisitions).toBe(1);
    controller.abort(reason);
    acquisition.resolve(capability(calls));

    await expect(pending).rejects.toBe(reason);
    expect(calls).toEqual([]);
  });

  test('does not accept a capability resolution after cancellation', async () => {
    const callStarted = Promise.withResolvers<void>();
    const callResult = Promise.withResolvers<SkillsCapabilityResult<SkillManagementSnapshot>>();
    const fixture = capability();
    fixture.readSnapshot = () => {
      callStarted.resolve();
      return callResult.promise;
    };
    const controller = new AbortController();
    const reason = new Error('synthetic call abort');
    const pending = createRouterClient(createSkillsRouter(() => fixture)).snapshot({}, { signal: controller.signal });

    await callStarted.promise;
    controller.abort(reason);
    callResult.resolve(ok(snapshot));

    await expect(pending).rejects.toBe(reason);
  });

  test('preview invokes only the side-effect-free capability and propagates the signal', async () => {
    const calls: string[] = [];
    let observedOptions: SkillsCallOptions | undefined;
    const fixture = capability(calls);
    fixture.previewReconcileAll = (options) => {
      observedOptions = options;
      calls.push('previewReconcileAll');
      return ok({ actions: [], snapshot });
    };
    const controller = new AbortController();
    await createRouterClient(createSkillsRouter(() => fixture)).previewReconcileAll({}, { signal: controller.signal });
    expect(calls).toEqual(['previewReconcileAll']);
    expect(observedOptions?.signal).toBe(controller.signal);
  });

  test('maps capability failures to sanitized typed transport errors', async () => {
    const fixture = capability();
    fixture.readSnapshot = () => ({
      error: {
        message: 'cannot read /home/maintainer/.agents/skills',
        tag: 'SkillsConflict',
      },
      ok: false,
    });
    try {
      await createRouterClient(createSkillsRouter(() => fixture)).snapshot({});
      throw new Error('Expected snapshot to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      if (error instanceof ORPCError) {
        expect(error.code).toBe('SkillsConflict');
        expect(error.status).toBe(409);
        expect(error.message).toBe('Skills state changed. Refresh and try again.');
        expect(JSON.stringify(error)).not.toContain('/home/maintainer');
      }
    }
  });

  test('sanitizes unexpected capability acquisition failures', async () => {
    const client = createRouterClient(
      createSkillsRouter(() => {
        throw new Error('private path: /home/maintainer/.config');
      }),
    );
    try {
      await client.snapshot({});
      throw new Error('Expected snapshot to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      if (error instanceof ORPCError) {
        expect(error.code).toBe('Unavailable');
        expect(error.message).toBe('Skills are unavailable.');
      }
    }
  });
});
