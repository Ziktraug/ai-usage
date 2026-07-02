import { css } from '@ai-usage/design-system/css';
import type { ProjectionAction, ProjectSkillInventory, SkillManagementSnapshot } from '@ai-usage/skills';
import { useLocation, useNavigate } from '@tanstack/solid-router';
import { createEffect, createMemo, createSignal, type JSX, Show } from 'solid-js';
import { SkillsConsolidate } from './skills-consolidate';
import { SkillsContextPanel } from './skills-context-panel';
import { SkillsDetail } from './skills-detail';
import { SkillsHealth } from './skills-health';
import { SkillsMatrix } from './skills-matrix';
import {
  buildSkillHealthSummary,
  buildSkillTree,
  groupUnmanagedEntries,
  type KnownProjectScope,
  type ReconcilePlanSummary,
  type SkillCellStateFilter,
  type SkillSelection,
  selectionKey,
} from './skills-page-model';
import { SkillsTree } from './skills-tree';

export interface SkillReconcileResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

export type ProjectInventoriesResult =
  | { ok: true; data: readonly ProjectSkillInventory[] }
  | { ok: false; error: { message: string; tag: string } };

const workspaceGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: '280px minmax(0, 1fr)', xl: '280px minmax(0, 1fr) 320px' },
  gap: '16px',
  alignItems: 'start',
});

const centerStack = css({
  display: 'grid',
  gap: '16px',
  minW: 0,
});

const secondaryMatrix = css({
  display: 'grid',
  gap: '12px',
});

const mobileContext = css({
  display: { base: 'block', xl: 'contents' },
});

const selectionExists = (treeKeys: ReadonlySet<string>, selection: SkillSelection) =>
  treeKeys.has(selectionKey(selection));

const scopeKeyForSelection = (selection: SkillSelection): string => {
  if (selection.type === 'global-scope' || selection.type === 'global-skill') {
    return 'global';
  }
  return `project:${selection.projectPath}`;
};

