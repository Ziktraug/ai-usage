import type { ProjectionAction, SkillManagementConfig, SkillManagementSnapshot } from '@ai-usage/skills';
import { type Accessor, createEffect, createMemo, createResource, createSignal } from 'solid-js';
import {
  createManagedSkillTargetDirectory,
  getKnownSkillProjectPaths,
  getSkillProjectInventories,
  type KnownSkillProjectPath,
  previewReconcileAllManagedSkills,
  reconcileAllManagedSkills,
  reconcileManagedSkill,
  refreshSkillManagementSnapshot,
  saveSkillManagementConfig,
  toggleManagedSkill,
} from './server/skills';
import { count, describeReconcileActions, type ReconcilePlanSummary } from './skills-page-model';
import { snapshotRemovesDirtySkill } from './skills-route-model';
import type { ProjectInventoriesResult, SkillMarkdownDraftGuard } from './skills-workspace';

export type SkillSnapshotResult =
  | { ok: true; data: SkillManagementSnapshot }
  | { ok: false; error: { message: string; tag: string } };

export type KnownProjectPathsResult =
  | { ok: true; data: readonly KnownSkillProjectPath[] }
  | { ok: false; error: { message: string; tag: string } };

interface SkillReconcileResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

type SkillReconcileServerResult =
  | { ok: true; data: SkillReconcileResult }
  | { ok: false; error: { message: string; tag: string } };

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

interface SkillsRouteLoaderData {
  knownProjectPaths: unknown;
  skills: unknown;
}

const errorMessageFrom = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const skillSnapshotResultFrom = (value: unknown): SkillSnapshotResult => {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return { ok: false, error: { message: 'Invalid skills snapshot response', tag: 'InvalidResponse' } };
  }
  return value as SkillSnapshotResult;
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

export const createSkillsRouteController = (loaderData: Accessor<SkillsRouteLoaderData>) => {
  const initialData = loaderData();
  const [result, setResult] = createSignal<SkillSnapshotResult>(skillSnapshotResultFrom(initialData.skills));
  const [knownProjectPathsResult, setKnownProjectPathsResult] = createSignal<KnownProjectPathsResult>(
    initialData.knownProjectPaths as KnownProjectPathsResult,
  );
  const [pendingOperation, setPendingOperation] = createSignal<string | null>(null);
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
  const [projectInventories, { refetch: refetchProjectInventories }] = createResource(
    projectInventoriesKey,
    async () => (await getSkillProjectInventories()) as ProjectInventoriesResult,
  );

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
    setOperationNotice(next.ok ? { message, tone: 'ok' } : { message: next.error.message, tone: 'error' });
    if (!(next.ok && refreshDependents)) {
      return;
    }
    if (next.data.configured) {
      await refetchProjectInventories();
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

  let observedLoaderData = initialData;
  createEffect(async () => {
    const nextLoaderData = loaderData();
    if (nextLoaderData === observedLoaderData) {
      return;
    }
    observedLoaderData = nextLoaderData;
    setKnownProjectPathsResult(nextLoaderData.knownProjectPaths as KnownProjectPathsResult);
    await requestSnapshotReplacement(skillSnapshotResultFrom(nextLoaderData.skills), 'Skills reloaded.', true);
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

  const runOperation = async (operation: string, action: () => Promise<void>): Promise<void> => {
    if (pendingOperation()) {
      return;
    }
    setPendingOperation(operation);
    setOperationNotice(null);
    setReconcilePlan(null);
    try {
      await action();
    } catch (error) {
      setOperationNotice({ message: errorMessageFrom(error), tone: 'error' });
    } finally {
      setPendingOperation(null);
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

  const addProjectPath = (): Promise<void> | undefined => {
    const value = projectPathDraft().trim();
    if (!value || projectPaths().includes(value)) {
      return;
    }
    const nextProjectPaths = [...projectPaths(), value];
    return runOperation(`project:add:${value}`, async () => {
      await requestSnapshotReplacement(
        skillSnapshotResultFrom(
          await saveSkillManagementConfig({ data: configInput({ projectPaths: nextProjectPaths }) }),
        ),
        `Project path added: ${value}.`,
      );
      setProjectPathDraft('');
    });
  };

  const removeProjectPath = (value: string): Promise<void> =>
    runOperation(`project:remove:${value}`, async () => {
      const nextProjectPaths = projectPaths().filter((projectPath) => projectPath !== value);
      await requestSnapshotReplacement(
        skillSnapshotResultFrom(
          await saveSkillManagementConfig({ data: configInput({ projectPaths: nextProjectPaths }) }),
        ),
        `Project path removed: ${value}.`,
      );
    });

  const saveConfig = (nextSourceRepoPath: string): Promise<void> =>
    runOperation('save-config', async () => {
      const next = skillSnapshotResultFrom(
        await saveSkillManagementConfig({ data: configInput({ sourceRepoPath: nextSourceRepoPath }) }),
      );
      if (next.ok) {
        setSourceRepoPathDirty(false);
        setSourceRepoPath(next.data.config.sourceRepoPath ?? '');
      }
      await requestSnapshotReplacement(next, 'Skill source saved.');
    });

  const toggleSkill = (skillName: string, enabled: boolean): Promise<void> =>
    runOperation(`toggle:${skillName}`, async () => {
      await applyReconcileResult(
        (await toggleManagedSkill({ data: { enabled, skillName } })) as SkillReconcileServerResult,
        enabled ? `Enabled ${skillName}` : `Disabled ${skillName}`,
      );
    });

  const reconcileSkill = (skillName: string): Promise<void> =>
    runOperation(`reconcile:${skillName}`, async () => {
      await applyReconcileResult(
        (await reconcileManagedSkill({ data: skillName })) as SkillReconcileServerResult,
        `Reconciled ${skillName}`,
      );
    });

  const previewReconcile = (): Promise<void> =>
    runOperation('preview-reconcile', async () => {
      const next = (await previewReconcileAllManagedSkills()) as SkillReconcileServerResult;
      if (!next.ok) {
        setOperationNotice({ message: next.error.message, tone: 'error' });
        return;
      }
      await requestSnapshotReplacement(
        { ok: true, data: next.data.snapshot },
        'Reconcile preview refreshed.',
        false,
        () => setReconcilePlan(describeReconcileActions(next.data.actions, next.data.snapshot.targets)),
      );
    });

  const applyReconcile = (): Promise<void> =>
    runOperation('reconcile-all', async () => {
      await applyReconcileResult(
        (await reconcileAllManagedSkills()) as SkillReconcileServerResult,
        'Reconciled active skills',
      );
    });

  const createTargetDirectory = (targetId: string): Promise<void> =>
    runOperation(`target:${targetId}`, async () => {
      await requestSnapshotReplacement(
        skillSnapshotResultFrom(await createManagedSkillTargetDirectory({ data: { targetId } })),
        `Created target directory ${targetId}.`,
      );
    });

  const refreshSkills = (): Promise<void> =>
    runOperation('refresh-skills', async () => {
      const [nextSnapshot, nextKnownProjectPaths] = await Promise.all([
        refreshSkillManagementSnapshot(),
        getKnownSkillProjectPaths(),
      ]);
      setKnownProjectPathsResult(nextKnownProjectPaths as KnownProjectPathsResult);
      await requestSnapshotReplacement(skillSnapshotResultFrom(nextSnapshot), 'Skills refreshed.', true);
    });

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
