import type { ProjectionAction, SkillManagementConfig, SkillManagementSnapshot } from '@ai-usage/skills';
import { parseSkillReconcileResult, parseSkillSnapshotResult } from '../../../../skills-client-contracts';
import {
  buildSkillMatrix,
  count,
  describeReconcileActions,
  filterMatrixRows,
  type MatrixCellState,
  type ReconcilePlanSummary,
  type SkillCellStateFilter,
  type SkillInvocation,
  type SkillRowFilter,
} from '../../../../skills-page-model';
import type { SkillsInventoryQueryClient } from '../../../query/options/skills';

export const skillStateFilterOrder = [
  'linked',
  'not-linked',
  'broken',
  'blocked',
  'disabled',
] as const satisfies readonly SkillCellStateFilter[];

/** One taxonomy across tiles, chips, and legend: linked · to link · to repair · blocked · disabled. */
export const skillStateFilterLabels: Readonly<Record<SkillCellStateFilter, string>> = {
  blocked: 'Blocked',
  broken: 'To repair',
  disabled: 'Disabled',
  linked: 'Linked',
  'not-linked': 'To link',
};

export type MatrixDotTone = 'broken' | 'copy' | 'linked' | 'missing' | 'none';

/**
 * The letterform inside an exposure mark. Shape and letter carry the state so two marks never
 * differ by hue alone — a dashed ring and a plain ring were indistinguishable at rendered size,
 * and the harness palette itself fails deutan vision between two of its hues.
 */
export const MATRIX_DOT_GLYPHS: Readonly<Record<MatrixDotTone, string>> = {
  broken: '!',
  copy: 'C',
  linked: '✓',
  missing: '→',
  none: '—',
};

export const matrixDotTone = (state: MatrixCellState): MatrixDotTone => {
  if (state === 'linked') {
    return 'linked';
  }
  if (state === 'missing') {
    return 'missing';
  }
  if (
    state === 'broken-link' ||
    state === 'wrong-target' ||
    state === 'missing-target' ||
    state === 'duplicate-name-conflict' ||
    state === 'disabled-exposed'
  ) {
    return 'broken';
  }
  if (state === 'unmanaged-copy' || state === 'unmanaged-symlink' || state === 'duplicate-same-content') {
    return 'copy';
  }
  return 'none';
};

export interface SkillsMatrixFilters {
  readonly cellState?: SkillCellStateFilter;
  readonly invocation?: SkillInvocation;
  readonly origin?: string;
  readonly query: string;
}

export const buildSkillsMatrixView = (snapshot: SkillManagementSnapshot, filters: SkillsMatrixFilters) => {
  const matrix = buildSkillMatrix(snapshot);
  const rowFilter: SkillRowFilter = { query: filters.query };
  if (filters.cellState !== undefined) {
    rowFilter.cellState = filters.cellState;
  }
  if (filters.invocation !== undefined) {
    rowFilter.invocation = filters.invocation;
  }
  if (filters.origin !== undefined) {
    rowFilter.origin = filters.origin;
  }
  const counts = new Map<SkillCellStateFilter, number>();
  for (const state of skillStateFilterOrder) {
    counts.set(state, filterMatrixRows(matrix.rows, { cellState: state }).length);
  }
  return {
    allCount: matrix.rows.length,
    autoCount: matrix.rows.filter((row) => row.invocation === 'auto').length,
    manualCount: matrix.rows.filter((row) => row.invocation === 'manual').length,
    matrix,
    origins: [...new Set(matrix.rows.flatMap((row) => (row.origin === null ? [] : [row.origin])))].sort(),
    rows: filterMatrixRows(matrix.rows, rowFilter),
    stateFilterCounts: counts,
  };
};

export type SkillsManagementOperation =
  | { readonly type: 'preview-reconcile' }
  | { readonly type: 'reconcile-all' }
  | { readonly skillName: string; readonly type: 'reconcile-skill' }
  | { readonly enabled: boolean; readonly skillName: string; readonly type: 'toggle-skill' };

export const previewReconcileOperation = { type: 'preview-reconcile' } as const;
export const reconcileAllOperation = { type: 'reconcile-all' } as const;
export const reconcileSkillOperation = (skillName: string): SkillsManagementOperation => ({
  skillName,
  type: 'reconcile-skill',
});

export interface SkillsManagementSuccess {
  readonly actions: readonly ProjectionAction[];
  readonly plan: ReconcilePlanSummary | null;
  readonly snapshot: SkillManagementSnapshot;
}

