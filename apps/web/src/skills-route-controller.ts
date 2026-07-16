import type { ProjectionAction, SkillManagementConfig, SkillManagementSnapshot } from '@ai-usage/skills';
import { createMutation, createQuery, useQueryClient } from '@tanstack/solid-query';
import { type Accessor, createEffect, createMemo, createSignal } from 'solid-js';
import { isServer } from 'solid-js/web';
import {
  type KnownProjectPathsResult,
  type ProjectInventoriesResult,
  parseKnownProjectPathsResult,
  parseSkillSnapshotResult,
  type SkillReconcileServerResult,
  type SkillSnapshotResult,
} from './skills-client-contracts';
import { count, describeReconcileActions, type ReconcilePlanSummary } from './skills-page-model';
import { snapshotRemovesDirtySkill } from './skills-route-model';
import type { SkillMarkdownDraftGuard } from './skills-workspace';
import { loadSkillInventories, runSkillsMutation, type SkillsMutationRequest, webQueryKeys } from './web-query-options';

export type { KnownProjectPathsResult, SkillSnapshotResult } from './skills-client-contracts';

export interface OperationNotice {
  message: string;
  tone: 'error' | 'ok';
}

interface PendingSnapshotReplacement {
  afterCommit?: () => void;
  message: string;
  refreshDependents: boolean;
  snapshot: SkillManagementSnapshot;
}

interface SkillsRouteInitialData {
  knownProjectPaths: unknown;
  skills: unknown;
}

const errorMessageFrom = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

const targetLabel = (snapshot: SkillManagementSnapshot, targetId: string): string =>
  snapshot.targets.find((target) => target.id === targetId)?.label ?? targetId;

const actionNotice = (
  actions: readonly ProjectionAction[],
  snapshot: SkillManagementSnapshot,
  fallback: string,
): string => {
  const applied = actions.filter((action) => action.type !== 'noop' && action.type !== 'refuse-unmanaged-mutation');
  if (applied.length === 0) {
    return 'Nothing to change.';
  }
  if (applied.length === 1) {
    const action = applied.at(0);
    if (action === undefined) {
      return 'Nothing to change.';
    }
    if (action.type === 'create-symlink') {
      return `${action.skillName} linked to ${targetLabel(snapshot, action.targetId)}.`;
    }
    if (action.type === 'repair-symlink') {
      return `${action.skillName} repaired in ${targetLabel(snapshot, action.targetId)}.`;
    }
    return `${action.skillName} unlinked from ${targetLabel(snapshot, action.targetId)}.`;
  }
  return `${fallback}: ${count(applied.length, 'change')} applied.`;
};