export const SkillsWorkspace = (props: {
  activeCellStateFilter: SkillCellStateFilter | undefined;
  configurationPanel: () => JSX.Element;
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onCellStateFilterChange: (filter: SkillCellStateFilter | undefined) => void;
  onPreviewReconcile: () => void;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  pendingOperation: string | null;
  knownProjectPaths: readonly KnownProjectScope[];
  projectInventories: ProjectInventoriesResult | undefined;
  projectInventoriesLoading: boolean;
  reconcilePlan: ReconcilePlanSummary | null;
  reconcileSkill: (skillName: string) => void;
  routeSelection: SkillSelection | undefined;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) => {
  const [query, setQuery] = createSignal('');
  const location = useLocation();
  const navigate = useNavigate();
  const matrixOpen = createMemo(() => location().pathname === '/skills/matrix');
  const projectInventories = createMemo(() => (props.projectInventories?.ok ? props.projectInventories.data : []));
  const tree = createMemo(() => buildSkillTree(props.snapshot, projectInventories(), props.knownProjectPaths));
  const treeKeys = createMemo(
    () =>
      new Set(
        [...tree().scopes, ...tree().emptyScopes].flatMap((scope) => [
          scope.key,
          ...scope.skills.map((skill) => skill.key),
        ]),
      ),
  );
  // Every scope path the tree knows about, so links can build unambiguous
  // project keys even for paths that are not in the discovered list.
  const linkProjects = createMemo<readonly KnownProjectScope[]>(() =>
    [...tree().scopes, ...tree().emptyScopes].flatMap((scope) =>
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
    ),
  );
  // The URL is the single source of truth for the selection; while project
  // inventories load, the URL's intent is honored so the detail pane can show
  // its loading state instead of flashing the global overview.
  const selection = createMemo<SkillSelection>(() => {
    const routeSelection = props.routeSelection;
    if (routeSelection !== undefined) {
      if (selectionExists(treeKeys(), routeSelection)) {
        return routeSelection;
      }
      if (
        props.projectInventoriesLoading &&
        (routeSelection.type === 'project-scope' || routeSelection.type === 'project-skill')
      ) {
        return routeSelection;
      }
    }
    return { type: 'global-scope' };
  });
  const [expandedKeys, setExpandedKeys] = createSignal<ReadonlySet<string>>(
    new Set(['global', scopeKeyForSelection(selection())]),
  );
  const health = createMemo(() => buildSkillHealthSummary(props.snapshot));
  const unmanagedGroups = createMemo(() => groupUnmanagedEntries(props.snapshot));

  createEffect(() => {
    const scopeKey = scopeKeyForSelection(selection());
    setExpandedKeys((keys) => (keys.has(scopeKey) ? keys : new Set([...keys, scopeKey])));
  });

  // A URL that no longer resolves (deleted skill, stale share) falls back to
  // the scope overview instead of rendering a dead detail pane.
  createEffect(() => {
    const routeSelection = props.routeSelection;
    if (routeSelection === undefined || props.projectInventoriesLoading) {
      return;
    }
    if (!selectionExists(treeKeys(), routeSelection)) {
      navigate({ replace: true, to: '/skills' });
    }
  });

  const toggleScope = (scopeKey: string) => {
    setExpandedKeys((keys) => {
      const next = new Set(keys);
      if (next.has(scopeKey)) {
        next.delete(scopeKey);
      } else {
        next.add(scopeKey);
      }
      return next;
    });
  };

  const consolidatePanel = () => <SkillsConsolidate groups={unmanagedGroups()} total={health().consolidateCount} />;

  return (
    <div class={workspaceGrid}>
      <SkillsTree
        expandedKeys={expandedKeys()}
        knownProjects={linkProjects()}
        model={tree()}
        onQueryChange={setQuery}
        onToggleScope={toggleScope}
        query={query()}
        selection={selection()}
      />
      <div class={centerStack}>
        <Show
          fallback={
            <div class={secondaryMatrix}>
              <SkillsHealth
                activeFilter={props.activeCellStateFilter}
                onFilterChange={(filter) =>
                  props.onCellStateFilterChange(props.activeCellStateFilter === filter ? undefined : filter)
                }
                snapshot={props.snapshot}
                summary={health()}
              />
              <SkillsMatrix
                activeCellStateFilter={props.activeCellStateFilter}
                onApplyReconcile={props.onApplyReconcile}
                onCancelReconcile={props.onCancelReconcile}
                onCellStateFilterChange={props.onCellStateFilterChange}
                onPreviewReconcile={props.onPreviewReconcile}
                pendingOperation={props.pendingOperation}
                reconcilePlan={props.reconcilePlan}
                snapshot={props.snapshot}
                toggleSkill={props.toggleSkill}
              />
            </div>
          }
          when={!matrixOpen()}
        >
          <SkillsDetail
            configurationPanel={props.configurationPanel}
            consolidatePanel={consolidatePanel}
            knownProjects={linkProjects()}
            onSnapshot={props.onSnapshot}
            pendingOperation={props.pendingOperation}
            projectInventories={props.projectInventories}
            projectInventoriesLoading={props.projectInventoriesLoading}
            reconcileSkill={props.reconcileSkill}
            selection={selection()}
            snapshot={props.snapshot}
            toggleSkill={props.toggleSkill}
            tree={tree()}
          />
        </Show>
      </div>
      <div class={mobileContext}>
        <SkillsContextPanel
          knownProjects={linkProjects()}
          matrixOpen={matrixOpen()}
          onApplyReconcile={props.onApplyReconcile}
          onCancelReconcile={props.onCancelReconcile}
          onCellStateFilterChange={props.onCellStateFilterChange}
          onPreviewReconcile={props.onPreviewReconcile}
          pendingOperation={props.pendingOperation}
          projectInventories={props.projectInventories}
          reconcilePlan={props.reconcilePlan}
          reconcileSkill={props.reconcileSkill}
          selection={selection()}
          snapshot={props.snapshot}
          toggleSkill={props.toggleSkill}
        />
      </div>
    </div>
  );
};
