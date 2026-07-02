import type {
  Projection,
  ProjectionAction,
  ProjectionState,
  SkillManagementSnapshot,
  SkillTarget,
  SkillValidationStatus,
  SourceSkill,
} from '@ai-usage/skills';

export type SkillInvocation = 'auto' | 'manual';
export type MatrixCellState = ProjectionState | 'not-applicable';

export interface SkillMatrixCell {
  label: string;
  state: MatrixCellState;
  targetId: string;
}

export interface SkillMatrixRow {
  cells: readonly SkillMatrixCell[];
  description: string;
  enabled: boolean;
  invocation: SkillInvocation;
  name: string;
  origin: string | null;
  tokenFlag: boolean;
  tokenTotal: number | null;
  validationStatus: SkillValidationStatus;
}

export interface SkillMatrix {
  rows: readonly SkillMatrixRow[];
  targets: readonly SkillTarget[];
}

export interface SkillHealthSummary {
  blockedCount: number;
  consolidateCount: number;
  disabledCount: number;
  expectedLinkCount: number;
  healthyLinkCount: number;
  toLinkCount: number;
  toRepairCount: number;
}

export interface UnmanagedGroup {
  copies: number;
  symlinks: number;
  targetId: string;
  targetLabel: string;
  targetPath: string;
  total: number;
}

export interface SkillRowFilter {
  invocation?: SkillInvocation;
  origin?: string;
  query?: string;
}

const repairStates = new Set<ProjectionState>(['broken-link', 'wrong-target', 'missing-target']);
const blockedStates = new Set<ProjectionState>([
  'unmanaged-copy',
  'unmanaged-symlink',
  'duplicate-name-conflict',
  'duplicate-same-content',
]);
const reconciliableStates = new Set<ProjectionState>(['missing', 'broken-link', 'wrong-target']);
const tokenDiagnosticCodes = new Set(['SkillFileTooLarge', 'SkillFileLimitExceeded']);

export const projectionStateLabel = (state: ProjectionState): string => {
  switch (state) {
    case 'linked':
      return 'Linked';
    case 'missing':
      return 'Not linked';
    case 'broken-link':
      return 'Broken link';
    case 'wrong-target':
      return 'Wrong target';
    case 'unmanaged-copy':
      return 'Unmanaged copy';
    case 'unmanaged-symlink':
      return 'Unmanaged symlink';
    case 'duplicate-same-content':
      return 'Duplicate';
    case 'duplicate-name-conflict':
      return 'Name conflict';
    case 'disabled-exposed':
      return 'Disabled exposed';
    case 'missing-target':
      return 'Missing target';
    default:
      return state;
  }
};

export const skillInvocation = (skill: SourceSkill): SkillInvocation =>
  skill.manifest.fields.some((field) => field.key === 'disable-model-invocation' && field.value === true)
    ? 'manual'
    : 'auto';

