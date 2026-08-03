import { describe, expect, test } from 'bun:test';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { QueryClient, QueryObserver } from '@tanstack/solid-query';
import { skillsProjectInventoriesKey } from './lib/query/identities/skills';
import { webQueryPolicies } from './lib/query/policies';
import type { SkillSnapshotResult } from './skills-client-contracts';
import type { SkillsMutationResult } from './skills-query-operations';
import { createSkillsRouteActions } from './skills-route-actions';
import {
  projectInventoriesRefreshErrorFromQuery,
  projectInventoriesResultFromQuery,
  refetchActiveSkillsProjectInventories,
} from './skills-route-controller';
import {
  createSkillsSnapshotCoordinator,
  type OperationNotice,
  type PendingSnapshotReplacement,
  runSkillsControllerOperation,
} from './skills-route-controller-state';
import type { SkillMarkdownDraftGuard } from './skills-workspace';

const snapshot = (sourceRepoPath: string): SkillManagementSnapshot => ({
  config: { sourceRepoPath },
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
});

const unconfiguredSnapshot = (): SkillManagementSnapshot => ({
  ...snapshot(''),
  config: {},
  configured: false,
});

describe('Skills route controller state', () => {
  test('refetches the exact active canonical project-inventories query after snapshot replacement', async () => {
    const queryClient = new QueryClient();
    let queryCalls = 0;
    const options = {
      ...webQueryPolicies.finiteSwr,
      queryFn: () => {
        queryCalls += 1;
        return [];
      },
      queryKey: skillsProjectInventoriesKey(),
    };
    await queryClient.fetchQuery(options);
    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => undefined);

    await refetchActiveSkillsProjectInventories(queryClient);

    expect(queryCalls).toBe(2);
    expect(queryClient.getQueryData<readonly unknown[]>(skillsProjectInventoriesKey())).toEqual([]);
    unsubscribe();
    queryClient.clear();
  });

  test('refetches fresh canonical inventories when configuration is enabled or changed', async () => {
    const queryClient = new QueryClient();
    let queryCalls = 0;
    const options = (enabled: boolean) => ({
      ...webQueryPolicies.finiteSwr,
      enabled,
      queryFn: () => {
        queryCalls += 1;
        return [`inventory-${queryCalls}`];
      },
      queryKey: skillsProjectInventoriesKey(),
    });
    await queryClient.fetchQuery(options(true));
    const observer = new QueryObserver(queryClient, options(false));
    const unsubscribe = observer.subscribe(() => undefined);
    const coordinator = createSkillsSnapshotCoordinator({
      commitCache: () => undefined,
      dirtyDraft: () => undefined,
      incrementMarkdownRefreshVersion: () => undefined,
      pendingReplacement: () => undefined,
      refetchInventories: async () => await refetchActiveSkillsProjectInventories(queryClient),
      setDirtyDraft: () => undefined,
      setNotice: () => undefined,
      setPendingReplacement: () => undefined,
      setResult: (next) => {
        observer.setOptions(options(next.ok && next.data.configured));
      },
    });

    await coordinator.requestSnapshotReplacement(
      { data: unconfiguredSnapshot(), ok: true },
      'Skills unconfigured.',
      true,
    );
    expect(queryCalls).toBe(1);
    await coordinator.requestSnapshotReplacement({ data: snapshot('/config-b'), ok: true }, 'Configured.', true);
    expect(queryCalls).toBe(2);
    await coordinator.requestSnapshotReplacement({ data: snapshot('/config-c'), ok: true }, 'Reconfigured.', true);
    expect(queryCalls).toBe(3);
    expect(queryClient.getQueryData<readonly string[]>(skillsProjectInventoriesKey())).toEqual(['inventory-3']);
    unsubscribe();
    queryClient.clear();
  });

  test('marks every successful configuration action for dependent inventory refresh', async () => {
    const refreshFlags: boolean[] = [];
    const actions = createSkillsRouteActions({
      mutate: async (request) =>
        request.type === 'save-config'
          ? { result: { data: snapshot(request.config.sourceRepoPath ?? '/configured'), ok: true }, type: request.type }
          : undefined,
      projectPathDraft: () => '/project-b',
      projectPaths: () => ['/project-a'],
      replaceSnapshot: (_next, _message, refreshDependents = false) => {
        refreshFlags.push(refreshDependents);
        return Promise.resolve(true);
      },
      setKnownProjectPaths: () => undefined,
      setKnownProjectPathsCache: () => undefined,
      setNotice: () => undefined,
      setProjectPathDraft: () => undefined,
      setReconcilePlan: () => undefined,
      setSourceRepoPath: () => undefined,
      setSourceRepoPathDirty: () => undefined,
      snapshot: () => snapshot('/source-a'),
    });

    await actions.addProjectPath();
    await actions.removeProjectPath('/project-a');
    await actions.saveConfig('/source-b');

    expect(refreshFlags).toEqual([true, true, true]);
  });

  test('hides retained project inventories after configuration becomes unavailable', () => {
    const retainedQuery = { data: [], error: null, isPending: false };

    expect(projectInventoriesResultFromQuery(retainedQuery, true)).toEqual({ data: [], ok: true });
    expect(projectInventoriesResultFromQuery(retainedQuery, false)).toBeUndefined();
    expect(projectInventoriesRefreshErrorFromQuery(retainedQuery, false)).toBeUndefined();
  });

  test('retains project inventories while surfacing a failed SWR refresh', () => {
    const retainedQuery = {
      data: [],
      error: new Error('Inventory refresh failed.'),
      isPending: false,
    };

    expect(projectInventoriesResultFromQuery(retainedQuery, true)).toEqual({ data: [], ok: true });
    expect(projectInventoriesRefreshErrorFromQuery(retainedQuery, true)).toEqual({
      error: { message: 'Inventory refresh failed.', tag: 'ClientReadError' },
      ok: false,
    });
  });

  test('commits successful snapshots to visible state and the Query cache', async () => {
    const committed: unknown[] = [];
    let result: SkillSnapshotResult = { data: snapshot('/initial'), ok: true };
    const notices: (OperationNotice | null)[] = [];
    let refreshVersion = 0;
    const coordinator = createSkillsSnapshotCoordinator({
      commitCache: (next) => committed.push(next),
      dirtyDraft: () => undefined,
      incrementMarkdownRefreshVersion: () => {
        refreshVersion++;
      },
      pendingReplacement: () => undefined,
      refetchInventories: () => Promise.resolve(),
      setDirtyDraft: () => undefined,
      setNotice: (next) => {
        notices.push(next);
      },
      setPendingReplacement: () => undefined,
      setResult: (next) => {
        result = next;
      },
    });

    await coordinator.requestSnapshotReplacement({ data: snapshot('/next'), ok: true }, 'Skills refreshed.', true);

    expect(result.ok && result.data.config.sourceRepoPath).toBe('/next');
    expect(notices).toEqual([{ message: 'Skills refreshed.', tone: 'ok' }]);
    expect(refreshVersion).toBe(1);
    expect(committed).toEqual([{ data: snapshot('/next'), ok: true }]);
  });

  test('protects a dirty draft until the pending snapshot is explicitly discarded', async () => {
    let discarded = false;
    let result: SkillSnapshotResult = { data: snapshot('/initial'), ok: true };
    let pending: PendingSnapshotReplacement | undefined;
    let dirtyDraft: SkillMarkdownDraftGuard | undefined = {
      dirty: true,
      discard: () => {
        discarded = true;
      },
      focus: () => undefined,
      skillName: 'removed-skill',
    };
    const coordinator = createSkillsSnapshotCoordinator({
      commitCache: () => undefined,
      dirtyDraft: () => dirtyDraft,
      incrementMarkdownRefreshVersion: () => undefined,
      pendingReplacement: () => pending,
      refetchInventories: () => Promise.resolve(),
      setDirtyDraft: (next) => {
        dirtyDraft = next;
      },
      setNotice: () => undefined,
      setPendingReplacement: (next) => {
        pending = next;
      },
      setResult: (next) => {
        result = next;
      },
    });

    const replaced = await coordinator.requestSnapshotReplacement(
      { data: snapshot('/pending'), ok: true },
      'Skills reloaded.',
    );
    expect(replaced).toBe(false);
    expect(result.ok && result.data.config.sourceRepoPath).toBe('/initial');

    await coordinator.discardDirtySnapshot();
    expect(discarded).toBe(true);
    expect(result.ok && result.data.config.sourceRepoPath).toBe('/pending');
  });

  test('rejects concurrent operations and exposes mutation failures', async () => {
    let mutationCalls = 0;
    const concurrent = await runSkillsControllerOperation({
      clearReconcilePlan: () => undefined,
      isPending: () => true,
      mutate: (): Promise<SkillsMutationResult> => {
        mutationCalls++;
        return Promise.resolve({ result: { data: snapshot('/unused'), ok: true }, type: 'save-config' });
      },
      request: { type: 'refresh' },
      setNotice: () => undefined,
    });
    expect(concurrent).toBeUndefined();
    expect(mutationCalls).toBe(0);

    let errorNotice: unknown = null;
    await runSkillsControllerOperation({
      clearReconcilePlan: () => undefined,
      isPending: () => false,
      mutate: () => Promise.reject(new Error('refresh failed')),
      request: { type: 'refresh' },
      setNotice: (notice) => {
        errorNotice = notice;
      },
    });
    expect(errorNotice).toEqual({ message: 'refresh failed', tone: 'error' });
  });
});
