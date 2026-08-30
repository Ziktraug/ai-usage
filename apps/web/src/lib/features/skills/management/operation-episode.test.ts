import { describe, expect, test } from 'bun:test';
import type { ProjectionAction, SkillManagementSnapshot } from '@ai-usage/skills';
import { createWebQueryClient } from '../../../query/client';
import {
  skillObservationsKey,
  skillsKnownProjectPathsKey,
  skillsProjectInventoriesKey,
  skillsSnapshotKey,
} from '../../../query/options/skills';
import { skillsConfigInput } from './model';
import {
  createSkillsManagementOperationEpisodePort,
  executeSkillsManagementOperationEpisode,
  type SkillsManagementOperationClient,
  type SkillsManagementOperationCommand,
  type SkillsManagementOperationOutcome,
} from './operation-episode.svelte';
import { syntheticManagementSnapshot } from './synthetic-fixture.test-helper';

const managementClient = (calls: unknown[]): SkillsManagementOperationClient => {
  const snapshot = syntheticManagementSnapshot();
  const actions: readonly ProjectionAction[] = [
    {
      path: '/synthetic/runtime/skills/alpha-skill',
      skillName: 'alpha-skill',
      sourcePath: '/synthetic/source/skills/alpha-skill',
      targetId: 'codex',
      type: 'create-symlink',
    },
    {
      path: '/synthetic/runtime/skills/legacy-local-copy',
      reason: 'unmanaged copy',
      skillName: 'legacy-local-copy',
      targetId: 'codex',
      type: 'refuse-unmanaged-mutation',
    },
  ];
  return {
    createManagedSkillTargetDirectory: (input) => {
      calls.push({ input, type: 'create-target' });
      return Promise.resolve({ data: snapshot, ok: true });
    },
    getSkillProjectInventories: () => {
      calls.push({ type: 'project-inventories' });
      return Promise.resolve({ data: [], ok: true });
    },
    previewReconcileAllManagedSkills: () => {
      calls.push({ type: 'preview-reconcile' });
      return Promise.resolve({ data: { actions, snapshot }, ok: true });
    },
    reconcileAllManagedSkills: () => Promise.resolve({ data: { actions: [], snapshot }, ok: true }),
    reconcileManagedSkill: (skillName) => {
      calls.push({ skillName, type: 'reconcile-skill' });
      return Promise.resolve({ data: { actions: [], snapshot }, ok: true });
    },
    refreshSkillManagementSnapshot: () => {
      calls.push({ type: 'refresh' });
      return Promise.resolve({ data: snapshot, ok: true });
    },
    saveSkillManagementConfig: (input) => {
      calls.push({ input, type: 'save-config' });
      return Promise.resolve({ data: snapshot, ok: true });
    },
    toggleManagedSkill: (input) => {
      calls.push({ input, type: 'toggle-skill' });
      return Promise.resolve({ data: { actions: [], snapshot }, ok: true });
    },
  };
};