const rowSort = (left: SourceSkill, right: SourceSkill) => {
  if (left.enabled !== right.enabled) {
    return left.enabled ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
};

const projectionFor = (
  projections: readonly Projection[],
  skillName: string,
  targetId: string,
): Projection | undefined =>
  projections.find((projection) => projection.skillName === skillName && projection.targetId === targetId);

export const buildSkillMatrix = (snapshot: SkillManagementSnapshot): SkillMatrix => {
  const targets = snapshot.targets.filter((target) => target.enabled);
  const rows = snapshot.skills.toSorted(rowSort).map((skill) => ({
    cells: targets.map((target) => {
      if (!skill.enabled) {
        return {
          label: 'Disabled',
          state: 'not-applicable',
          targetId: target.id,
        } satisfies SkillMatrixCell;
      }
      const projection = projectionFor(snapshot.projections, skill.name, target.id);
      return {
        label: projection ? projectionStateLabel(projection.state) : 'Not linked',
        state: projection?.state ?? 'missing',
        targetId: target.id,
      } satisfies SkillMatrixCell;
    }),
    description: skill.description,
    enabled: skill.enabled,
    invocation: skillInvocation(skill),
    name: skill.name,
    origin: snapshot.sourceState.skillOriginByName?.[skill.name] ?? null,
    tokenFlag: skill.diagnostics.some((diagnostic) => tokenDiagnosticCodes.has(diagnostic.code)),
    tokenTotal: skill.tokenCount?.total ?? null,
    validationStatus: skill.validationStatus,
  }));
  return { rows, targets };
};

export const buildSkillHealthSummary = (snapshot: SkillManagementSnapshot): SkillHealthSummary => {
  const countableSkills = snapshot.skills.filter((skill) => skill.enabled && skill.validationStatus !== 'invalid');
  const activeTargets = snapshot.targets.filter((target) => target.enabled);
  let healthyLinkCount = 0;
  let toLinkCount = 0;
  let toRepairCount = 0;
  let blockedCount = 0;

  for (const skill of countableSkills) {
    for (const target of activeTargets) {
      const state = projectionFor(snapshot.projections, skill.name, target.id)?.state ?? 'missing';
      if (state === 'linked') {
        healthyLinkCount += 1;
      } else if (state === 'missing') {
        toLinkCount += 1;
      } else if (repairStates.has(state)) {
        toRepairCount += 1;
      } else if (blockedStates.has(state)) {
        blockedCount += 1;
      }
    }
  }

  return {
    blockedCount,
    consolidateCount: snapshot.unmanagedEntries.length,
    disabledCount: snapshot.skills.filter((skill) => !skill.enabled).length,
    expectedLinkCount: countableSkills.length * activeTargets.length,
    healthyLinkCount,
    toLinkCount,
    toRepairCount,
  };
};

export const groupUnmanagedEntries = (snapshot: SkillManagementSnapshot): readonly UnmanagedGroup[] => {
  const targetsById = new Map(snapshot.targets.map((target) => [target.id, target]));
  const groups = new Map<string, UnmanagedGroup>();
  for (const entry of snapshot.unmanagedEntries) {
    const target = targetsById.get(entry.targetId);
    const existing = groups.get(entry.targetId) ?? {
      copies: 0,
      symlinks: 0,
      targetId: entry.targetId,
      targetLabel: target?.label ?? entry.targetId,
      targetPath: target?.path ?? '',
      total: 0,
    };
    groups.set(entry.targetId, {
      ...existing,
      copies: existing.copies + (entry.state === 'unmanaged-copy' ? 1 : 0),
      symlinks: existing.symlinks + (entry.state === 'unmanaged-symlink' ? 1 : 0),
      total: existing.total + 1,
    });
  }
  return [...groups.values()].sort((left, right) => left.targetLabel.localeCompare(right.targetLabel));
};

export const filterMatrixRows = (
  rows: readonly SkillMatrixRow[],
  filter: SkillRowFilter,
): readonly SkillMatrixRow[] => {
  const query = filter.query?.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.invocation !== undefined && row.invocation !== filter.invocation) {
      return false;
    }
    if (filter.origin !== undefined && row.origin !== filter.origin) {
      return false;
    }
    if (!query) {
      return true;
    }
    return row.name.toLowerCase().includes(query) || row.description.toLowerCase().includes(query);
  });
};

export const canReconcileAll = (snapshot: SkillManagementSnapshot): boolean => {
  // Same countable rule as the health buckets and the reconcile workflow:
  // warning-status skills stay reconciliable, only invalid ones are excluded.
  const countableSkills = snapshot.skills.filter((skill) => skill.enabled && skill.validationStatus !== 'invalid');
  const activeTargets = snapshot.targets.filter((target) => target.enabled);
  for (const skill of countableSkills) {
    for (const target of activeTargets) {
      const state = projectionFor(snapshot.projections, skill.name, target.id)?.state ?? 'missing';
      if (reconciliableStates.has(state)) {
        return true;
      }
    }
  }
  return false;
};

export interface ReconcilePlanSummary {
  apply: readonly string[];
  skipped: readonly string[];
}

const reconcileActionVerb: Record<string, string> = {
  'create-symlink': 'link',
  'repair-symlink': 'repair',
  'unlink-managed-symlink': 'unlink',
};

export const describeReconcileActions = (
  actions: readonly ProjectionAction[],
  targets: readonly SkillTarget[],
): ReconcilePlanSummary => {
  const targetLabel = (targetId: string) => targets.find((target) => target.id === targetId)?.label ?? targetId;
  const apply: string[] = [];
  const skipped: string[] = [];
  for (const action of actions) {
    if (action.type === 'refuse-unmanaged-mutation') {
      skipped.push(`${action.skillName} @ ${targetLabel(action.targetId)} — ${action.reason}`);
      continue;
    }
    if (action.type === 'noop') {
      continue;
    }
    apply.push(
      `${reconcileActionVerb[action.type]} ${action.skillName} @ ${targetLabel(action.targetId)} → ${action.path}`,
    );
  }
  return { apply, skipped };
};
