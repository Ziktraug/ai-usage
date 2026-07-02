import { css } from '@ai-usage/design-system/css';
import type { ProjectionAction, ProjectSkillInventory, SkillManagementSnapshot } from '@ai-usage/skills';
import { createEffect, createMemo, createSignal, type JSX, Show } from 'solid-js';
import { SkillsConsolidate } from './skills-consolidate';
import { SkillsContextPanel } from './skills-context-panel';
import { SkillsDetail } from './skills-detail';
import { SkillsHealth } from './skills-health';
import { SkillsMatrix } from './skills-matrix';
import {
  buildSkillHealthSummary,
  buildSkillTree,
  defaultSkillSelection,
  groupUnmanagedEntries,
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

export interface KnownProjectPath {
  label: string;
  path: string;
}

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
  knownProjectPaths: readonly KnownProjectPath[];
  projectInventories: ProjectInventoriesResult | undefined;
  projectInventoriesLoading: boolean;
  reconcilePlan: ReconcilePlanSummary | null;
  reconcileSkill: (skillName: string) => void;
  routeSelection: SkillSelection | undefined;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) => {
  const [query, setQuery] = createSignal('');
  const [viewMode, setViewMode] = createSignal<'detail' | 'matrix'>('detail');
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
  const initialDefaultSelection = defaultSkillSelection(props.snapshot, projectInventories(), props.knownProjectPaths);
  const initialSelection =
    props.routeSelection !== undefined && selectionExists(treeKeys(), props.routeSelection)
      ? props.routeSelection
      : initialDefaultSelection;
  const [selection, setSelection] = createSignal<SkillSelection>(initialSelection);
  const [expandedKeys, setExpandedKeys] = createSignal<ReadonlySet<string>>(
    new Set(['global', scopeKeyForSelection(initialSelection)]),
  );
  const health = createMemo(() => buildSkillHealthSummary(props.snapshot));
  const unmanagedGroups = createMemo(() => groupUnmanagedEntries(props.snapshot));

  createEffect(() => {
    const routeSelection = props.routeSelection;
    if (
      routeSelection !== undefined &&
      selectionExists(treeKeys(), routeSelection) &&
      selectionKey(selection()) !== selectionKey(routeSelection)
    ) {
      setSelection(routeSelection);
      setExpandedKeys((keys) => new Set([...keys, scopeKeyForSelection(routeSelection)]));
      setViewMode('detail');
      return;
    }
    if (routeSelection !== undefined && selectionExists(treeKeys(), routeSelection)) {
      return;
    }
    if (
      routeSelection !== undefined &&
      !selectionExists(treeKeys(), routeSelection) &&
      props.projectInventoriesLoading
    ) {
      return;
    }
    const currentSelection = selection();
    if (!selectionExists(treeKeys(), currentSelection)) {
      const nextSelection = defaultSkillSelection(props.snapshot, projectInventories(), props.knownProjectPaths);
      setSelection(nextSelection);
      setExpandedKeys((keys) => new Set([...keys, scopeKeyForSelection(nextSelection)]));
    }
  });

  const select = (nextSelection: SkillSelection) => {
    setSelection(nextSelection);
    setExpandedKeys((keys) => new Set([...keys, scopeKeyForSelection(nextSelection)]));
    setViewMode('detail');
  };

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
        knownProjects={props.knownProjectPaths}
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
          when={viewMode() === 'detail'}
        >
          <SkillsDetail
            configurationPanel={props.configurationPanel}
            consolidatePanel={consolidatePanel}
            knownProjects={props.knownProjectPaths}
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
          onApplyReconcile={props.onApplyReconcile}
          onCancelReconcile={props.onCancelReconcile}
          onCellStateFilterChange={props.onCellStateFilterChange}
          onOpenMatrix={() => setViewMode('matrix')}
          onPreviewReconcile={props.onPreviewReconcile}
          onSelect={select}
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
