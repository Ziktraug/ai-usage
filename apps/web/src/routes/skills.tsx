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
import type { ProjectionAction, SkillManagementConfig, SkillManagementSnapshot } from '@ai-usage/skills';
import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/solid-router';
import { createEffect, createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';
import {
  createManagedSkillTargetDirectory,
  getKnownSkillProjectPaths,
  getSkillManagementSnapshot,
  getSkillProjectInventories,
  type KnownSkillProjectPath,
  previewReconcileAllManagedSkills,
  reconcileAllManagedSkills,
  reconcileManagedSkill,
  saveSkillManagementConfig,
  toggleManagedSkill,
} from '../server/skills';
import {
  buildSkillMatrix,
  count,
  describeReconcileActions,
  parseSelectionKey,
  type ReconcilePlanSummary,
  type SkillCellStateFilter,
} from '../skills-page-model';
import { type ProjectInventoriesResult, SkillsWorkspace } from '../skills-workspace';

interface SkillsSearch {
  sel?: string;
}

export const Route = createFileRoute('/skills')({
  validateSearch: (search: Record<string, unknown>): SkillsSearch => {
    const sel = typeof search.sel === 'string' && parseSelectionKey(search.sel) ? search.sel : undefined;
    return sel === undefined ? {} : { sel };
  },
  loader: async () => ({
    knownProjectPaths: await getKnownSkillProjectPaths(),
    skills: await getSkillManagementSnapshot(),
  }),
  component: SkillsRoute,
});

const dashboardSearchDefaults = dashboardSearchDefaultsFor('date');

type SkillSnapshotResult =
  | { ok: true; data: SkillManagementSnapshot }
  | { ok: false; error: { message: string; tag: string } };

type KnownProjectPathsResult =
  | { ok: true; data: readonly KnownSkillProjectPath[] }
  | { ok: false; error: { message: string; tag: string } };

interface SkillReconcileResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

type SkillReconcileServerResult =
  | { ok: true; data: SkillReconcileResult }
  | { ok: false; error: { message: string; tag: string } };

interface OperationNotice {
  message: string;
  tone: 'error' | 'ok';
}

const skillSnapshotResultFrom = (value: unknown): SkillSnapshotResult => {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return { ok: false, error: { message: 'Invalid skills snapshot response', tag: 'InvalidResponse' } };
  }
  return value as SkillSnapshotResult;
};

const pageStack = css({
  display: 'grid',
  gap: '16px',
});

