import type { ProjectSkillInventory, SkillManagementSnapshot } from '@ai-usage/skills';
import type {
  KnownSkillProjectPath,
  ProjectSkillInventory as WireProjectSkillInventory,
} from '@ai-usage/web-contract/skills';
import { parseProjectInventoriesResult, parseSkillSnapshotResult } from '../../../../skills-client-contracts';
import {
  buildSkillTree,
  findGlobalSkill,
  findProjectSkillRow,
  type KnownProjectScope,
  type ProjectSkillRow,
  type SkillSelection,
  type SkillTreeModel,
  selectionKey,
  skillSelectionFromPath,
} from '../../../../skills-page-model';

/**
 * What the URL selects, if anything.
 *
 * `none` is the worktable itself: `/skills` shows every skill at once, so "nothing selected" is the
 * ordinary state rather than a failure to pick. Only the two per-skill routes open the drawer, and
 * they are the only selections this model resolves — scope routes were folded into the worktable's
 * groups (plan 113) and redirect to it.
 */
export type SkillsShellSelectionDetail =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'global-skill';
      readonly skill: SkillManagementSnapshot['skills'][number];
    }
  | {
      readonly kind: 'project-skill';
      readonly project: KnownProjectScope;
      readonly skill: ProjectSkillRow;
    };

export interface SkillsShellViewModel {
  readonly fallbackHref?: '/skills';
  /** Every project inventory the read carried — the Projects group summarises all of them at once. */
  readonly inventories: readonly ProjectSkillInventory[];
  readonly knownProjects: readonly KnownProjectScope[];
  readonly selection: SkillSelection | undefined;
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
  selection: SkillSelection | undefined,
): SkillsShellSelectionDetail => {
  if (selection === undefined || selection.type === 'global-scope' || selection.type === 'project-scope') {
    return { kind: 'none' };
  }
  if (selection.type === 'global-skill') {
    const skill = findGlobalSkill(snapshot, selection.skillName);
    return skill === undefined ? { kind: 'none' } : { kind: 'global-skill', skill };
  }
  const project = knownProjects.find((candidate) => candidate.path === selection.projectPath) ?? {
    label: selection.projectPath,
    path: selection.projectPath,
  };
  const skill = findProjectSkillRow(inventories, selection.projectPath, selection.skillName, knownProjects);
  return skill === undefined ? { kind: 'none' } : { kind: 'project-skill', project, skill };
};

const labelForDetail = (detail: SkillsShellSelectionDetail): string =>
  detail.kind === 'none' ? 'Skills' : detail.skill.name;

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
  // Only the two per-skill routes select anything. A scope route resolves to the worktable, which
  // already shows that scope as a group, so it is not a selection that can be missing.
  const requestedSkillSelection =
    requestedSelection?.type === 'global-skill' || requestedSelection?.type === 'project-skill'
      ? requestedSelection
      : undefined;
  const requestedSelectionExists =
    requestedSkillSelection !== undefined && allTreeKeys(tree).has(selectionKey(requestedSkillSelection));
  const selection = requestedSelectionExists ? requestedSkillSelection : undefined;
  const selectionDetail = selectionDetailFor(snapshot, inventories, knownProjects, selection);
  return {
    // A URL naming a skill that is not here is a dead drawer, and the worktable is where the
    // reader can see why. Scope and matrix URLs redirect at the route level instead.
    ...(requestedSkillSelection !== undefined && !requestedSelectionExists ? { fallbackHref: '/skills' as const } : {}),
    inventories,
    knownProjects,
    selection,
    selectionDetail,
    selectionLabel: labelForDetail(selectionDetail),
    snapshot,
    tree,
  };
};
