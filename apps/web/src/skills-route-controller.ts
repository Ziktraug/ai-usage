import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { type Accessor, createEffect, createMemo, createSignal } from 'solid-js';
import { isServer } from 'solid-js/web';
import {
  type KnownProjectPathsResult,
  type ProjectInventoriesResult,
  parseKnownProjectPathsResult,
  parseSkillSnapshotResult,
  type SkillSnapshotResult,
} from './skills-client-contracts';
import type { ReconcilePlanSummary } from './skills-page-model';
import { createSkillsRouteActions } from './skills-route-actions';
import { createSkillsSnapshotOwner, runSkillsControllerOperation } from './skills-route-controller-state';
import { loadSkillInventories, runSkillsMutation, type SkillsMutationRequest, webQueryKeys } from './web-query-options';

export type { KnownProjectPathsResult, SkillSnapshotResult } from './skills-client-contracts';
export type { OperationNotice } from './skills-route-controller-state';

interface SkillsRouteInitialData {
  knownProjectPaths: unknown;
  skills: unknown;
}

const snapshotResultFrom = (value: unknown): SkillSnapshotResult => {
  try {
    return parseSkillSnapshotResult(value);
  } catch {
    return { error: { message: 'Invalid skills snapshot response', tag: 'InvalidResponse' }, ok: false };
  }
};

const knownProjectPathsResultFrom = (value: unknown): KnownProjectPathsResult => {
  try {
    return parseKnownProjectPathsResult(value);
  } catch {
    return { error: { message: 'Invalid known project paths response', tag: 'InvalidResponse' }, ok: false };
  }
};