describe('Skills management operation episode', () => {
  test('dispatches a preview and publishes its snapshot, joined-observation invalidation, and plan together', async () => {
    const queryClient = createWebQueryClient();
    const calls: unknown[] = [];
    const client = managementClient(calls);
    queryClient.setQueryData(skillObservationsKey(), { marker: 'stale join' });

    const outcome = await executeSkillsManagementOperationEpisode(queryClient, client, {
      kind: 'management',
      operation: { type: 'preview-reconcile' },
      owner: 'health-summary',
      pendingLabel: 'preview-reconcile',
    });

    expect(calls).toEqual([{ type: 'preview-reconcile' }]);
    expect(queryClient.getQueryData<SkillManagementSnapshot>(skillsSnapshotKey())).toBe(outcome.snapshot);
    expect(queryClient.getQueryState(skillObservationsKey())?.isInvalidated).toBe(true);
    expect(outcome).toMatchObject({
      kind: 'management',
      message: 'Reconcile preview refreshed.',
      owner: 'health-summary',
      plan: {
        apply: ['link alpha-skill @ Codex → /synthetic/runtime/skills/alpha-skill'],
        skipped: ['legacy-local-copy @ Codex — unmanaged copy'],
      },
    });
  });

  test('owns configuration and refresh dependent publication without a second cache controller', async () => {
    const queryClient = createWebQueryClient();
    const calls: unknown[] = [];
    const client = managementClient(calls);
    const snapshot = syntheticManagementSnapshot();
    queryClient.setQueryData(skillsKnownProjectPathsKey(), [{ path: '/stale' }]);
    queryClient.setQueryData(skillsProjectInventoriesKey(), [{ projectPath: '/stale' }]);
    const config = skillsConfigInput(snapshot, { sourceRepoPath: '/replacement' });

    const configured = await executeSkillsManagementOperationEpisode(queryClient, client, {
      kind: 'configuration',
      operation: { config, type: 'save-config' },
      owner: 'configuration',
      pendingLabel: 'save-config',
      successMessage: 'Skill source saved.',
    });
    expect(configured).toMatchObject({
      kind: 'configuration',
      message: 'Skill source saved.',
      owner: 'configuration',
      plan: null,
    });
    expect(calls).toEqual([{ input: config, type: 'save-config' }, { type: 'project-inventories' }]);
    expect(queryClient.getQueryState(skillsKnownProjectPathsKey())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData<readonly unknown[]>(skillsProjectInventoriesKey())).toEqual([]);

    calls.length = 0;
    const refreshed = await executeSkillsManagementOperationEpisode(queryClient, client, {
      kind: 'refresh',
      owner: 'health-inspector',
      pendingLabel: 'refresh-skills',
    });
    expect(refreshed).toMatchObject({ kind: 'refresh', message: undefined, owner: 'health-inspector', plan: null });
    expect(calls).toEqual([{ type: 'refresh' }, { type: 'project-inventories' }]);
  });

  test('exposes one shared pending gate and the initiating owner from mutation state', async () => {
    const pending = Promise.withResolvers<SkillsManagementOperationOutcome>();
    let data: SkillsManagementOperationOutcome | undefined;
    let error: Error | null = null;
    let isPending = false;
    let variables: SkillsManagementOperationCommand | undefined;
    let resets = 0;
    let mutations = 0;
    const mutation = {
      get data() {
        return data;
      },
      get error() {
        return error;
      },
      get isPending() {
        return isPending;
      },
      mutateAsync: async (command: SkillsManagementOperationCommand) => {
        mutations += 1;
        variables = command;
        isPending = true;
        try {
          data = await pending.promise;
          return data;
        } catch (cause) {
          error = cause instanceof Error ? cause : new Error(String(cause));
          throw error;
        } finally {
          isPending = false;
        }
      },
      reset: () => {
        resets += 1;
        data = undefined;
        error = null;
        variables = undefined;
      },
      get variables() {
        return variables;
      },
    };
    const port = createSkillsManagementOperationEpisodePort(mutation);
    const command = {
      kind: 'management',
      operation: { type: 'preview-reconcile' },
      owner: 'matrix',
      pendingLabel: 'preview-reconcile',
    } as const;
    const first = port.execute(command);

    expect(port.pendingOperation).toBe('preview-reconcile');
    expect(await port.execute(command)).toBeUndefined();
    expect(mutations).toBe(1);

    const outcome: SkillsManagementOperationOutcome = {
      kind: 'management',
      message: 'Reconcile preview refreshed.',
      owner: 'matrix',
      plan: { apply: ['link alpha-skill'], skipped: [] },
      snapshot: syntheticManagementSnapshot(),
    };
    pending.resolve(outcome);
    await expect(first).resolves.toBe(outcome);
    expect(port.pendingOperation).toBeNull();
    expect(port.notice).toEqual({ message: 'Reconcile preview refreshed.', owner: 'matrix', tone: 'success' });
    expect(port.plan).toBe(outcome.plan);

    port.clearPlan();
    expect(port.plan).toBeNull();
    expect(port.notice).toBeNull();
    expect(resets).toBe(2);
  });
});