// The shared headerTop does not wrap; with this page's long title the fixed
// header actions overflow the 390px viewport, so allow wrapping here.
const headerWrap = css({
  flexWrap: 'wrap',
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

const skillSnapshotResult = (value: unknown) => value as SkillSnapshotResult;

const targetLabel = (snapshot: SkillManagementSnapshot, targetId: string) =>
  snapshot.targets.find((target) => target.id === targetId)?.label ?? targetId;

const actionNotice = (actions: readonly ProjectionAction[], snapshot: SkillManagementSnapshot, fallback: string) => {
  const applied = actions.filter((action) => action.type !== 'noop' && action.type !== 'refuse-unmanaged-mutation');
  if (applied.length === 0) {
    return 'Nothing to change.';
  }
  if (applied.length === 1) {
    const action = applied.at(0);
    if (action === undefined) {
      return 'Nothing to change.';
    }
    if (action.type === 'create-symlink') {
      return `${action.skillName} linked to ${targetLabel(snapshot, action.targetId)}.`;
    }
    if (action.type === 'repair-symlink') {
      return `${action.skillName} repaired in ${targetLabel(snapshot, action.targetId)}.`;
    }
    return `${action.skillName} unlinked from ${targetLabel(snapshot, action.targetId)}.`;
  }
  return `${fallback}: ${count(applied.length, 'change')} applied.`;
};

function SkillsRoute() {
  const data = Route.useLoaderData();
  const search = useSearch({ from: '/skills' });
  const navigate = useNavigate({ from: '/skills' });
  const [result, setResult] = createSignal<SkillSnapshotResult>(skillSnapshotResultFrom(data().skills));
  const knownProjectPathsResult = createMemo(() => data().knownProjectPaths as KnownProjectPathsResult);
  const knownProjectPaths = createMemo(() => {
    const current = knownProjectPathsResult();
    return current.ok ? current.data : [];
  });
  const knownProjectPathsError = createMemo(() => {
    const current = knownProjectPathsResult();
    return current.ok ? null : current.error.message;
  });
  const [pendingOperation, setPendingOperation] = createSignal<string | null>(null);
  const [operationNotice, setOperationNotice] = createSignal<OperationNotice | null>(null);
  const [reconcilePlan, setReconcilePlan] = createSignal<ReconcilePlanSummary | null>(null);
  const [activeCellStateFilter, setActiveCellStateFilter] = createSignal<SkillCellStateFilter | undefined>();
  const snapshot = createMemo(() => {
    const current = result();
    return current.ok ? current.data : undefined;
  });
  const errorMessage = createMemo(() => {
    const current = result();
    return current.ok ? '' : current.error.message;
  });
  const [sourceRepoPath, setSourceRepoPath] = createSignal(snapshot()?.config.sourceRepoPath ?? '');
  const [projectPaths, setProjectPaths] = createSignal<readonly string[]>(snapshot()?.config.projectPaths ?? []);
  const [projectPathDraft, setProjectPathDraft] = createSignal('');
  const [projectInventories] = createResource(
    () => (snapshot()?.configured ? true : undefined),
    async () => (await getSkillProjectInventories()) as ProjectInventoriesResult,
  );

  createEffect(() => {
    const current = snapshot();
    if (current === undefined) {
      return;
    }
    setProjectPaths(current.config.projectPaths ?? []);
  });

  const applySnapshotResult = (next: SkillSnapshotResult, message: string) => {
    setResult(next);
    setOperationNotice(next.ok ? { message, tone: 'ok' } : { message: next.error.message, tone: 'error' });
  };

  const applyReconcileResult = (next: SkillReconcileServerResult, fallbackMessage: string) => {
    if (!next.ok) {
      setOperationNotice({ message: next.error.message, tone: 'error' });
      return;
    }
    setResult({ ok: true, data: next.data.snapshot });
    setOperationNotice({ message: actionNotice(next.data.actions, next.data.snapshot, fallbackMessage), tone: 'ok' });
  };

  const runOperation = async (operation: string, action: () => Promise<void>) => {
    if (pendingOperation()) {
      return;
    }
    setPendingOperation(operation);
    setOperationNotice(null);
    // Any operation invalidates a pending reconcile preview: the planned
    // actions were computed against the pre-operation snapshot.
    setReconcilePlan(null);
    try {
      await action();
    } finally {
      setPendingOperation(null);
    }
  };

  const configInput = (overrides: { projectPaths?: readonly string[]; sourceRepoPath?: string } = {}) => {
    const current = snapshot()?.config ?? {};
    const { projectPaths: _projectPaths, ...currentWithoutProjectPaths } = current;
    const next: SkillManagementConfig = currentWithoutProjectPaths;
    const source = (overrides.sourceRepoPath ?? current.sourceRepoPath ?? '').trim();
    if (source) {
      next.sourceRepoPath = source;
    }
    const nextProjectPaths = overrides.projectPaths ?? projectPaths();
    if (nextProjectPaths.length > 0) {
      next.projectPaths = nextProjectPaths;
    }
    return next;
  };

  const addProjectPath = () => {
    const value = projectPathDraft().trim();
    if (!value || projectPaths().includes(value)) {
      return;
    }
    const nextProjectPaths = [...projectPaths(), value];
    runOperation(`project:add:${value}`, async () => {
      applySnapshotResult(
        skillSnapshotResult(await saveSkillManagementConfig({ data: configInput({ projectPaths: nextProjectPaths }) })),
        `Project path added: ${value}.`,
      );
      setProjectPathDraft('');
    });
  };

  const removeProjectPath = (value: string) =>
    runOperation(`project:remove:${value}`, async () => {
      const nextProjectPaths = projectPaths().filter((projectPath) => projectPath !== value);
      applySnapshotResult(
        skillSnapshotResult(await saveSkillManagementConfig({ data: configInput({ projectPaths: nextProjectPaths }) })),
        `Project path removed: ${value}.`,
      );
    });

  const saveConfig = () =>
    runOperation('save-config', async () => {
      applySnapshotResult(
        skillSnapshotResult(
          await saveSkillManagementConfig({ data: configInput({ sourceRepoPath: sourceRepoPath() }) }),
        ),
        'Skill source saved.',
      );
    });

  const toggleSkill = (skillName: string, enabled: boolean) =>
    runOperation(`toggle:${skillName}`, async () => {
      applyReconcileResult(
        (await toggleManagedSkill({ data: { enabled, skillName } })) as SkillReconcileServerResult,
        enabled ? `Enabled ${skillName}` : `Disabled ${skillName}`,
      );
    });

  const reconcileSkill = (skillName: string) =>
    runOperation(`reconcile:${skillName}`, async () => {
      applyReconcileResult(
        (await reconcileManagedSkill({ data: skillName })) as SkillReconcileServerResult,
        `Reconciled ${skillName}`,
      );
    });

  const previewReconcile = () =>
    runOperation('preview-reconcile', async () => {
      const next = (await previewReconcileAllManagedSkills()) as SkillReconcileServerResult;
      if (!next.ok) {
        setOperationNotice({ message: next.error.message, tone: 'error' });
        return;
      }
      setResult({ ok: true, data: next.data.snapshot });
      setReconcilePlan(describeReconcileActions(next.data.actions, next.data.snapshot.targets));
    });

  const applyReconcile = () =>
    runOperation('reconcile-all', async () => {
      applyReconcileResult(
        (await reconcileAllManagedSkills()) as SkillReconcileServerResult,
        'Reconciled active skills',
      );
    });

  const cancelReconcile = () => setReconcilePlan(null);

  const createTargetDirectory = (targetId: string) =>
    runOperation(`target:${targetId}`, async () => {
      applySnapshotResult(
        skillSnapshotResult(await createManagedSkillTargetDirectory({ data: { targetId } })),
        `Created target directory ${targetId}.`,
      );
    });

  const updateSelectionSearch = (sel: string, options: { replace?: boolean } = {}) => {
    navigate({
      search: { sel },
      ...(options.replace === undefined ? {} : { replace: options.replace }),
      resetScroll: false,
    }).catch((error: unknown) => {
      console.error(error);
    });
  };

  return (
    <main class={page}>
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
            <div class={headerActions}>
              <Link class={navButton} search={dashboardSearchDefaults} to="/">
                Report
              </Link>
              <Link class={navButton} to="/sync">
                Sync
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <div class={pageStack}>
          <Show fallback={<ErrorPanel message={errorMessage()} />} when={result().ok}>
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
                  setSourceRepoPath={setSourceRepoPath}
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
                onApplyReconcile={applyReconcile}
                onCancelReconcile={cancelReconcile}
                onCellStateFilterChange={setActiveCellStateFilter}
                onDismissOperationNotice={() => setOperationNotice(null)}
                onPreviewReconcile={previewReconcile}
                onSelectionSearchChange={updateSelectionSearch}
                onSnapshot={(nextSnapshot) => setResult({ ok: true, data: nextSnapshot })}
                operationNotice={operationNotice()}
                pendingOperation={pendingOperation()}
                projectInventories={projectInventories()}
                projectInventoriesLoading={projectInventories.loading}
                projectPathDraft={projectPathDraft()}
                projectPaths={projectPaths()}
                reconcilePlan={reconcilePlan()}
                reconcileSkill={reconcileSkill}
                removeProjectPath={removeProjectPath}
                saveConfig={saveConfig}
                selectionKey={search().sel}
                setProjectPathDraft={setProjectPathDraft}
                setSourceRepoPath={setSourceRepoPath}
                snapshot={snapshot()!}
                sourceRepoPath={sourceRepoPath()}
                toggleSkill={toggleSkill}
              />
            </Show>
          </Show>
        </div>
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
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onCellStateFilterChange: (filter: SkillCellStateFilter | undefined) => void;
  onDismissOperationNotice: () => void;
  onSnapshot: (snapshot: SkillManagementSnapshot) => void;
  onPreviewReconcile: () => void;
  onSelectionSearchChange: (sel: string, options?: { replace?: boolean }) => void;
  operationNotice: OperationNotice | null;
  pendingOperation: string | null;
  projectInventories: ProjectInventoriesResult | undefined;
  projectInventoriesLoading: boolean;
  projectPathDraft: string;
  projectPaths: readonly string[];
  reconcilePlan: ReconcilePlanSummary | null;
  reconcileSkill: (skillName: string) => void;
  removeProjectPath: (value: string) => void;
  saveConfig: () => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  snapshot: SkillManagementSnapshot;
  selectionKey: string | undefined;
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
        knownProjectPaths={props.knownProjectPaths}
        onApplyReconcile={props.onApplyReconcile}
        onCancelReconcile={props.onCancelReconcile}
        onCellStateFilterChange={props.onCellStateFilterChange}
        onPreviewReconcile={props.onPreviewReconcile}
        onSelectionSearchChange={props.onSelectionSearchChange}
        onSnapshot={props.onSnapshot}
        pendingOperation={props.pendingOperation}
        projectInventories={props.projectInventories}
        projectInventoriesLoading={props.projectInventoriesLoading}
        reconcilePlan={props.reconcilePlan}
        reconcileSkill={props.reconcileSkill}
        selectionKey={props.selectionKey}
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
  saveConfig: () => void;
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
  saveConfig: () => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  sourceRepoPath: string;
}) {
  return (
    <section class={stack}>
      <div class={configStack}>
        <div class={formGrid}>
          <label class={formField}>
            <span class={labelText}>Source repository</span>
            <input
              class={inputClass}
              onInput={(event) => props.setSourceRepoPath(event.currentTarget.value)}
              value={props.sourceRepoPath}
            />
            <span class={helpText}>Repository that owns shared skills, expected at `skills/*/SKILL.md`.</span>
          </label>
          <button
            aria-busy={props.pendingOperation === 'save-config' ? 'true' : undefined}
            class={cx(commandButton, busyButton)}
            data-pending={props.pendingOperation === 'save-config' ? 'true' : undefined}
            disabled={props.pendingOperation !== null}
            onClick={props.saveConfig}
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

function ErrorPanel(props: { message: string }) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Snapshot error</h2>
        <p class={panelSub}>{props.message}</p>
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
  saveConfig: () => void;
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
