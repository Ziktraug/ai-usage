import { css, cx } from '@ai-usage/design-system/css';
import {
  banner,
  bannerError,
  bannerOk,
  commandButton,
  ghostButton,
  header,
  headerActions,
  headerTop,
  meta,
  navButton,
  page,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  shell,
  strongCell,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { createQuery } from '@tanstack/solid-query';
import { ClientOnly, createFileRoute, Link, useLocation } from '@tanstack/solid-router';
import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { isServer } from 'solid-js/web';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';
import { DiscardConfirmationDialog } from '../discard-confirmation-dialog';
import type { getKnownSkillProjectPaths, getSkillManagementSnapshot, KnownSkillProjectPath } from '../server/skills';
import {
  buildSkillMatrix,
  count,
  type KnownProjectScope,
  type ReconcilePlanSummary,
  type SkillCellStateFilter,
  skillSelectionFromPath,
} from '../skills-page-model';
import { createSkillsRouteController, type OperationNotice } from '../skills-route-controller';
import { type ProjectInventoriesResult, type SkillMarkdownDraftGuard, SkillsWorkspace } from '../skills-workspace';
import { loadSkillsInitialData, webQueryKeys } from '../web-query-options';

export const Route = createFileRoute('/skills')({
  component: SkillsRoute,
});

const dashboardSearchDefaults = dashboardSearchDefaultsFor('date');

const pageStack = css({
  display: 'grid',
  gap: '16px',
});

// The shared headerTop does not wrap; with this page's long title the fixed
// header actions overflow the 390px viewport, so allow wrapping here.
const headerWrap = css({
  flexWrap: 'wrap',
});

const headerActionsWrap = css({
  flexWrap: 'wrap',
  flexShrink: 1,
  justifyContent: 'flex-end',
  maxW: '100%',
});

const stack = css({
  display: 'grid',
  gap: '12px',
});

const fold = css({
  p: '0',
  overflow: 'hidden',
});

const foldSummary = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
  p: '14px 16px',
  cursor: 'pointer',
});

const foldBody = css({
  display: 'grid',
  gap: '14px',
  p: '0 16px 16px',
});

const foldsGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', xl: 'minmax(0, 0.75fr) minmax(360px, 1.25fr)' },
  gap: '16px',
});

const emptyState = css({
  p: '18px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '13px',
  lineHeight: 1.6,
});

const formGrid = css({
  display: 'grid',
  gap: '12px',
  gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1fr) auto' },
  alignItems: 'end',
});

const projectPickerGrid = css({
  display: 'grid',
  gap: '10px',
  gridTemplateColumns: { base: '1fr', lg: 'minmax(0, 1fr) minmax(260px, 0.5fr) auto' },
  alignItems: 'end',
});

const configStack = css({
  display: 'grid',
  gap: '16px',
});

const formField = css({
  display: 'grid',
  gap: '4px',
  minW: 0,
});

const labelText = css({
  color: 'muted',
  fontSize: '12px',
  fontWeight: 650,
});

const helpText = css({
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
});

const inputClass = css({
  h: '36px',
  minW: 0,
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '13px',
});

const busyButton = css({
  '&[data-pending=true]': {
    _after: {
      content: '" ..."',
      color: 'accent',
    },
  },
});

const projectPathList = css({
  display: 'grid',
  gap: '8px',
});

const projectPathRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'center',
  p: '8px 10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
});

const targetRow = css({
  display: 'grid',
  gap: '5px',
  p: '10px 0',
  borderTop: '1px solid token(colors.line)',
});

const disabledRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '10px',
  alignItems: 'center',
  p: '10px 0',
  borderTop: '1px solid token(colors.line)',
});

const projectGroupRoutePrefixPattern = /^group:/;
const legacyAliasRoutePrefixPattern = /^legacy-alias:/;

const groupRouteKey = (project: KnownSkillProjectPath): string | undefined => {
  if (project.groupId === undefined) {
    return;
  }
  const withoutPrefix = project.groupId
    .replace(projectGroupRoutePrefixPattern, '')
    .replace(legacyAliasRoutePrefixPattern, '');
  return withoutPrefix || project.groupLabel || project.label;
};

