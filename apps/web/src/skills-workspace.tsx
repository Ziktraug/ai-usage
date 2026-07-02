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
  parseSelectionKey,
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
  onSelectionSearchChange: (sel: string, options?: { replace?: boolean }) => void;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  pendingOperation: string | null;
  knownProjectPaths: readonly KnownProjectPath[];
  projectInventories: ProjectInventoriesResult | undefined;
  projectInventoriesLoading: boolean;
  reconcilePlan: ReconcilePlanSummary | null;
  reconcileSkill: (skillName: string) => void;
  selectionKey: string | undefined;
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
  const initialSearchSelection = props.selectionKey === undefined ? undefined : parseSelectionKey(props.selectionKey);
  const initialSelection =
    initialSearchSelection !== undefined && selectionExists(treeKeys(), initialSearchSelection)
      ? initialSearchSelection
      : initialDefaultSelection;
  const [selection, setSelection] = createSignal<SkillSelection>(initialSelection);
  const [expandedKeys, setExpandedKeys] = createSignal<ReadonlySet<string>>(
    new Set(['global', scopeKeyForSelection(initialSelection)]),
  );
  const health = createMemo(() => buildSkillHealthSummary(props.snapshot));
  const unmanagedGroups = createMemo(() => groupUnmanagedEntries(props.snapshot));

  createEffect(() => {
    const searchSelection = props.selectionKey === undefined ? undefined : parseSelectionKey(props.selectionKey);
    if (
      searchSelection !== undefined &&
      selectionExists(treeKeys(), searchSelection) &&
      selectionKey(selection()) !== props.selectionKey
    ) {
      setSelection(searchSelection);
      setExpandedKeys((keys) => new Set([...keys, scopeKeyForSelection(searchSelection)]));
      setViewMode('detail');
      return;
    }
    if (searchSelection !== undefined && selectionExists(treeKeys(), searchSelection)) {
      return;
    }
    if (
      searchSelection !== undefined &&
      !selectionExists(treeKeys(), searchSelection) &&
      props.projectInventoriesLoading
    ) {
      return;
    }
    const currentSelection = selection();
    if (!selectionExists(treeKeys(), currentSelection) || props.selectionKey !== undefined) {
      const nextSelection = defaultSkillSelection(props.snapshot, projectInventories(), props.knownProjectPaths);
      setSelection(nextSelection);
      setExpandedKeys((keys) => new Set([...keys, scopeKeyForSelection(nextSelection)]));
      props.onSelectionSearchChange(selectionKey(nextSelection), { replace: true });
    }
  });

  const select = (nextSelection: SkillSelection) => {
    setSelection(nextSelection);
    setExpandedKeys((keys) => new Set([...keys, scopeKeyForSelection(nextSelection)]));
    setViewMode('detail');
    props.onSelectionSearchChange(selectionKey(nextSelection));
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
        model={tree()}
        onQueryChange={setQuery}
        onSelect={select}
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
                onOpenSkill={(skillName) => select({ skillName, type: 'global-skill' })}
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
            onSelect={select}
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
