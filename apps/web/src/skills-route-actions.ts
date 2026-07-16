import type { ProjectionAction, SkillManagementConfig, SkillManagementSnapshot } from '@ai-usage/skills';
import type {
  KnownProjectPathsResult,
  SkillReconcileServerResult,
  SkillSnapshotResult,
} from './skills-client-contracts';
import { count, describeReconcileActions, type ReconcilePlanSummary } from './skills-page-model';
import type { SkillsMutationRequest, SkillsMutationResult } from './skills-query-operations';
import type { OperationNotice } from './skills-route-controller-state';

interface SkillsRouteActionPorts {
  mutate: (request: SkillsMutationRequest) => Promise<SkillsMutationResult | undefined>;
  projectPathDraft: () => string;
  projectPaths: () => readonly string[];
  replaceSnapshot: (
    next: SkillSnapshotResult,
    message: string,
    refreshDependents?: boolean,
    afterCommit?: () => void,
  ) => Promise<boolean>;
  setKnownProjectPaths: (result: KnownProjectPathsResult) => void;
  setKnownProjectPathsCache: (result: KnownProjectPathsResult) => void;
  setNotice: (notice: OperationNotice | null) => void;
  setProjectPathDraft: (value: string) => void;
  setReconcilePlan: (plan: ReconcilePlanSummary | null) => void;
  setSourceRepoPath: (value: string) => void;
  setSourceRepoPathDirty: (dirty: boolean) => void;
  snapshot: () => SkillManagementSnapshot | undefined;
}

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
  const action = applied.length === 1 ? applied[0] : undefined;
  if (action?.type === 'create-symlink') {
    return `${action.skillName} linked to ${targetLabel(snapshot, action.targetId)}.`;
  }
  if (action?.type === 'repair-symlink') {
    return `${action.skillName} repaired in ${targetLabel(snapshot, action.targetId)}.`;
  }
  if (action?.type === 'unlink-managed-symlink') {
    return `${action.skillName} unlinked from ${targetLabel(snapshot, action.targetId)}.`;
  }
  return `${fallback}: ${count(applied.length, 'change')} applied.`;
};

export const createSkillsRouteActions = (ports: SkillsRouteActionPorts) => {
  const configInput = (overrides: { projectPaths?: readonly string[]; sourceRepoPath?: string } = {}) => {
    const current = ports.snapshot()?.config ?? {};
    const { projectPaths: _projectPaths, ...currentWithoutProjectPaths } = current;
    const next: SkillManagementConfig = currentWithoutProjectPaths;
    const source = (overrides.sourceRepoPath ?? current.sourceRepoPath ?? '').trim();
    if (source) {
      next.sourceRepoPath = source;
    }
    const nextProjectPaths = overrides.projectPaths ?? ports.projectPaths();
    if (nextProjectPaths.length > 0) {
      next.projectPaths = nextProjectPaths;
    }
    return next;
  };

  const applyReconcileResult = async (next: SkillReconcileServerResult, fallbackMessage: string): Promise<void> => {
    if (!next.ok) {
      ports.setNotice({ message: next.error.message, tone: 'error' });
      return;
    }
    await ports.replaceSnapshot(
      { data: next.data.snapshot, ok: true },
      actionNotice(next.data.actions, next.data.snapshot, fallbackMessage),
    );
  };

  const addProjectPath = async (): Promise<void> => {
    const value = ports.projectPathDraft().trim();
    if (!value || ports.projectPaths().includes(value)) {
      return;
    }
    const response = await ports.mutate({
      config: configInput({ projectPaths: [...ports.projectPaths(), value] }),
      type: 'save-config',
    });
    if (response?.type !== 'save-config') {
      return;
    }
    await ports.replaceSnapshot(response.result, `Project path added: ${value}.`);
    ports.setProjectPathDraft('');
  };

  const removeProjectPath = async (value: string): Promise<void> => {
    const response = await ports.mutate({
      config: configInput({ projectPaths: ports.projectPaths().filter((projectPath) => projectPath !== value) }),
      type: 'save-config',
    });
    if (response?.type === 'save-config') {
      await ports.replaceSnapshot(response.result, `Project path removed: ${value}.`);
    }
  };

  const saveConfig = async (nextSourceRepoPath: string): Promise<void> => {
    const response = await ports.mutate({
      config: configInput({ sourceRepoPath: nextSourceRepoPath }),
      type: 'save-config',
    });
    if (response?.type !== 'save-config') {
      return;
    }
    if (response.result.ok) {
      ports.setSourceRepoPathDirty(false);
      ports.setSourceRepoPath(response.result.data.config.sourceRepoPath ?? '');
    }
    await ports.replaceSnapshot(response.result, 'Skill source saved.');
  };

  const toggleSkill = async (skillName: string, enabled: boolean): Promise<void> => {
    const response = await ports.mutate({ enabled, skillName, type: 'toggle' });
    if (response?.type === 'toggle') {
      await applyReconcileResult(response.result, enabled ? `Enabled ${skillName}` : `Disabled ${skillName}`);
    }
  };

  const reconcileSkill = async (skillName: string): Promise<void> => {
    const response = await ports.mutate({ skillName, type: 'reconcile-one' });
    if (response?.type === 'reconcile-one') {
      await applyReconcileResult(response.result, `Reconciled ${skillName}`);
    }
  };

  const previewReconcile = async (): Promise<void> => {
    const response = await ports.mutate({ type: 'preview-reconcile' });
    if (response?.type !== 'preview-reconcile') {
      return;
    }
    if (!response.result.ok) {
      ports.setNotice({ message: response.result.error.message, tone: 'error' });
      return;
    }
    const reconcile = response.result.data;
    await ports.replaceSnapshot({ data: reconcile.snapshot, ok: true }, 'Reconcile preview refreshed.', false, () =>
      ports.setReconcilePlan(describeReconcileActions(reconcile.actions, reconcile.snapshot.targets)),
    );
  };

  const applyReconcile = async (): Promise<void> => {
    const response = await ports.mutate({ type: 'reconcile-all' });
    if (response?.type === 'reconcile-all') {
      await applyReconcileResult(response.result, 'Reconciled active skills');
    }
  };

  const createTargetDirectory = async (targetId: string): Promise<void> => {
    const response = await ports.mutate({ targetId, type: 'create-target' });
    if (response?.type === 'create-target') {
      await ports.replaceSnapshot(response.result, `Created target directory ${targetId}.`);
    }
  };

  const refreshSkills = async (): Promise<void> => {
    const response = await ports.mutate({ type: 'refresh' });
    if (response?.type !== 'refresh') {
      return;
    }
    ports.setKnownProjectPaths(response.knownProjectPaths);
    ports.setKnownProjectPathsCache(response.knownProjectPaths);
    await ports.replaceSnapshot(response.result, 'Skills refreshed.', true);
  };

  const updateSourceRepoPath = (value: string): void => {
    ports.setSourceRepoPath(value);
    ports.setSourceRepoPathDirty(value !== (ports.snapshot()?.config.sourceRepoPath ?? ''));
  };

  return {
    addProjectPath,
    applyReconcile,
    createTargetDirectory,
    previewReconcile,
    reconcileSkill,
    refreshSkills,
    removeProjectPath,
    saveConfig,
    toggleSkill,
    updateSourceRepoPath,
  };
};