const knownProjectScopesFromPaths = (projects: readonly KnownSkillProjectPath[]): readonly KnownProjectScope[] => {
  const scopes = new Map<string, KnownProjectScope>();
  for (const project of projects) {
    const scopePath = project.groupId ?? project.path;
    const existing = scopes.get(scopePath);
    const routeKey = groupRouteKey(project);
    const sourcePaths = existing?.sourcePaths ?? [];
    scopes.set(scopePath, {
      label: project.groupLabel ?? project.label,
      path: scopePath,
      ...(routeKey === undefined ? {} : { routeKey }),
      sourcePaths: [...sourcePaths, project.path],
    });
  }
  return [...scopes.values()];
};

interface SkillsInitialData {
  knownProjectPaths: Awaited<ReturnType<typeof getKnownSkillProjectPaths>>;
  skills: Awaited<ReturnType<typeof getSkillManagementSnapshot>>;
}

function SkillsRoute() {
  return (
    <ClientOnly fallback={<SkillsLoadingShell />}>
      <SkillsClientRoute />
    </ClientOnly>
  );
}

function SkillsLoadingShell() {
  return (
    <main class={page} data-hydrated="false">
      <div class={shell}>
        <header class={header}>
          <div class={titleBlock}>
            <h1 class={title}>Skill management</h1>
            <div class={meta}>Loading skills…</div>
          </div>
        </header>
      </div>
    </main>
  );
}