const operationLabel = (request: SkillsMutationRequest | undefined): string | null => {
  if (!request) {
    return null;
  }
  switch (request.type) {
    case 'save-config':
      return 'save-config';
    case 'toggle':
      return `toggle:${request.skillName}`;
    case 'reconcile-one':
      return `reconcile:${request.skillName}`;
    case 'preview-reconcile':
      return 'preview-reconcile';
    case 'reconcile-all':
      return 'reconcile-all';
    case 'create-target':
      return `target:${request.targetId}`;
    case 'refresh':
      return 'refresh-skills';
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
};

export const createSkillsRouteController = (routeData: Accessor<SkillsRouteInitialData>) => {
  const queryClient = useQueryClient();
  const initialData = routeData();
  let observedRouteData = initialData;
  let observedRouteDataFingerprint = JSON.stringify(initialData);
  const snapshotOwner = createSkillsSnapshotOwner({
    commitCache: (next) => {
      queryClient.setQueryData<SkillsRouteInitialData>(webQueryKeys.skillsInitial, (current) => {
        if (!(current && current.skills !== next)) {
          return current;
        }
        const updated = { ...current, skills: next };
        observedRouteDataFingerprint = JSON.stringify(updated);
        return updated;
      });
    },
    initialResult: snapshotResultFrom(initialData.skills),
    refetchInventories: async () => {
      await queryClient.refetchQueries({
        queryKey: webQueryKeys.skillInventories,
        type: 'active',
      });
    },
  });
  const {
    discardDirtySnapshot,
    errorMessage,
    keepDirtySnapshot,
    markdownRefreshVersion,
    operationNotice,
    pendingSnapshotReplacement,
    requestSnapshotReplacement,
    result,
    setDirtyMarkdownDraft,
    setOperationNotice,
    snapshot,
  } = snapshotOwner;
  const [knownProjectPathsResult, setKnownProjectPathsResult] = createSignal<KnownProjectPathsResult>(
    knownProjectPathsResultFrom(initialData.knownProjectPaths),
  );
  const [reconcilePlan, setReconcilePlan] = createSignal<ReconcilePlanSummary | null>(null);
  const knownProjectPaths = createMemo(() => {
    const current = knownProjectPathsResult();
    return current.ok ? current.data : [];
  });
  const knownProjectPathsError = createMemo(() => {
    const current = knownProjectPathsResult();
    return current.ok ? null : current.error.message;
  });
  const [sourceRepoPath, setSourceRepoPath] = createSignal(snapshot()?.config.sourceRepoPath ?? '');
  const [sourceRepoPathDirty, setSourceRepoPathDirty] = createSignal(false);
  const [projectPaths, setProjectPaths] = createSignal<readonly string[]>(snapshot()?.config.projectPaths ?? []);
  const [projectPathDraft, setProjectPathDraft] = createSignal('');
  const projectInventoriesKey = createMemo(() => {
    const current = snapshot();
    if (current?.configured !== true) {
      return;
    }
    return JSON.stringify([current.config.sourceRepoPath ?? '', ...(current.config.projectPaths ?? [])]);
  });
  const projectInventoriesQuery = createQuery(() => ({
    enabled: !isServer && projectInventoriesKey() !== undefined,
    queryFn: loadSkillInventories,
    queryKey: [...webQueryKeys.skillInventories, projectInventoriesKey()] as const,
  }));
  const projectInventories = (): ProjectInventoriesResult | undefined =>
    isServer ? undefined : projectInventoriesQuery.data;
  const operationMutation = createMutation(() => ({
    mutationFn: runSkillsMutation,
    mutationKey: webQueryKeys.skillsMutation,
  }));
  const pendingOperation = (): string | null =>
    operationMutation.isPending ? operationLabel(operationMutation.variables) : null;

  createEffect(() => {
    const current = snapshot();
    if (current === undefined) {
      return;
    }
    if (!sourceRepoPathDirty()) {
      setSourceRepoPath(current.config.sourceRepoPath ?? '');
    }
    setProjectPaths(current.config.projectPaths ?? []);
  });

  createEffect(async () => {
    const nextRouteData = routeData();
    if (nextRouteData === observedRouteData) {
      return;
    }
    observedRouteData = nextRouteData;
    const nextRouteDataFingerprint = JSON.stringify(nextRouteData);
    if (nextRouteDataFingerprint === observedRouteDataFingerprint) {
      return;
    }
    observedRouteDataFingerprint = nextRouteDataFingerprint;
    const nextKnownProjectPaths = knownProjectPathsResultFrom(nextRouteData.knownProjectPaths);
    const nextSkills = snapshotResultFrom(nextRouteData.skills);
    if (nextKnownProjectPaths === knownProjectPathsResult() && nextSkills === result()) {
      return;
    }
    setKnownProjectPathsResult(nextKnownProjectPaths);
    await requestSnapshotReplacement(nextSkills, 'Skills reloaded.', true);
  });

  const runOperation = async (request: SkillsMutationRequest) =>
    await runSkillsControllerOperation({
      clearReconcilePlan: () => setReconcilePlan(null),
      error: () => operationMutation.error,
      isPending: () => operationMutation.isPending,
      mutate: (variables) => operationMutation.mutateAsync(variables),
      request,
      setNotice: setOperationNotice,
    });
  const actions = createSkillsRouteActions({
    mutate: runOperation,
    projectPathDraft,
    projectPaths,
    replaceSnapshot: requestSnapshotReplacement,
    setKnownProjectPaths: setKnownProjectPathsResult,
    setKnownProjectPathsCache: (knownProjectPaths) => {
      queryClient.setQueryData<SkillsRouteInitialData>(webQueryKeys.skillsInitial, (current) =>
        current ? { ...current, knownProjectPaths } : current,
      );
    },
    setNotice: setOperationNotice,
    setProjectPathDraft,
    setReconcilePlan,
    setSourceRepoPath,
    setSourceRepoPathDirty,
    snapshot,
  });

  const applyWorkspaceSnapshot = (nextSnapshot: SkillManagementSnapshot): Promise<boolean> =>
    requestSnapshotReplacement({ data: nextSnapshot, ok: true }, 'Skill snapshot updated.');

  return {
    addProjectPath: actions.addProjectPath,
    applyReconcile: actions.applyReconcile,
    applyWorkspaceSnapshot,
    cancelReconcile: () => setReconcilePlan(null),
    createTargetDirectory: actions.createTargetDirectory,
    discardDirtySnapshot,
    errorMessage,
    keepDirtySnapshot,
    knownProjectPaths,
    knownProjectPathsError,
    markdownRefreshVersion,
    operationNotice,
    pendingOperation,
    pendingSnapshotReplacement,
    previewReconcile: actions.previewReconcile,
    projectInventories,
    projectInventoriesLoading: () => projectInventoriesQuery.isFetching,
    projectPathDraft,
    projectPaths,
    reconcilePlan,
    reconcileSkill: actions.reconcileSkill,
    refreshSkills: actions.refreshSkills,
    removeProjectPath: actions.removeProjectPath,
    result,
    saveConfig: actions.saveConfig,
    setDirtyMarkdownDraft,
    setOperationNotice,
    setProjectPathDraft,
    snapshot,
    sourceRepoPath,
    toggleSkill: actions.toggleSkill,
    updateSourceRepoPath: actions.updateSourceRepoPath,
  };
};
