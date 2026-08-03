import type { ProjectSkillInventory, SkillManagementSnapshot } from '@ai-usage/skills';
import type {
  KnownSkillProjectPath,
  ProjectSkillInventory as WireProjectSkillInventory,
} from '@ai-usage/web-contract/skills';
import { parseProjectInventoriesResult, parseSkillSnapshotResult } from '../../../../skills-client-contracts';
import {
  buildSkillTree,
  defaultSkillSelection,
  findGlobalSkill,
  findProjectSkillRow,
  type KnownProjectScope,
  type ProjectSkillRow,
  projectSourcePathsForScope,
  type SkillSelection,
  type SkillTreeModel,
  selectionKey,
  skillSelectionFromPath,
} from '../../../../skills-page-model';

export type SkillsShellSelectionDetail =
  | { readonly kind: 'global-scope' }
  | {
      readonly kind: 'global-skill';
      readonly skill: SkillManagementSnapshot['skills'][number];
    }
  | {
      readonly inventories: readonly ProjectSkillInventory[];
      readonly kind: 'project-scope';
      readonly project: KnownProjectScope;
    }
  | {
      readonly kind: 'project-skill';
      readonly project: KnownProjectScope;
      readonly skill: ProjectSkillRow;
    };

export interface SkillsShellViewModel {
  readonly fallbackHref?: '/skills/global';
  readonly knownProjects: readonly KnownProjectScope[];
  readonly matrixOpen: boolean;
  readonly selection: SkillSelection;
  readonly selectionDetail: SkillsShellSelectionDetail;
  readonly selectionLabel: string;
  readonly snapshot: SkillManagementSnapshot;
  readonly tree: SkillTreeModel;
}

export const normalizeSkillsQuerySnapshot = (snapshot: unknown): SkillManagementSnapshot => {
  const result = parseSkillSnapshotResult({ data: snapshot, ok: true });
  if (!result.ok) {
    throw new Error('Invalid Skills snapshot for shell composition');
  }
  return result.data;
};

const domainInventoriesFrom = (inventories: readonly WireProjectSkillInventory[]): readonly ProjectSkillInventory[] => {
  const result = parseProjectInventoriesResult({ data: [...inventories], ok: true });
  if (!result.ok) {
    throw new Error('Invalid Skills inventories for shell composition');
  }
  return result.data;
};

export const knownProjectScopesFromPaths = (
  projects: readonly KnownSkillProjectPath[],
): readonly KnownProjectScope[] => {
  const scopes = new Map<string, KnownProjectScope>();
  for (const project of projects) {
    const scopePath = project.groupId ?? project.path;
    const existing = scopes.get(scopePath);
    const sourcePaths = existing?.sourcePaths ?? [];
    scopes.set(scopePath, {
      label: project.groupLabel ?? project.label,
      path: scopePath,
      ...(project.groupId === undefined ? {} : { routeKey: project.groupId }),
      sourcePaths: [...sourcePaths, project.path],
    });
  }
  return [...scopes.values()];
};

const allTreeKeys = (tree: SkillTreeModel): ReadonlySet<string> =>
  new Set(
    [...tree.scopes, ...tree.emptyScopes].flatMap((scope) => [scope.key, ...scope.skills.map((skill) => skill.key)]),
  );

const projectsFromTree = (tree: SkillTreeModel): readonly KnownProjectScope[] =>
  [...tree.scopes, ...tree.emptyScopes].flatMap((scope) =>
    scope.type === 'project' && scope.path !== undefined
      ? [
          {
            label: scope.label,
            path: scope.path,
            ...(scope.routeKey === undefined ? {} : { routeKey: scope.routeKey }),
            ...(scope.sourcePaths === undefined ? {} : { sourcePaths: scope.sourcePaths }),
          },
        ]
      : [],
  );

const selectionDetailFor = (
  snapshot: SkillManagementSnapshot,
  inventories: readonly ProjectSkillInventory[],
  knownProjects: readonly KnownProjectScope[],
  selection: SkillSelection,
): SkillsShellSelectionDetail => {
  if (selection.type === 'global-scope') {
    return { kind: 'global-scope' };
  }
  if (selection.type === 'global-skill') {
    const skill = findGlobalSkill(snapshot, selection.skillName);
    return skill === undefined ? { kind: 'global-scope' } : { kind: 'global-skill', skill };
  }
  const project = knownProjects.find((candidate) => candidate.path === selection.projectPath) ?? {
    label: selection.projectPath,
    path: selection.projectPath,
  };
  if (selection.type === 'project-scope') {
    const sourcePaths = new Set(projectSourcePathsForScope(selection.projectPath, knownProjects));
    return {
      inventories: inventories.filter((inventory) => sourcePaths.has(inventory.projectPath)),
      kind: 'project-scope',
      project,
    };
  }
  const skill = findProjectSkillRow(inventories, selection.projectPath, selection.skillName, knownProjects);
  return skill === undefined
    ? { inventories: [], kind: 'project-scope', project }
    : { kind: 'project-skill', project, skill };
};

const labelForDetail = (detail: SkillsShellSelectionDetail): string => {
  if (detail.kind === 'global-scope') {
    return 'Global skills';
  }
  if (detail.kind === 'global-skill' || detail.kind === 'project-skill') {
    return detail.skill.name;
  }
  return detail.project.label;
};

export const createSkillsShellViewModel = (input: {
  readonly inventories: readonly WireProjectSkillInventory[];
  readonly knownProjectPaths: readonly KnownSkillProjectPath[];
  readonly pathname: string;
  readonly snapshot: unknown;
}): SkillsShellViewModel => {
  const snapshot = normalizeSkillsQuerySnapshot(input.snapshot);
  const inventories = domainInventoriesFrom(input.inventories);
  const discoveredProjects = knownProjectScopesFromPaths(input.knownProjectPaths);
  const tree = buildSkillTree(snapshot, inventories, discoveredProjects);
  const knownProjects = projectsFromTree(tree);
  const requestedSelection = skillSelectionFromPath(input.pathname, knownProjects);
  const requestedSelectionExists =
    requestedSelection !== undefined && allTreeKeys(tree).has(selectionKey(requestedSelection));
  const selection = requestedSelectionExists ? requestedSelection : defaultSkillSelection(tree);
  const selectionDetail = selectionDetailFor(snapshot, inventories, knownProjects, selection);
  const isSelectionRoute = input.pathname !== '/skills/matrix';
  return {
    ...(!requestedSelectionExists && isSelectionRoute ? { fallbackHref: '/skills/global' as const } : {}),
    knownProjects,
    matrixOpen: input.pathname === '/skills/matrix',
    selection,
    selectionDetail,
    selectionLabel: labelForDetail(selectionDetail),
    snapshot,
    tree,
  };
};