function SkillsClientRoute() {
  const location = useLocation();
  let refreshButtonElement: HTMLButtonElement | undefined;
  const initialQuery = createQuery(() => ({
    enabled: !isServer,
    queryFn: loadSkillsInitialData,
    queryKey: webQueryKeys.skillsInitial,
  }));
  const data = createMemo<SkillsInitialData>(() => {
    if (initialQuery.data) {
      return initialQuery.data;
    }
    const message =
      initialQuery.error instanceof Error ? initialQuery.error.message : 'Skill data could not be loaded.';
    const failure = {
      error: {
        message: initialQuery.isPending ? 'Loading…' : message,
        tag: initialQuery.isPending ? 'Loading' : 'ClientReadError',
      },
      ok: false,
    } as const;
    return { knownProjectPaths: failure, skills: failure };
  });
  const [clientMounted, setClientMounted] = createSignal(false);
  onMount(() => setClientMounted(true));
  const hydrated = () => clientMounted() && !initialQuery.isPending;
  const [activeCellStateFilter, setActiveCellStateFilter] = createSignal<SkillCellStateFilter | undefined>();
  const controller = createSkillsRouteController(data);
  const {
    addProjectPath,
    applyReconcile,
    applyWorkspaceSnapshot,
    cancelReconcile,
    createTargetDirectory,
    discardDirtySnapshot,
    errorMessage,
    keepDirtySnapshot,
    knownProjectPaths,
    knownProjectPathsError,
    markdownRefreshVersion,
    operationNotice,
    pendingOperation,
    pendingSnapshotReplacement,
    previewReconcile,
    projectInventories,
    projectInventoriesLoading,
    projectPathDraft,
    projectPaths,
    reconcilePlan,
    reconcileSkill,
    refreshSkills,
    removeProjectPath,
    result,
    saveConfig,
    setDirtyMarkdownDraft,
    setOperationNotice,
    setProjectPathDraft,
    snapshot,
    sourceRepoPath,
    toggleSkill,
    updateSourceRepoPath,
  } = controller;

  // Route keys resolve against every project the tree can display: discovered
  // paths plus scanned inventories (which include config-only paths).
  const selectionProjects = createMemo(() => {
    const inventories = projectInventories();
    const knownScopes = knownProjectScopesFromPaths(knownProjectPaths());
    const knownSourcePaths = new Set(knownScopes.flatMap((project) => project.sourcePaths ?? [project.path]));
    const inventoryProjects =
      inventories?.ok === true
        ? inventories.data
            .filter((inventory) => !knownSourcePaths.has(inventory.projectPath))
            .map((inventory) => ({
              label: inventory.projectPath.split('/').filter(Boolean).at(-1) ?? inventory.projectPath,
              path: inventory.projectPath,
            }))
        : [];
    const byPath = new Map<string, KnownProjectScope>();
    for (const project of [...knownScopes, ...inventoryProjects]) {
      byPath.set(project.path, project);
    }
    return [...byPath.values()];
  });

  const routeSelection = createMemo(() => skillSelectionFromPath(location().pathname, selectionProjects()));

  return (
    <main
      aria-busy={hydrated() ? undefined : 'true'}
      class={page}
      data-hydrated={hydrated() ? 'true' : 'false'}
      data-known-project-paths-status={data().knownProjectPaths.ok ? 'ok' : 'error'}
      inert={!hydrated()}
    >
      <div class={shell}>
        <header class={header}>
          <div class={cx(headerTop, headerWrap)}>
            <div class={titleBlock}>
              <h1 class={title}>Skill management</h1>
              <div class={meta}>
                <Show fallback="Snapshot unavailable" when={snapshot()}>
                  {(value) =>
                    value().configured
                      ? `Source ${value().config.sourceRepoPath ?? 'not configured'}`
                      : 'Skill source repository not configured'
                  }
                </Show>
              </div>
            </div>
            <div class={cx(headerActions, headerActionsWrap)}>
              <button
                aria-busy={pendingOperation() === 'refresh-skills' ? 'true' : undefined}
                class={navButton}
                disabled={pendingOperation() !== null}
                onClick={refreshSkills}
                ref={(element) => {
                  refreshButtonElement = element;
                }}
                type="button"
              >
                Refresh skills
              </button>
              <Link class={navButton} search={dashboardSearchDefaults} to="/">
                Report
              </Link>
              <Link class={navButton} to="/sync">
                Sync
              </Link>
              <Link class={navButton} to="/sources">
                Sources
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <div class={pageStack}>
          <Show
            fallback={
              <ErrorPanel
                message={errorMessage()}
                onRetry={() => {
                  initialQuery.refetch().catch(() => undefined);
                }}
              />
            }
            when={result().ok}
          >
            <Show
              fallback={
                <UnconfiguredPanel
                  addProjectPath={addProjectPath}
                  knownProjectPaths={knownProjectPaths()}
                  knownProjectPathsError={knownProjectPathsError()}
                  onDismissOperationNotice={() => setOperationNotice(null)}
                  operationNotice={operationNotice()}
                  pendingOperation={pendingOperation()}
                  projectPathDraft={projectPathDraft()}
                  projectPaths={projectPaths()}
                  removeProjectPath={removeProjectPath}
                  saveConfig={saveConfig}
                  setProjectPathDraft={setProjectPathDraft}
                  setSourceRepoPath={updateSourceRepoPath}
                  sourceRepoPath={sourceRepoPath()}
                />
              }
              when={snapshot()?.configured}
            >
              <ConfiguredSnapshot
                activeCellStateFilter={activeCellStateFilter()}
                addProjectPath={addProjectPath}
                createTargetDirectory={createTargetDirectory}
                knownProjectPaths={knownProjectPaths()}
                knownProjectPathsError={knownProjectPathsError()}
                markdownRefreshVersion={markdownRefreshVersion()}
                onApplyReconcile={applyReconcile}
                onCancelReconcile={cancelReconcile}
                onCellStateFilterChange={setActiveCellStateFilter}
                onDismissOperationNotice={() => setOperationNotice(null)}
                onMarkdownDraftStateChange={setDirtyMarkdownDraft}
                onPreviewReconcile={previewReconcile}
                onSnapshot={applyWorkspaceSnapshot}
                operationNotice={operationNotice()}
                pendingOperation={pendingOperation()}
                projectInventories={projectInventories()}
                projectInventoriesLoading={projectInventoriesLoading()}
                projectPathDraft={projectPathDraft()}
                projectPaths={projectPaths()}
                projectScopes={knownProjectScopesFromPaths(knownProjectPaths())}
                reconcilePlan={reconcilePlan()}
                reconcileSkill={reconcileSkill}
                removeProjectPath={removeProjectPath}
                routeSelection={routeSelection()}
                saveConfig={saveConfig}
                setProjectPathDraft={setProjectPathDraft}
                setSourceRepoPath={updateSourceRepoPath}
                snapshot={snapshot()!}
                sourceRepoPath={sourceRepoPath()}
                toggleSkill={toggleSkill}
              />
            </Show>
          </Show>
        </div>
        <Show when={pendingSnapshotReplacement()}>
          <DiscardConfirmationDialog
            description="The refreshed snapshot no longer contains this skill. Keep editing to preserve the draft, or discard it to apply the refreshed snapshot."
            idPrefix="discard-removed-skill-draft"
            onDiscard={discardDirtySnapshot}
            onKeep={keepDirtySnapshot}
            restoreFocus={() => refreshButtonElement?.focus()}
          />
        </Show>
      </div>
    </main>
  );
}

