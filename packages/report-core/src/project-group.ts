export interface ProjectSourceSelector {
  gitRemote?: string;
  machineId?: string;
  project?: string;
  sourcePath?: string;
}

export interface ProjectGroupConfig {
  id: string;
  name: string;
  sources: ProjectSourceSelector[];
}

export interface ProjectSourceIdentityInput {
  machineId: string;
  project: string;
  sourcePath?: string | null;
}

export interface ProjectSourceMatchInput extends ProjectSourceIdentityInput {
  gitRemote?: string | null;
}

export type ProjectGroupingWarningReason = 'unmatched-group' | 'partial-group' | 'broad-selector' | 'legacy-alias';

export interface ProjectGroupingWarning {
  groupId?: string;
  groupName?: string;
  message: string;
  operation: 'projectGrouping';
  reason: ProjectGroupingWarningReason;
}

export const projectSourceId = (source: ProjectSourceIdentityInput) =>
  [source.machineId, source.sourcePath || source.project].join('|');

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export const isProjectSourceSelector = (value: unknown): value is ProjectSourceSelector => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const hasSelector =
    record.gitRemote !== undefined ||
    record.machineId !== undefined ||
    record.project !== undefined ||
    record.sourcePath !== undefined;
  return (
    hasSelector &&
    (record.gitRemote === undefined || isNonEmptyString(record.gitRemote)) &&
    (record.machineId === undefined || isNonEmptyString(record.machineId)) &&
    (record.project === undefined || isNonEmptyString(record.project)) &&
    (record.sourcePath === undefined || isNonEmptyString(record.sourcePath))
  );
};

export const isProjectGroupConfig = (value: unknown): value is ProjectGroupConfig => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.id) &&
    isNonEmptyString(record.name) &&
    Array.isArray(record.sources) &&
    record.sources.length > 0 &&
    record.sources.every(isProjectSourceSelector)
  );
};

type ProjectSourceSelectorKey = keyof ProjectSourceSelector;

const SELECTOR_KEYS: ProjectSourceSelectorKey[] = ['gitRemote', 'machineId', 'project', 'sourcePath'];

const selectorValuesConflict = (key: ProjectSourceSelectorKey, left: string | undefined, right: string | undefined) => {
  if (left === undefined || right === undefined) {
    return false;
  }
  return key === 'project' ? left.toLowerCase() !== right.toLowerCase() : left !== right;
};

export const projectSourceSelectorsOverlap = (left: ProjectSourceSelector, right: ProjectSourceSelector) =>
  !SELECTOR_KEYS.some((key) => selectorValuesConflict(key, left[key], right[key]));

export const parseProjectGroupConfigs = (value: unknown): ProjectGroupConfig[] => {
  if (!(Array.isArray(value) && value.every(isProjectGroupConfig))) {
    throw new Error('Invalid project groups: every group must have an id, name, and at least one source selector');
  }

  const groups = value as ProjectGroupConfig[];
  const groupIds = new Set<string>();
  for (const group of groups) {
    if (groupIds.has(group.id)) {
      throw new Error(`Invalid project groups: duplicate id "${group.id}"`);
    }
    groupIds.add(group.id);
  }

  for (const [leftIndex, leftGroup] of groups.entries()) {
    for (const rightGroup of groups.slice(leftIndex + 1)) {
      const overlapping = leftGroup.sources.some((leftSelector) =>
        rightGroup.sources.some((rightSelector) => projectSourceSelectorsOverlap(leftSelector, rightSelector)),
      );
      if (overlapping) {
        throw new Error(
          `Invalid project groups: overlapping selectors between "${leftGroup.id}" and "${rightGroup.id}"`,
        );
      }
    }
  }

  return groups;
};

export const isProjectGroupConfigArray = (value: unknown): value is ProjectGroupConfig[] => {
  try {
    parseProjectGroupConfigs(value);
    return true;
  } catch {
    return false;
  }
};

const matchesOptional = (actual: string | null | undefined, expected: string | undefined) =>
  expected === undefined || actual === expected;

const matchesProject = (actual: string, expected: string | undefined) =>
  expected === undefined || actual.toLowerCase() === expected.toLowerCase();

export const matchesProjectSourceSelector = (source: ProjectSourceMatchInput, selector: ProjectSourceSelector) =>
  matchesOptional(source.machineId, selector.machineId) &&
  matchesOptional(source.sourcePath, selector.sourcePath) &&
  matchesProject(source.project, selector.project) &&
  matchesOptional(source.gitRemote, selector.gitRemote);

export const projectSourceSelectorLabel = (selector: ProjectSourceSelector) =>
  [
    selector.machineId ? `machine=${selector.machineId}` : null,
    selector.sourcePath ? `path=${selector.sourcePath}` : null,
    selector.project ? `project=${selector.project}` : null,
    selector.gitRemote ? `git=${selector.gitRemote}` : null,
  ]
    .filter((item): item is string => item !== null)
    .join(', ');
