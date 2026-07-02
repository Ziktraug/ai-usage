import type {
  Projection,
  ProjectionAction,
  ProjectionState,
  ProjectSkillInventory,
  ProjectSkillObservation,
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

export type SkillSelection =
  | { type: 'global-scope' }
  | { skillName: string; type: 'global-skill' }
  | { projectPath: string; type: 'project-scope' }
  | { projectPath: string; skillName: string; type: 'project-skill' };

export interface SkillTreeSkillNode {
  attentionSummary: string;
  description: string;
  enabled: boolean;
  issueCount: number;
  key: string;
  name: string;
  pendingLinkCount: number;
  selection: SkillSelection;
  validationStatus: SkillValidationStatus;
}

export interface SkillTreeScopeNode {
  attentionSummary: string;
  hasSkills: boolean;
  issueCount: number;
  key: string;
  label: string;
  path?: string;
  pendingLinkCount: number;
  selection: SkillSelection;
  shortPath?: string;
  skills: readonly SkillTreeSkillNode[];
  type: 'global' | 'project';
}

export interface SkillTreeModel {
  emptyScopes: readonly SkillTreeScopeNode[];
  scopes: readonly SkillTreeScopeNode[];
}

export interface KnownProjectScope {
  label: string;
  path: string;
}

export interface ProjectSkillRow {
  description: string;
  invocation: SkillInvocation;
  name: string;
  observations: readonly ProjectSkillObservation[];
  tokenTotal: number | null;
  validationStatus: SkillValidationStatus;
}

export interface GlobalSkillExposure {
  actualPath?: string;
  canReconcile: boolean;
  expectedPath: string;
  label: string;
  state: MatrixCellState;
  targetId: string;
}

export interface SkillHealthSummary {
  blockedCount: number;
  consolidateCopies: number;
  consolidateCount: number;
  consolidateSymlinks: number;
  disabledCount: number;
  expectedLinkCount: number;
  healthyLinkCount: number;
  toLinkCount: number;
  toRepairCount: number;
}

export interface UnmanagedEntry {
  name: string;
  path: string;
  state: 'unmanaged-copy' | 'unmanaged-symlink';
}

export interface UnmanagedGroup {
  copies: number;
  entries: readonly UnmanagedEntry[];
  symlinks: number;
  targetId: string;
  targetLabel: string;
  targetPath: string;
  total: number;
}

export type SkillCellStateFilter = 'blocked' | 'broken' | 'disabled' | 'linked' | 'not-linked';

export interface SkillRowFilter {
  cellState?: SkillCellStateFilter;
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
const projectAttentionPlacements = new Set<ProjectSkillObservation['placement']>(['external-symlink']);

interface AttentionCounts {
  attentionSummary: string;
  issueCount: number;
  pendingLinkCount: number;
}

export const count = (value: number, singular: string, plural = `${singular}s`): string =>
  `${value} ${value === 1 ? singular : plural}`;

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

const attentionSummary = (counts: readonly [number, string, string?][]): string =>
  counts
    .filter(([value]) => value > 0)
    .map(([value, singular, plural]) => count(value, singular, plural))
    .join(' · ');

export const canReconcileProjectionState = (state: MatrixCellState): boolean =>
  state !== 'not-applicable' && reconciliableStates.has(state);

const globalSkillAttention = (snapshot: SkillManagementSnapshot, skill: SourceSkill): AttentionCounts => {
  const invalidCount = skill.validationStatus === 'invalid' ? 1 : 0;
  let repairCount = 0;
  let blockedCount = 0;
  let disabledExposedCount = 0;
  let pendingLinkCount = 0;

  if (skill.enabled && skill.validationStatus !== 'invalid') {
    for (const target of snapshot.targets.filter((target) => target.enabled)) {
      const state = projectionFor(snapshot.projections, skill.name, target.id)?.state ?? 'missing';
      if (state === 'missing') {
        pendingLinkCount += 1;
      } else if (repairStates.has(state)) {
        repairCount += 1;
      } else if (blockedStates.has(state)) {
        blockedCount += 1;
      } else if (state === 'disabled-exposed') {
        disabledExposedCount += 1;
      }
    }
  }

  const issueCount = invalidCount + repairCount + blockedCount + disabledExposedCount;
  return {
    attentionSummary: attentionSummary([
      [invalidCount, 'invalid skill'],
      [repairCount, 'to repair', 'to repair'],
      [blockedCount, 'blocked', 'blocked'],
      [disabledExposedCount, 'disabled exposure'],
      [pendingLinkCount, 'not linked', 'not linked'],
    ]),
    issueCount,
    pendingLinkCount,
  };
};

export const globalSkillAttentionCount = (snapshot: SkillManagementSnapshot, skill: SourceSkill): number =>
  globalSkillAttention(snapshot, skill).issueCount;

const projectSkillAttention = (row: ProjectSkillRow): AttentionCounts => {
  const issueCount = row.observations.filter(
    (observation) =>
      observation.validationStatus !== 'valid' ||
      observation.diagnostics.length > 0 ||
      projectAttentionPlacements.has(observation.placement),
  ).length;
  return {
    attentionSummary: attentionSummary([[issueCount, 'project issue']]),
    issueCount,
    pendingLinkCount: 0,
  };
};

const strongestValidationStatus = (
  left: SkillValidationStatus,
  right: SkillValidationStatus,
): SkillValidationStatus => {
  if (left === 'invalid' || right === 'invalid') {
    return 'invalid';
  }
  if (left === 'warning' || right === 'warning') {
    return 'warning';
  }
  return 'valid';
};

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

export const buildGlobalSkillExposure = (
  snapshot: SkillManagementSnapshot,
  skillName: string,
): readonly GlobalSkillExposure[] =>
  snapshot.targets
    .filter((target) => target.enabled)
    .map((target) => {
      const projection = projectionFor(snapshot.projections, skillName, target.id);
      const state = projection?.state ?? 'missing';
      return {
        canReconcile: canReconcileProjectionState(state),
        expectedPath: projection?.expectedPath ?? `${target.path}/${skillName}`,
        label: projection ? projectionStateLabel(projection.state) : 'Not linked',
        state,
        targetId: target.id,
        ...(projection?.actualPath === undefined ? {} : { actualPath: projection.actualPath }),
      };
    });

export const buildProjectSkillRows = (inventory: ProjectSkillInventory): readonly ProjectSkillRow[] => {
  const rows = new Map<string, ProjectSkillRow>();
  for (const observation of inventory.observations) {
    const existing = rows.get(observation.name) ?? {
      description: observation.description,
      invocation: observation.invocation,
      name: observation.name,
      observations: [],
      tokenTotal: observation.tokenCount?.total ?? null,
      validationStatus: observation.validationStatus,
    };
    rows.set(observation.name, {
      description: existing.description || observation.description,
      invocation: existing.invocation === 'manual' || observation.invocation === 'manual' ? 'manual' : 'auto',
      name: existing.name,
      observations: [...existing.observations, observation].sort((left, right) =>
        left.runtimeDirId.localeCompare(right.runtimeDirId),
      ),
      tokenTotal: existing.tokenTotal ?? observation.tokenCount?.total ?? null,
      validationStatus: strongestValidationStatus(existing.validationStatus, observation.validationStatus),
    });
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
};

export const findProjectSkillRow = (
  inventories: readonly ProjectSkillInventory[],
  projectPath: string,
  skillName: string,
): ProjectSkillRow | undefined => {
  const inventory = inventories.find((entry) => entry.projectPath === projectPath);
  return inventory === undefined ? undefined : buildProjectSkillRows(inventory).find((row) => row.name === skillName);
};

export const findGlobalSkill = (snapshot: SkillManagementSnapshot, skillName: string): SourceSkill | undefined =>
  snapshot.skills.find((skill) => skill.name === skillName);

export const buildSkillTree = (
  snapshot: SkillManagementSnapshot,
  projectInventories: readonly ProjectSkillInventory[],
  knownProjects: readonly KnownProjectScope[] = [],
): SkillTreeModel => {
  const globalSkills = snapshot.skills
    .map((skill) => ({
      ...globalSkillAttention(snapshot, skill),
      description: skill.description,
      enabled: skill.enabled,
      key: `global:${skill.name}`,
      name: skill.name,
      selection: { skillName: skill.name, type: 'global-skill' } satisfies SkillSelection,
      validationStatus: skill.validationStatus,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const globalScope: SkillTreeScopeNode = {
    attentionSummary: attentionSummary([
      [globalSkills.reduce((total, skill) => total + skill.issueCount, 0), 'issue'],
      [globalSkills.reduce((total, skill) => total + skill.pendingLinkCount, 0), 'not linked', 'not linked'],
    ]),
    hasSkills: globalSkills.length > 0,
    issueCount: globalSkills.reduce((total, skill) => total + skill.issueCount, 0),
    key: 'global',
    label: 'Global',
    pendingLinkCount: globalSkills.reduce((total, skill) => total + skill.pendingLinkCount, 0),
    selection: { type: 'global-scope' },
    skills: globalSkills,
    type: 'global',
  };

  const inventoriesByPath = new Map(projectInventories.map((inventory) => [inventory.projectPath, inventory]));
  const knownProjectsByPath = new Map(knownProjects.map((project) => [project.path, project]));
  const projectPaths = new Set([...knownProjectsByPath.keys(), ...inventoriesByPath.keys()]);

  const shortPathFor = (projectPath: string) => {
    const parts = projectPath.split('/').filter(Boolean);
    if (parts.length <= 2) {
      return projectPath;
    }
    return `…/${parts.slice(-2).join('/')}`;
  };

  const projectScopes = [...projectPaths]
    .map((projectPath) => {
      const inventory = inventoriesByPath.get(projectPath);
      const knownProject = knownProjectsByPath.get(projectPath);
      const projectRows = inventory === undefined ? [] : buildProjectSkillRows(inventory);
      const projectSkills = projectRows
        .map((row) => ({
          ...projectSkillAttention(row),
          description: row.description,
          enabled: true,
          key: `project:${projectPath}:${row.name}`,
          name: row.name,
          selection: {
            projectPath,
            skillName: row.name,
            type: 'project-skill',
          } satisfies SkillSelection,
          validationStatus: row.validationStatus,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const inventoryIssueCount = inventory?.diagnostics.length ?? 0;
      const skillIssueCount = projectSkills.reduce((total, skill) => total + skill.issueCount, 0);
      const pendingLinkCount = projectSkills.reduce((total, skill) => total + skill.pendingLinkCount, 0);
      return {
        attentionSummary: attentionSummary([
          [inventoryIssueCount + skillIssueCount, 'issue'],
          [pendingLinkCount, 'not linked', 'not linked'],
        ]),
        hasSkills: projectSkills.length > 0,
        issueCount: inventoryIssueCount + skillIssueCount,
        key: `project:${projectPath}`,
        label: knownProject?.label ?? projectPath.split('/').filter(Boolean).at(-1) ?? projectPath,
        pendingLinkCount,
        path: projectPath,
        selection: { projectPath, type: 'project-scope' } satisfies SkillSelection,
        shortPath: shortPathFor(projectPath),
        skills: projectSkills,
        type: 'project' as const,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));

  return {
    emptyScopes: projectScopes.filter((scope) => !scope.hasSkills && scope.issueCount === 0),
    scopes: [globalScope, ...projectScopes.filter((scope) => scope.hasSkills || scope.issueCount > 0)],
  };
};

export const defaultSkillSelection = (
  snapshot: SkillManagementSnapshot,
  projectInventories: readonly ProjectSkillInventory[],
  knownProjects: readonly KnownProjectScope[] = [],
): SkillSelection => {
  const tree = buildSkillTree(snapshot, projectInventories, knownProjects);
  const firstGlobalAttentionSkill = tree.scopes
    .find((scope) => scope.type === 'global')
    ?.skills.find((skill) => skill.issueCount > 0);
  if (firstGlobalAttentionSkill) {
    return firstGlobalAttentionSkill.selection;
  }
  const firstGlobalSkill = tree.scopes.find((scope) => scope.type === 'global')?.skills.at(0);
  if (firstGlobalSkill) {
    return firstGlobalSkill.selection;
  }
  const firstProject = tree.scopes.find((scope) => scope.type === 'project');
  return firstProject?.selection ?? { type: 'global-scope' };
};

export const selectionKey = (selection: SkillSelection): string => {
  if (selection.type === 'global-scope') {
    return 'global';
  }
  if (selection.type === 'global-skill') {
    return `global:${selection.skillName}`;
  }
  if (selection.type === 'project-scope') {
    return `project:${selection.projectPath}`;
  }
  return `project:${selection.projectPath}:${selection.skillName}`;
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const projectRouteKey = (projectPath: string): string =>
  projectPath.split('/').filter(Boolean).at(-1) ?? projectPath;

const projectPathFromRouteKey = (projectKey: string, knownProjects: readonly KnownProjectScope[]): string => {
  const decodedKey = safeDecodeURIComponent(projectKey);
  const matchingProject = knownProjects.find((project) => {
    const projectBaseName = project.path.split('/').filter(Boolean).at(-1) ?? project.path;
    return projectBaseName === decodedKey || project.path === decodedKey;
  });
  return matchingProject?.path ?? decodedKey;
};

export const skillSelectionPath = (selection: SkillSelection): string => {
  if (selection.type === 'global-scope') {
    return '/skills';
  }
  if (selection.type === 'global-skill') {
    return `/skills/global/${encodeURIComponent(selection.skillName)}`;
  }
  const projectKey = projectRouteKey(selection.projectPath);
  if (selection.type === 'project-scope') {
    return `/skills/projects/${projectKey}`;
  }
  return `/skills/projects/${projectKey}/${encodeURIComponent(selection.skillName)}`;
};

export const skillSelectionFromPath = (
  pathname: string,
  knownProjects: readonly KnownProjectScope[] = [],
): SkillSelection | undefined => {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.at(0) !== 'skills') {
    return;
  }
  if (segments.length === 1) {
    return { type: 'global-scope' };
  }
  if (segments.at(1) === 'global' && segments.length === 3) {
    const skillName = safeDecodeURIComponent(segments[2] ?? '');
    return skillName ? { skillName, type: 'global-skill' } : undefined;
  }
  if (segments.at(1) !== 'projects' || segments.length < 3 || segments.length > 4) {
    return;
  }
  const projectPath = projectPathFromRouteKey(segments[2] ?? '', knownProjects);
  if (!projectPath) {
    return;
  }
  if (segments.length === 3) {
    return { projectPath, type: 'project-scope' };
  }
  const skillName = safeDecodeURIComponent(segments[3] ?? '');
  return skillName ? { projectPath, skillName, type: 'project-skill' } : undefined;
};

export const parseSelectionKey = (key: string): SkillSelection | undefined => {
  if (key === 'global') {
    return { type: 'global-scope' };
  }
  if (key.startsWith('global:')) {
    const skillName = key.slice('global:'.length);
    return skillName ? { skillName, type: 'global-skill' } : undefined;
  }
  if (!key.startsWith('project:')) {
    return;
  }
  const value = key.slice('project:'.length);
  if (!value) {
    return;
  }
  const lastColon = value.lastIndexOf(':');
  if (lastColon === -1) {
    return { projectPath: value, type: 'project-scope' };
  }
  const projectPath = value.slice(0, lastColon);
  const skillName = value.slice(lastColon + 1);
  return projectPath && skillName ? { projectPath, skillName, type: 'project-skill' } : undefined;
};

export const skillScopeMatches = (
  tree: SkillTreeModel,
  skillName: string,
  excludeKey: string,
): readonly { scopeLabel: string; selection: SkillSelection }[] => {
  const matches: { scopeLabel: string; selection: SkillSelection }[] = [];
  for (const scope of tree.scopes) {
    const skill = scope.skills.find((candidate) => candidate.name === skillName);
    if (skill === undefined || skill.key === excludeKey) {
      continue;
    }
    matches.push({ scopeLabel: scope.label, selection: skill.selection });
  }
  return matches;
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

  const consolidateCopies = snapshot.unmanagedEntries.filter((entry) => entry.state === 'unmanaged-copy').length;
  const consolidateSymlinks = snapshot.unmanagedEntries.filter((entry) => entry.state === 'unmanaged-symlink').length;

  return {
    blockedCount,
    consolidateCopies,
    consolidateCount: snapshot.unmanagedEntries.length,
    consolidateSymlinks,
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
      entries: [],
      symlinks: 0,
      targetId: entry.targetId,
      targetLabel: target?.label ?? entry.targetId,
      targetPath: target?.path ?? '',
      total: 0,
    };
    const unmanagedEntry =
      entry.state === 'unmanaged-copy' || entry.state === 'unmanaged-symlink'
        ? {
            name: entry.skillName,
            path: entry.actualPath ?? entry.expectedPath,
            state: entry.state,
          }
        : undefined;
    groups.set(entry.targetId, {
      ...existing,
      copies: existing.copies + (entry.state === 'unmanaged-copy' ? 1 : 0),
      entries:
        unmanagedEntry === undefined
          ? existing.entries
          : [...existing.entries, unmanagedEntry].sort((left, right) => {
              if (left.state !== right.state) {
                return left.state === 'unmanaged-copy' ? -1 : 1;
              }
              return left.name.localeCompare(right.name);
            }),
      symlinks: existing.symlinks + (entry.state === 'unmanaged-symlink' ? 1 : 0),
      total: existing.total + 1,
    });
  }
  return [...groups.values()].sort((left, right) => left.targetLabel.localeCompare(right.targetLabel));
};

const rowMatchesCellState = (row: SkillMatrixRow, filter: SkillCellStateFilter) => {
  if (filter === 'disabled') {
    return !row.enabled;
  }
  if (filter === 'linked') {
    return row.cells.some((cell) => cell.state === 'linked');
  }
  if (filter === 'not-linked') {
    return row.cells.some((cell) => cell.state === 'missing');
  }
  if (filter === 'broken') {
    return row.cells.some((cell) => cell.state !== 'not-applicable' && repairStates.has(cell.state));
  }
  return row.cells.some((cell) => cell.state !== 'not-applicable' && blockedStates.has(cell.state));
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
    if (filter.cellState !== undefined && !rowMatchesCellState(row, filter.cellState)) {
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