export const createSkillsRouteController = (routeData: Accessor<SkillsRouteInitialData>) => {
  const queryClient = useQueryClient();
  const initialData = routeData();
  const [result, setResult] = createSignal<SkillSnapshotResult>(snapshotResultFrom(initialData.skills));
  const [knownProjectPathsResult, setKnownProjectPathsResult] = createSignal<KnownProjectPathsResult>(
    knownProjectPathsResultFrom(initialData.knownProjectPaths),
  );
  const [operationNotice, setOperationNotice] = createSignal<OperationNotice | null>(null);
  const [reconcilePlan, setReconcilePlan] = createSignal<ReconcilePlanSummary | null>(null);
  const [markdownRefreshVersion, setMarkdownRefreshVersion] = createSignal(0);
  const [dirtyMarkdownDraft, setDirtyMarkdownDraft] = createSignal<SkillMarkdownDraftGuard>();
  const [pendingSnapshotReplacement, setPendingSnapshotReplacement] = createSignal<PendingSnapshotReplacement>();
  const snapshot = createMemo(() => {
    const current = result();
    return current.ok ? current.data : undefined;
  });
  const errorMessage = createMemo(() => {
    const current = result();
    return current.ok ? '' : current.error.message;
  });
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

  const commitSnapshotResult = async (
    next: SkillSnapshotResult,
    message: string,
    refreshDependents: boolean,
  ): Promise<void> => {
    setResult(next);
    queryClient.setQueryData<SkillsRouteInitialData>(webQueryKeys.skillsInitial, (current) => {
      if (!(current && current.skills !== next)) {
        return current;
      }
      const updated = { ...current, skills: next };
      observedRouteDataFingerprint = JSON.stringify(updated);
      return updated;
    });
    setOperationNotice(next.ok ? { message, tone: 'ok' } : { message: next.error.message, tone: 'error' });
    if (!(next.ok && refreshDependents)) {
      return;
    }
    if (next.data.configured) {
      await queryClient.refetchQueries({
        queryKey: webQueryKeys.skillInventories,
        type: 'active',
      });
    }
    setMarkdownRefreshVersion((version) => version + 1);
  };

  const requestSnapshotReplacement = async (
    next: SkillSnapshotResult,
    message: string,
    refreshDependents = false,
    afterCommit?: () => void,
  ): Promise<boolean> => {
    if (next.ok && snapshotRemovesDirtySkill(next.data, dirtyMarkdownDraft())) {
      setPendingSnapshotReplacement({
        ...(afterCommit === undefined ? {} : { afterCommit }),
        message,
        refreshDependents,
        snapshot: next.data,
      });
      return false;
    }
    await commitSnapshotResult(next, message, refreshDependents);
    if (next.ok) {
      afterCommit?.();
    }
    return true;
  };

  let observedRouteData = initialData;
  let observedRouteDataFingerprint = JSON.stringify(initialData);
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

  const applyReconcileResult = async (next: SkillReconcileServerResult, fallbackMessage: string): Promise<void> => {
    if (!next.ok) {
      setOperationNotice({ message: next.error.message, tone: 'error' });
      return;
    }
    await requestSnapshotReplacement(
      { data: next.data.snapshot, ok: true },
      actionNotice(next.data.actions, next.data.snapshot, fallbackMessage),
    );
  };

  const runOperation = async (request: SkillsMutationRequest) => {
    if (operationMutation.isPending) {
      return;
    }
    setOperationNotice(null);
    setReconcilePlan(null);
    try {
      return await operationMutation.mutateAsync(request);
    } catch (error) {
      setOperationNotice({ message: errorMessageFrom(operationMutation.error ?? error), tone: 'error' });
    }
  };

  const configInput = (overrides: { projectPaths?: readonly string[]; sourceRepoPath?: string } = {}) => {
    const current = snapshot()?.config ?? {};
    const { projectPaths: _projectPaths, ...currentWithoutProjectPaths } = current;
    const next: SkillManagementConfig = currentWithoutProjectPaths;
    const source = (overrides.sourceRepoPath ?? current.sourceRepoPath ?? '').trim();
    if (source) {
      next.sourceRepoPath = source;
    }
    const nextProjectPaths = overrides.projectPaths ?? projectPaths();
    if (nextProjectPaths.length > 0) {
      next.projectPaths = nextProjectPaths;
    }
    return next;
  };

  const addProjectPath = async (): Promise<void> => {
    const value = projectPathDraft().trim();
    if (!value || projectPaths().includes(value)) {
      return;
    }
    const nextProjectPaths = [...projectPaths(), value];
    const response = await runOperation({
      config: configInput({ projectPaths: nextProjectPaths }),
      type: 'save-config',
    });
    if (response?.type !== 'save-config') {
      return;
    }
    await requestSnapshotReplacement(response.result, `Project path added: ${value}.`);
    setProjectPathDraft('');
  };

  const removeProjectPath = async (value: string): Promise<void> => {
    const nextProjectPaths = projectPaths().filter((projectPath) => projectPath !== value);
    const response = await runOperation({
      config: configInput({ projectPaths: nextProjectPaths }),
      type: 'save-config',
    });
    if (response?.type === 'save-config') {
      await requestSnapshotReplacement(response.result, `Project path removed: ${value}.`);
    }
  };

  const saveConfig = async (nextSourceRepoPath: string): Promise<void> => {
    const response = await runOperation({
      config: configInput({ sourceRepoPath: nextSourceRepoPath }),
      type: 'save-config',
    });
    if (response?.type !== 'save-config') {
      return;
    }
    if (response.result.ok) {
      setSourceRepoPathDirty(false);
      setSourceRepoPath(response.result.data.config.sourceRepoPath ?? '');
    }
    await requestSnapshotReplacement(response.result, 'Skill source saved.');
  };

  const toggleSkill = async (skillName: string, enabled: boolean): Promise<void> => {
    const response = await runOperation({ enabled, skillName, type: 'toggle' });
    if (response?.type === 'toggle') {
      await applyReconcileResult(response.result, enabled ? `Enabled ${skillName}` : `Disabled ${skillName}`);
    }
  };

  const reconcileSkill = async (skillName: string): Promise<void> => {
    const response = await runOperation({ skillName, type: 'reconcile-one' });
    if (response?.type === 'reconcile-one') {
      await applyReconcileResult(response.result, `Reconciled ${skillName}`);
    }
  };

  const previewReconcile = async (): Promise<void> => {
    const response = await runOperation({ type: 'preview-reconcile' });
    if (response?.type !== 'preview-reconcile') {
      return;
    }
    const next = response.result;
    if (!next.ok) {
      setOperationNotice({ message: next.error.message, tone: 'error' });
      return;
    }
    await requestSnapshotReplacement(
      { data: next.data.snapshot, ok: true },
      'Reconcile preview refreshed.',
      false,
      () => setReconcilePlan(describeReconcileActions(next.data.actions, next.data.snapshot.targets)),
    );
  };

  const applyReconcile = async (): Promise<void> => {
    const response = await runOperation({ type: 'reconcile-all' });
    if (response?.type === 'reconcile-all') {
      await applyReconcileResult(response.result, 'Reconciled active skills');
    }
  };

  const createTargetDirectory = async (targetId: string): Promise<void> => {
    const response = await runOperation({ targetId, type: 'create-target' });
    if (response?.type === 'create-target') {
      await requestSnapshotReplacement(response.result, `Created target directory ${targetId}.`);
    }
  };

  const refreshSkills = async (): Promise<void> => {
    const response = await runOperation({ type: 'refresh' });
    if (response?.type !== 'refresh') {
      return;
    }
    setKnownProjectPathsResult(response.knownProjectPaths);
    queryClient.setQueryData<SkillsRouteInitialData>(webQueryKeys.skillsInitial, (current) =>
      current ? { ...current, knownProjectPaths: response.knownProjectPaths } : current,
    );
    await requestSnapshotReplacement(response.result, 'Skills refreshed.', true);
  };

  const updateSourceRepoPath = (value: string): void => {
    setSourceRepoPath(value);
    setSourceRepoPathDirty(value !== (snapshot()?.config.sourceRepoPath ?? ''));
  };

  const applyWorkspaceSnapshot = (nextSnapshot: SkillManagementSnapshot): Promise<boolean> =>
    requestSnapshotReplacement({ data: nextSnapshot, ok: true }, 'Skill snapshot updated.');

  const discardDirtySnapshot = async (): Promise<void> => {
    const pending = pendingSnapshotReplacement();
    if (pending === undefined) {
      return;
    }
    dirtyMarkdownDraft()?.discard();
    setPendingSnapshotReplacement();
    setDirtyMarkdownDraft();
    await commitSnapshotResult({ data: pending.snapshot, ok: true }, pending.message, pending.refreshDependents);
    pending.afterCommit?.();
  };

  return {
    addProjectPath,
    applyReconcile,
    applyWorkspaceSnapshot,
    cancelReconcile: () => setReconcilePlan(null),
    createTargetDirectory,
    discardDirtySnapshot,
    errorMessage,
    keepDirtySnapshot: () => setPendingSnapshotReplacement(),
    knownProjectPaths,
    knownProjectPathsError,
    markdownRefreshVersion,
    operationNotice,
    pendingOperation,
    pendingSnapshotReplacement,
    previewReconcile,
    projectInventories,
    projectInventoriesLoading: () => projectInventoriesQuery.isFetching,
    projectPathDraft,
    projectPaths,
    reconcilePlan,
    reconcileSkill,
    refreshSkills,
    removeProjectPath,
    result,
    saveConfig,
    setDirtyMarkdownDraft,
    setOperationNotice,
    setProjectPathDraft,
    snapshot,
    sourceRepoPath,
    toggleSkill,
    updateSourceRepoPath,
  };
};