export type SkillsManagementResult =
  | { readonly error: string; readonly ok: false }
  | ({ readonly ok: true } & SkillsManagementSuccess);

export interface SkillsRefreshClient {
  refreshSkillManagementSnapshot(): Promise<unknown>;
}

export type SkillsRefreshResult =
  | { readonly error: string; readonly ok: false }
  | { readonly ok: true; readonly snapshot: SkillManagementSnapshot };

export const runSkillsRefreshOperation = async (client: SkillsRefreshClient): Promise<SkillsRefreshResult> => {
  const result = parseSkillSnapshotResult(await client.refreshSkillManagementSnapshot());
  return result.ok ? { ok: true, snapshot: result.data } : { error: result.error.message, ok: false };
};

export interface SkillsRefreshAcceptanceTarget {
  readonly publicationReady: boolean;
  readonly signature: string;
}

export type SkillsRefreshDecisionState = 'closed' | 'none' | 'pending';

export const skillsSnapshotAcceptanceSignature = (snapshot: SkillManagementSnapshot): string =>
  JSON.stringify(snapshot);

export const resolveSkillsRefreshAcceptance = (
  target: SkillsRefreshAcceptanceTarget | undefined,
  snapshot: SkillManagementSnapshot,
  decisionState: SkillsRefreshDecisionState,
): 'announce' | 'clear' | 'retain' => {
  if (target === undefined) {
    return 'retain';
  }
  const snapshotMatches = skillsSnapshotAcceptanceSignature(snapshot) === target.signature;
  if (snapshotMatches) {
    return target.publicationReady ? 'announce' : 'retain';
  }
  if (decisionState === 'closed') {
    return 'clear';
  }
  if (target.publicationReady && decisionState === 'none') {
    return 'clear';
  }
  return 'retain';
};

const targetLabel = (snapshot: SkillManagementSnapshot, targetId: string): string =>
  snapshot.targets.find((target) => target.id === targetId)?.label ?? targetId;

const managementFallbackMessage = (operation: SkillsManagementOperation): string => {
  if (operation.type === 'reconcile-all') {
    return 'Reconciled active skills';
  }
  if (operation.type === 'reconcile-skill') {
    return `Reconciled ${operation.skillName}`;
  }
  if (operation.type === 'toggle-skill') {
    return `${operation.enabled ? 'Enabled' : 'Disabled'} ${operation.skillName}`;
  }
  return 'Reconcile preview refreshed';
};

export const skillsManagementSuccessMessage = (
  operation: SkillsManagementOperation,
  result: SkillsManagementSuccess,
): string => {
  if (operation.type === 'preview-reconcile') {
    return 'Reconcile preview refreshed.';
  }
  const applied = result.actions.filter(
    (action) => action.type !== 'noop' && action.type !== 'refuse-unmanaged-mutation',
  );
  if (applied.length === 0) {
    // A toggle that moved no files still changed the skill's state, and the message says so —
    // "Nothing to change." after flipping a switch reads as the flip having failed.
    if (operation.type === 'toggle-skill') {
      return `${operation.enabled ? 'Enabled' : 'Disabled'} ${operation.skillName} — no file changes were needed.`;
    }
    return 'Nothing to change.';
  }
  const action = applied.length === 1 ? applied[0] : undefined;
  if (action?.type === 'create-symlink') {
    return `${action.skillName} linked to ${targetLabel(result.snapshot, action.targetId)}.`;
  }
  if (action?.type === 'repair-symlink') {
    return `${action.skillName} repaired in ${targetLabel(result.snapshot, action.targetId)}.`;
  }
  if (action?.type === 'unlink-managed-symlink') {
    return `${action.skillName} unlinked from ${targetLabel(result.snapshot, action.targetId)}.`;
  }
  return `${managementFallbackMessage(operation)}: ${count(applied.length, 'change')} applied.`;
};

export interface SkillsManagementClient {
  createManagedSkillTargetDirectory(input: { targetId: string }): Promise<unknown>;
  previewReconcileAllManagedSkills(): Promise<unknown>;
  reconcileAllManagedSkills(): Promise<unknown>;
  reconcileManagedSkill(skillName: string): Promise<unknown>;
  saveSkillManagementConfig(input: SkillManagementConfig): Promise<unknown>;
  toggleManagedSkill(input: { enabled: boolean; skillName: string }): Promise<unknown>;
}
export type SkillsConfigurationClient = SkillsManagementClient & SkillsInventoryQueryClient;

