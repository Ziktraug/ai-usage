import { css, cx } from '@ai-usage/design-system/css';
import { meta, panel, strongCell } from '@ai-usage/design-system/report';
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
  defaultSkillSelection,
  groupUnmanagedEntries,
  type KnownProjectScope,
  type ReconcilePlanSummary,
  type SkillCellStateFilter,
  type SkillSelection,
  selectionKey,
} from './skills-page-model';
import { SKILLS_MOBILE_MEDIA_QUERY } from './skills-responsive';
import { SkillsTree } from './skills-tree';

export interface SkillReconcileResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

export type ProjectInventoriesResult =
  | { ok: true; data: readonly ProjectSkillInventory[] }
  | { ok: false; error: { message: string; tag: string } };

export interface SkillMarkdownDraftGuard {
  dirty: boolean;
  discard: () => void;
  focus: () => void;
  skillName: string;
}

const workspaceGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: '240px minmax(0, 1fr)', xl: '240px minmax(0, 1fr) 288px' },
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
  gridColumn: { lg: '2', xl: 'auto' },
});

const desktopTree = css({
  display: { base: 'none', lg: 'block' },
});

const mobilePicker = css({
  display: { base: 'block', lg: 'none' },
  p: '0',
  overflow: 'hidden',
});

const mobilePickerSummary = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
  p: '12px 14px',
  cursor: 'pointer',
});

const mobilePickerBody = css({
  maxH: '70vh',
  overflow: 'auto',
  p: '0 10px 10px',
});

const mobilePickerSelection = css({
  minW: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const selectedDetail = css({
  minW: 0,
  scrollMarginTop: '12px',
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '3px',
  },
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
  onMarkdownDraftStateChange: (guard: SkillMarkdownDraftGuard | undefined) => void;
  onPreviewReconcile: () => void;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  pendingOperation: string | null;
  knownProjectPaths: readonly KnownProjectScope[];
  markdownRefreshVersion: number;
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
    return defaultSkillSelection(tree());
  });
  const [expandedKeys, setExpandedKeys] = createSignal<ReadonlySet<string>>(
    new Set(['global', scopeKeyForSelection(selection())]),
  );
  const health = createMemo(() => buildSkillHealthSummary(props.snapshot));
  const unmanagedGroups = createMemo(() => groupUnmanagedEntries(props.snapshot));
  const selectedLabel = createMemo(() => {
    const current = selection();
    if (current.type === 'global-scope') {
      return 'Global skills';
    }
    if (current.type === 'global-skill' || current.type === 'project-skill') {
      return current.skillName;
    }
    return linkProjects().find((project) => project.path === current.projectPath)?.label ?? current.projectPath;
  });
  let mobilePickerElement: HTMLDetailsElement | undefined;
  let selectedDetailElement: HTMLElement | undefined;
  let previousSelectionKey = selectionKey(selection());

  createEffect(() => {
    const scopeKey = scopeKeyForSelection(selection());
    setExpandedKeys((keys) => (keys.has(scopeKey) ? keys : new Set([...keys, scopeKey])));
  });

  createEffect(() => {
    const currentSelectionKey = selectionKey(selection());
    if (currentSelectionKey === previousSelectionKey) {
      return;
    }
    previousSelectionKey = currentSelectionKey;
    if (typeof window === 'undefined' || !window.matchMedia(SKILLS_MOBILE_MEDIA_QUERY).matches) {
      return;
    }
    mobilePickerElement?.removeAttribute('open');
    window.requestAnimationFrame(() => {
      selectedDetailElement?.scrollIntoView({ block: 'start' });
      selectedDetailElement?.focus({ preventScroll: true });
    });
  });

  // A URL that no longer resolves (deleted skill, stale share) falls back to
  // the scope overview instead of rendering a dead detail pane.
  createEffect(() => {
    const routeSelection = props.routeSelection;
    if (routeSelection === undefined || props.projectInventoriesLoading) {
      return;
    }
    if (!selectionExists(treeKeys(), routeSelection)) {
      navigate({ replace: true, to: '/skills/global' });
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
      <div class={desktopTree}>
        <SkillsTree
          expandedKeys={expandedKeys()}
          idPrefix="desktop-skill"
          knownProjects={linkProjects()}
          model={tree()}
          onQueryChange={setQuery}
          onToggleScope={toggleScope}
          query={query()}
          selection={selection()}
        />
      </div>
      <details
        aria-label="Skill picker"
        class={cx(panel, mobilePicker)}
        ref={(element) => {
          mobilePickerElement = element;
        }}
      >
        <summary class={mobilePickerSummary}>
          <span class={strongCell}>Browse skills</span>
          <span class={cx(meta, mobilePickerSelection)}>{selectedLabel()}</span>
        </summary>
        <div class={mobilePickerBody}>
          <SkillsTree
            ariaLabel="Skill picker scopes"
            expandedKeys={expandedKeys()}
            idPrefix="mobile-skill"
            knownProjects={linkProjects()}
            model={tree()}
            onQueryChange={setQuery}
            onToggleScope={toggleScope}
            query={query()}
            selection={selection()}
          />
        </div>
      </details>
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
          <section
            aria-label="Selected skill detail"
            class={selectedDetail}
            ref={(element) => {
              selectedDetailElement = element;
            }}
            tabIndex={-1}
          >
            <SkillsDetail
              configurationPanel={props.configurationPanel}
              consolidatePanel={consolidatePanel}
              knownProjects={linkProjects()}
              markdownRefreshVersion={props.markdownRefreshVersion}
              onMarkdownDraftStateChange={props.onMarkdownDraftStateChange}
              onSnapshot={props.onSnapshot}
              projectInventories={props.projectInventories}
              projectInventoriesLoading={props.projectInventoriesLoading}
              selection={selection()}
              snapshot={props.snapshot}
              tree={tree()}
            />
          </section>
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