function ConfiguredSnapshot(props: {
  activeCellStateFilter: SkillCellStateFilter | undefined;
  addProjectPath: () => void;
  createTargetDirectory: (targetId: string) => void;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  markdownRefreshVersion: number;
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onCellStateFilterChange: (filter: SkillCellStateFilter | undefined) => void;
  onDismissOperationNotice: () => void;
  onMarkdownDraftStateChange: (guard: SkillMarkdownDraftGuard | undefined) => void;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  onPreviewReconcile: () => void;
  operationNotice: OperationNotice | null;
  pendingOperation: string | null;
  projectInventories: ProjectInventoriesResult | undefined;
  projectInventoriesLoading: boolean;
  projectPathDraft: string;
  projectPaths: readonly string[];
  projectScopes: readonly KnownProjectScope[];
  reconcilePlan: ReconcilePlanSummary | null;
  reconcileSkill: (skillName: string) => void;
  removeProjectPath: (value: string) => void;
  saveConfig: (sourceRepoPath: string) => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  snapshot: SkillManagementSnapshot;
  routeSelection: ReturnType<typeof skillSelectionFromPath>;
  sourceRepoPath: string;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) {
  const matrix = createMemo(() => buildSkillMatrix(props.snapshot));
  const disabledRows = createMemo(() => matrix().rows.filter((row) => !row.enabled));
  const snapshotDiagnostics = createMemo(() =>
    props.snapshot.diagnostics.filter((diagnostic) => diagnostic.skillName === undefined),
  );

  return (
    <div class={stack}>
      <OperationBanner notice={props.operationNotice} onDismiss={props.onDismissOperationNotice} />
      <Show when={props.projectInventories?.ok === false}>
        <section class={panel}>
          <p class={meta}>{props.projectInventories?.ok === false ? props.projectInventories.error.message : ''}</p>
        </section>
      </Show>
      <SkillsWorkspace
        activeCellStateFilter={props.activeCellStateFilter}
        configurationPanel={() => (
          <div class={foldsGrid}>
            <DisabledFold
              disabledRows={disabledRows()}
              pendingOperation={props.pendingOperation}
              toggleSkill={props.toggleSkill}
            />
            <ConfigurationFold
              addProjectPath={props.addProjectPath}
              createTargetDirectory={props.createTargetDirectory}
              knownProjectPaths={props.knownProjectPaths}
              knownProjectPathsError={props.knownProjectPathsError}
              pendingOperation={props.pendingOperation}
              projectPathDraft={props.projectPathDraft}
              projectPaths={props.projectPaths}
              removeProjectPath={props.removeProjectPath}
              saveConfig={props.saveConfig}
              setProjectPathDraft={props.setProjectPathDraft}
              setSourceRepoPath={props.setSourceRepoPath}
              snapshot={props.snapshot}
              snapshotDiagnostics={snapshotDiagnostics()}
              sourceRepoPath={props.sourceRepoPath}
            />
          </div>
        )}
        knownProjectPaths={props.projectScopes}
        markdownRefreshVersion={props.markdownRefreshVersion}
        onApplyReconcile={props.onApplyReconcile}
        onCancelReconcile={props.onCancelReconcile}
        onCellStateFilterChange={props.onCellStateFilterChange}
        onMarkdownDraftStateChange={props.onMarkdownDraftStateChange}
        onPreviewReconcile={props.onPreviewReconcile}
        onSnapshot={props.onSnapshot}
        pendingOperation={props.pendingOperation}
        projectInventories={props.projectInventories}
        projectInventoriesLoading={props.projectInventoriesLoading}
        reconcilePlan={props.reconcilePlan}
        reconcileSkill={props.reconcileSkill}
        routeSelection={props.routeSelection}
        snapshot={props.snapshot}
        toggleSkill={props.toggleSkill}
      />
    </div>
  );
}

function DisabledFold(props: {
  disabledRows: readonly ReturnType<typeof buildSkillMatrix>['rows'][number][];
  pendingOperation: string | null;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) {
  return (
    <details class={cx(panel, fold)}>
      <summary class={foldSummary}>
        <span class={strongCell}>Disabled</span>
        <span class={meta}>{props.disabledRows.length}</span>
      </summary>
      <div class={foldBody}>
        <Show fallback={<p class={meta}>No disabled skills.</p>} when={props.disabledRows.length > 0}>
          <For each={props.disabledRows}>
            {(row) => (
              <div class={disabledRow}>
                <div>
                  <div class={strongCell}>{row.name}</div>
                  <div class={meta}>{row.description || 'No description'}</div>
                </div>
                <button
                  aria-busy={props.pendingOperation === `toggle:${row.name}` ? 'true' : undefined}
                  class={cx(ghostButton, busyButton)}
                  data-pending={props.pendingOperation === `toggle:${row.name}` ? 'true' : undefined}
                  disabled={props.pendingOperation !== null}
                  onClick={() => props.toggleSkill(row.name, true)}
                  type="button"
                >
                  Enable
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </details>
  );
}

function ConfigurationFold(props: {
  addProjectPath: () => void;
  createTargetDirectory: (targetId: string) => void;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  pendingOperation: string | null;
  projectPathDraft: string;
  projectPaths: readonly string[];
  removeProjectPath: (value: string) => void;
  saveConfig: (sourceRepoPath: string) => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  snapshot: SkillManagementSnapshot;
  snapshotDiagnostics: readonly SkillManagementSnapshot['diagnostics'][number][];
  sourceRepoPath: string;
}) {
  return (
    <details class={cx(panel, fold)}>
      <summary class={foldSummary}>
        <span class={strongCell}>Configuration & runtimes</span>
        <span class={meta}>
          {props.snapshot.targets.filter((target) => target.enabled).length} enabled / {props.snapshot.targets.length}{' '}
          configured
        </span>
      </summary>
      <div class={foldBody}>
        <ConfigPanel
          addProjectPath={props.addProjectPath}
          knownProjectPaths={props.knownProjectPaths}
          knownProjectPathsError={props.knownProjectPathsError}
          pendingOperation={props.pendingOperation}
          projectPathDraft={props.projectPathDraft}
          projectPaths={props.projectPaths}
          removeProjectPath={props.removeProjectPath}
          saveConfig={props.saveConfig}
          setProjectPathDraft={props.setProjectPathDraft}
          setSourceRepoPath={props.setSourceRepoPath}
          sourceRepoPath={props.sourceRepoPath}
        />
        <TargetsPanel
          createTargetDirectory={props.createTargetDirectory}
          pendingOperation={props.pendingOperation}
          snapshot={props.snapshot}
        />
        <Show when={props.snapshotDiagnostics.length > 0}>
          <div class={stack}>
            <For each={props.snapshotDiagnostics}>
              {(diagnostic) => (
                <p class={meta}>
                  {diagnostic.severity}: {diagnostic.message}
                </p>
              )}
            </For>
          </div>
        </Show>
      </div>
    </details>
  );
}

function ConfigPanel(props: {
  addProjectPath: () => void;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  pendingOperation: string | null;
  projectPathDraft: string;
  projectPaths: readonly string[];
  removeProjectPath: (value: string) => void;
  saveConfig: (sourceRepoPath: string) => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  sourceRepoPath: string;
}) {
  let sourceRepoPathInput: HTMLInputElement | null = null;

  const submitSourceRepoPath = () => {
    props.saveConfig(sourceRepoPathInput?.value ?? props.sourceRepoPath);
  };

  return (
    <section class={stack}>
      <div class={configStack}>
        <div class={formGrid}>
          <label class={formField}>
            <span class={labelText}>Source repository</span>
            <input
              class={inputClass}
              name="sourceRepoPath"
              onInput={(event) => props.setSourceRepoPath(event.currentTarget.value)}
              ref={(element) => {
                sourceRepoPathInput = element;
              }}
              value={props.sourceRepoPath}
            />
            <span class={helpText}>Repository that owns shared skills, expected at `skills/*/SKILL.md`.</span>
          </label>
          <button
            aria-busy={props.pendingOperation === 'save-config' ? 'true' : undefined}
            class={cx(commandButton, busyButton)}
            data-pending={props.pendingOperation === 'save-config' ? 'true' : undefined}
            disabled={props.pendingOperation !== null}
            onClick={submitSourceRepoPath}
            type="button"
          >
            Save source
          </button>
        </div>
        <ProjectPathsPanel
          addProjectPath={props.addProjectPath}
          knownProjectPaths={props.knownProjectPaths}
          knownProjectPathsError={props.knownProjectPathsError}
          pendingOperation={props.pendingOperation}
          projectPathDraft={props.projectPathDraft}
          projectPaths={props.projectPaths}
          removeProjectPath={props.removeProjectPath}
          setProjectPathDraft={props.setProjectPathDraft}
        />
      </div>
    </section>
  );
}

function ProjectPathsPanel(props: {
  addProjectPath: () => void;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  pendingOperation: string | null;
  projectPathDraft: string;
  projectPaths: readonly string[];
  removeProjectPath: (value: string) => void;
  setProjectPathDraft: (value: string) => void;
}) {
  return (
    <div class={stack}>
      <div class={panelHeader}>
        <h3 class={panelTitle}>Project paths</h3>
        <p class={panelSub}>Pick from projects already present in the report, or add a path manually.</p>
      </div>
      <div class={projectPickerGrid}>
        <label class={formField}>
          <span class={labelText}>Scanned project</span>
          <select
            class={inputClass}
            onInput={(event) => props.setProjectPathDraft(event.currentTarget.value)}
            value={props.projectPathDraft}
          >
            <option value="">Select a project</option>
            <For each={props.knownProjectPaths}>
              {(project) => (
                <option disabled={props.projectPaths.includes(project.path)} value={project.path}>
                  {project.label} · {project.path}
                </option>
              )}
            </For>
          </select>
          <Show
            fallback={<span class={helpText}>No scanned projects with paths in the current report payload.</span>}
            when={props.knownProjectPaths.length > 0}
          >
            <span class={helpText}>{count(props.knownProjectPaths.length, 'scanned project')} available.</span>
          </Show>
        </label>
        <ManualProjectPathField
          addProjectPath={props.addProjectPath}
          projectPathDraft={props.projectPathDraft}
          setProjectPathDraft={props.setProjectPathDraft}
        />
        <button
          aria-busy={props.pendingOperation?.startsWith('project:add:') ? 'true' : undefined}
          class={cx(ghostButton, busyButton)}
          data-pending={props.pendingOperation?.startsWith('project:add:') ? 'true' : undefined}
          disabled={props.pendingOperation !== null || props.projectPathDraft.trim().length === 0}
          onClick={props.addProjectPath}
          type="button"
        >
          Add
        </button>
      </div>
      <Show when={props.knownProjectPathsError}>
        {(message) => <p class={meta}>Could not load scanned projects: {message()}</p>}
      </Show>
      <Show fallback={<p class={meta}>No manual project paths.</p>} when={props.projectPaths.length > 0}>
        <div class={projectPathList}>
          <For each={props.projectPaths}>
            {(projectPath) => (
              <div class={projectPathRow}>
                <span class={meta}>{projectPath}</span>
                <button
                  aria-busy={props.pendingOperation === `project:remove:${projectPath}` ? 'true' : undefined}
                  class={cx(ghostButton, busyButton)}
                  data-pending={props.pendingOperation === `project:remove:${projectPath}` ? 'true' : undefined}
                  disabled={props.pendingOperation !== null}
                  onClick={() => props.removeProjectPath(projectPath)}
                  type="button"
                >
                  Remove
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function ManualProjectPathField(props: {
  addProjectPath: () => void;
  projectPathDraft: string;
  setProjectPathDraft: (value: string) => void;
}) {
  return (
    <label class={formField}>
      <span class={labelText}>Manual path</span>
      <input
        class={inputClass}
        onInput={(event) => props.setProjectPathDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            props.addProjectPath();
          }
        }}
        value={props.projectPathDraft}
      />
      <span class={helpText}>Use this when the project has not appeared in the report yet.</span>
    </label>
  );
}

function TargetsPanel(props: {
  createTargetDirectory: (targetId: string) => void;
  pendingOperation: string | null;
  snapshot: SkillManagementSnapshot;
}) {
  return (
    <section class={stack}>
      <div class={panelHeader}>
        <h3 class={panelTitle}>Runtimes</h3>
        <p class={panelSub}>
          {props.snapshot.targets.filter((target) => target.enabled).length} enabled /{' '}
          {props.snapshot.summary.targetCount} configured
        </p>
      </div>
      <For each={props.snapshot.targets}>
        {(target) => (
          <div class={targetRow}>
            <div class={strongCell}>{target.label}</div>
            <div class={meta}>
              {target.enabled ? 'Enabled' : 'Disabled'} · {target.missing ? 'Missing directory' : 'Observed'} ·{' '}
              {target.path}
            </div>
            <Show when={target.missing}>
              <button
                aria-busy={props.pendingOperation === `target:${target.id}` ? 'true' : undefined}
                class={cx(ghostButton, busyButton)}
                data-pending={props.pendingOperation === `target:${target.id}` ? 'true' : undefined}
                disabled={props.pendingOperation !== null}
                onClick={() => props.createTargetDirectory(target.id)}
                type="button"
              >
                Create directory
              </button>
            </Show>
          </div>
        )}
      </For>
    </section>
  );
}

function ErrorPanel(props: { message: string; onRetry?: () => void }) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Snapshot error</h2>
        <p class={panelSub}>{props.message}</p>
        <Show when={props.onRetry}>
          {(onRetry) => (
            <button class={ghostButton} onClick={onRetry()} type="button">
              Retry
            </button>
          )}
        </Show>
      </div>
    </section>
  );
}

function OperationBanner(props: { notice: OperationNotice | null; onDismiss: () => void }) {
  return (
    <Show when={props.notice}>
      {(notice) => (
        <div
          class={cx(banner, notice().tone === 'error' ? bannerError : bannerOk)}
          role={notice().tone === 'error' ? 'alert' : 'status'}
        >
          <span>{notice().message}</span>
          <button class={ghostButton} onClick={props.onDismiss} type="button">
            Dismiss
          </button>
        </div>
      )}
    </Show>
  );
}

function UnconfiguredPanel(props: {
  addProjectPath: () => void;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  onDismissOperationNotice: () => void;
  operationNotice: OperationNotice | null;
  pendingOperation: string | null;
  projectPathDraft: string;
  projectPaths: readonly string[];
  removeProjectPath: (value: string) => void;
  saveConfig: (sourceRepoPath: string) => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  sourceRepoPath: string;
}) {
  return (
    <div class={stack}>
      <OperationBanner notice={props.operationNotice} onDismiss={props.onDismissOperationNotice} />
      <section class={emptyState}>
        Configure <span class={strongCell}>skills.sourceRepoPath</span> in the ai-usage config to load the local skill
        source repository.
      </section>
      <section class={panel}>
        <ConfigPanel
          addProjectPath={props.addProjectPath}
          knownProjectPaths={props.knownProjectPaths}
          knownProjectPathsError={props.knownProjectPathsError}
          pendingOperation={props.pendingOperation}
          projectPathDraft={props.projectPathDraft}
          projectPaths={props.projectPaths}
          removeProjectPath={props.removeProjectPath}
          saveConfig={props.saveConfig}
          setProjectPathDraft={props.setProjectPathDraft}
          setSourceRepoPath={props.setSourceRepoPath}
          sourceRepoPath={props.sourceRepoPath}
        />
      </section>
    </div>
  );
}