export interface SkillsSourceRepositoryDraft {
  readonly dirty: boolean;
  readonly value: string;
}

export const sourceRepositoryDraftFrom = (snapshot: SkillManagementSnapshot): SkillsSourceRepositoryDraft => ({
  dirty: false,
  value: snapshot.config.sourceRepoPath ?? '',
});

export const editSourceRepositoryDraft = (
  value: string,
  snapshot: SkillManagementSnapshot,
): SkillsSourceRepositoryDraft => ({ dirty: value !== (snapshot.config.sourceRepoPath ?? ''), value });

export const syncSourceRepositoryDraft = (
  draft: SkillsSourceRepositoryDraft,
  snapshot: SkillManagementSnapshot,
): SkillsSourceRepositoryDraft => (draft.dirty ? draft : sourceRepositoryDraftFrom(snapshot));

export const skillsConfigInput = (
  snapshot: SkillManagementSnapshot,
  overrides: { readonly projectPaths?: readonly string[]; readonly sourceRepoPath?: string } = {},
): SkillManagementConfig => {
  const { projectPaths: _projectPaths, sourceRepoPath: _sourceRepoPath, ...retained } = snapshot.config;
  const sourceRepoPath = (overrides.sourceRepoPath ?? snapshot.config.sourceRepoPath ?? '').trim();
  const projectPaths = overrides.projectPaths ?? snapshot.config.projectPaths ?? [];
  return {
    ...retained,
    ...(sourceRepoPath.length > 0 ? { sourceRepoPath } : {}),
    ...(projectPaths.length > 0 ? { projectPaths } : {}),
  };
};

export type SkillsConfigurationOperation =
  | { readonly config: SkillManagementConfig; readonly type: 'save-config' }
  | { readonly targetId: string; readonly type: 'create-target' };
export const skillsConfigurationRefreshesDependents = (operation: SkillsConfigurationOperation): boolean =>
  operation.type === 'save-config';

export type SkillsConfigurationResult =
  | { readonly error: string; readonly ok: false }
  | { readonly ok: true; readonly snapshot: SkillManagementSnapshot };

export const runSkillsConfigurationOperation = async (
  client: SkillsManagementClient,
  operation: SkillsConfigurationOperation,
): Promise<SkillsConfigurationResult> => {
  const wireResult =
    operation.type === 'save-config'
      ? await client.saveSkillManagementConfig(operation.config)
      : await client.createManagedSkillTargetDirectory({ targetId: operation.targetId });
  const result = parseSkillSnapshotResult(wireResult);
  return result.ok ? { ok: true, snapshot: result.data } : { error: result.error.message, ok: false };
};

export interface InspectorMediaQuery {
  addEventListener(type: 'change', listener: () => void): void;
  readonly matches: boolean;
  removeEventListener(type: 'change', listener: () => void): void;
}

export const observeInspectorDisclosure = (
  mediaQuery: InspectorMediaQuery,
  onChange: (open: boolean) => void,
): (() => void) => {
  const synchronize = (): void => onChange(mediaQuery.matches);
  synchronize();
  mediaQuery.addEventListener('change', synchronize);
  return () => mediaQuery.removeEventListener('change', synchronize);
};

const unwrapReconcile = (wireResult: unknown, preview: boolean): SkillsManagementResult => {
  const result = parseSkillReconcileResult(wireResult);
  if (!result.ok) {
    return { error: result.error.message, ok: false };
  }
  return {
    actions: result.data.actions,
    ok: true,
    plan: preview ? describeReconcileActions(result.data.actions, result.data.snapshot.targets) : null,
    snapshot: result.data.snapshot,
  };
};

export const runSkillsManagementOperation = async (
  client: SkillsManagementClient,
  operation: SkillsManagementOperation,
): Promise<SkillsManagementResult> => {
  if (operation.type === 'preview-reconcile') {
    return unwrapReconcile(await client.previewReconcileAllManagedSkills(), true);
  }
  if (operation.type === 'reconcile-all') {
    return unwrapReconcile(await client.reconcileAllManagedSkills(), false);
  }
  if (operation.type === 'reconcile-skill') {
    return unwrapReconcile(await client.reconcileManagedSkill(operation.skillName), false);
  }
  return unwrapReconcile(
    await client.toggleManagedSkill({ enabled: operation.enabled, skillName: operation.skillName }),
    false,
  );
};

export const toggleOperation = (skillName: string, enabled: boolean): SkillsManagementOperation => ({
  enabled,
  skillName,
  type: 'toggle-skill',
});
