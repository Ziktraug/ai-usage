import { css, cx } from '@ai-usage/design-system/css';
import {
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
  type TabItem,
  Tabs,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import type {
  ProjectionAction,
  ProjectSkillInventory,
  SkillManagementConfig,
  SkillManagementSnapshot,
} from '@ai-usage/skills';
import { createFileRoute, Link } from '@tanstack/solid-router';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
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
import { SkillsConsolidate } from '../skills-consolidate';
import { SkillsDrawer } from '../skills-drawer';
import { SkillsHealth } from '../skills-health';
import { SkillsMatrix } from '../skills-matrix';
import {
  buildSkillHealthSummary,
  buildSkillMatrix,
  describeReconcileActions,
  groupUnmanagedEntries,
  type ReconcilePlanSummary,
} from '../skills-page-model';
import { SkillsProjects } from '../skills-projects';

export const Route = createFileRoute('/skills')({
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

type ProjectInventoriesResult =
  | { ok: true; data: readonly ProjectSkillInventory[] }
  | { ok: false; error: { message: string; tag: string } };

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

const operationPanel = css({
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
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

const actionSummary = (actions: readonly ProjectionAction[]) => {
  if (actions.length === 0) {
    return 'no changes';
  }
  return actions
    .map((action) =>
      action.type === 'refuse-unmanaged-mutation'
        ? `skipped: ${action.reason}`
        : `${action.type}: ${action.skillName} → ${action.targetId}`,
    )
    .join('\n');
};

function SkillsRoute() {
  const data = Route.useLoaderData();
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
  const [operationMessage, setOperationMessage] = createSignal<string | null>(null);
  const [reconcilePlan, setReconcilePlan] = createSignal<ReconcilePlanSummary | null>(null);
  const [activeTab, setActiveTab] = createSignal('global');
  const [selectedSkillName, setSelectedSkillName] = createSignal<string | null>(null);
  let drawerOrigin: HTMLElement | null = null;
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
    () => (activeTab() === 'projects' ? true : undefined),
    async () => (await getSkillProjectInventories()) as ProjectInventoriesResult,
  );

  const applySnapshotResult = (next: SkillSnapshotResult, message: string) => {
    setResult(next);
    setOperationMessage(next.ok ? message : next.error.message);
  };

  const applyReconcileResult = (next: SkillReconcileServerResult, fallbackMessage: string) => {
    if (!next.ok) {
      setOperationMessage(next.error.message);
      return;
    }
    setResult({ ok: true, data: next.data.snapshot });
    setOperationMessage(`${fallbackMessage}:\n${actionSummary(next.data.actions)}.`);
  };

  const runOperation = async (operation: string, action: () => Promise<void>) => {
    if (pendingOperation()) {
      return;
    }
    setPendingOperation(operation);
    setOperationMessage(null);
    // Any operation invalidates a pending reconcile preview: the planned
    // actions were computed against the pre-operation snapshot.
    setReconcilePlan(null);
    try {
      await action();
    } finally {
      setPendingOperation(null);
    }
  };

  const configInput = () => {
    const current = snapshot()?.config ?? {};
    const { projectPaths: _projectPaths, ...currentWithoutProjectPaths } = current;
    const next: SkillManagementConfig = currentWithoutProjectPaths;
    const source = sourceRepoPath().trim();
    if (source) {
      next.sourceRepoPath = source;
    }
    if (projectPaths().length > 0) {
      next.projectPaths = projectPaths();
    }
    return next;
  };

  const addProjectPath = () => {
    const value = projectPathDraft().trim();
    if (!value || projectPaths().includes(value)) {
      return;
    }
    setProjectPaths([...projectPaths(), value]);
    setProjectPathDraft('');
  };

  const removeProjectPath = (value: string) =>
    setProjectPaths(projectPaths().filter((projectPath) => projectPath !== value));

  const saveConfig = () =>
    runOperation('save-config', async () => {
      applySnapshotResult(
        skillSnapshotResult(await saveSkillManagementConfig({ data: configInput() })),
        'Skill config saved.',
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
        setOperationMessage(next.error.message);
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

  const selectedSkill = createMemo(() => {
    const skillName = selectedSkillName();
    return snapshot()?.skills.find((skill) => skill.name === skillName);
  });

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
                  operationMessage={operationMessage()}
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
                activeTab={activeTab()}
                addProjectPath={addProjectPath}
                createTargetDirectory={createTargetDirectory}
                knownProjectPaths={knownProjectPaths()}
                knownProjectPathsError={knownProjectPathsError()}
                onApplyReconcile={applyReconcile}
                onCancelReconcile={cancelReconcile}
                onOpenSkill={(skillName, element) => {
                  drawerOrigin = element;
                  setSelectedSkillName(skillName);
                }}
                onPreviewReconcile={previewReconcile}
                operationMessage={operationMessage()}
                pendingOperation={pendingOperation()}
                projectInventories={projectInventories()}
                projectInventoriesLoading={projectInventories.loading}
                projectPathDraft={projectPathDraft()}
                projectPaths={projectPaths()}
                reconcilePlan={reconcilePlan()}
                reconcileSkill={reconcileSkill}
                removeProjectPath={removeProjectPath}
                saveConfig={saveConfig}
                setActiveTab={setActiveTab}
                setProjectPathDraft={setProjectPathDraft}
                setSourceRepoPath={setSourceRepoPath}
                snapshot={snapshot()!}
                sourceRepoPath={sourceRepoPath()}
                toggleSkill={toggleSkill}
              />
            </Show>
          </Show>
        </div>
        <Show when={selectedSkill()}>
          {(skill) => (
            <SkillsDrawer
              finalFocusEl={() => drawerOrigin}
              onClose={() => setSelectedSkillName(null)}
              onSnapshot={(nextSnapshot) => setResult({ ok: true, data: nextSnapshot })}
              pendingOperation={pendingOperation()}
              reconcileSkill={reconcileSkill}
              skill={skill()}
              snapshot={snapshot()!}
              toggleSkill={toggleSkill}
            />
          )}
        </Show>
      </div>
    </main>
  );
}

function ConfiguredSnapshot(props: {
  activeTab: string;
  addProjectPath: () => void;
  createTargetDirectory: (targetId: string) => void;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onOpenSkill: (skillName: string, element: HTMLElement) => void;
  onPreviewReconcile: () => void;
  operationMessage: string | null;
  pendingOperation: string | null;
  projectInventories: ProjectInventoriesResult | undefined;
  projectInventoriesLoading: boolean;
  projectPathDraft: string;
  projectPaths: readonly string[];
  reconcilePlan: ReconcilePlanSummary | null;
  reconcileSkill: (skillName: string) => void;
  removeProjectPath: (value: string) => void;
  saveConfig: () => void;
  setActiveTab: (value: string) => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  snapshot: SkillManagementSnapshot;
  sourceRepoPath: string;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) {
  const health = createMemo(() => buildSkillHealthSummary(props.snapshot));
  const matrix = createMemo(() => buildSkillMatrix(props.snapshot));
  const unmanagedGroups = createMemo(() => groupUnmanagedEntries(props.snapshot));
  const disabledRows = createMemo(() => matrix().rows.filter((row) => !row.enabled));
  const snapshotDiagnostics = createMemo(() =>
    props.snapshot.diagnostics.filter((diagnostic) => diagnostic.skillName === undefined),
  );
  const projectItems = createMemo<readonly TabItem[]>(() => [
    {
      content: () => (
        <GlobalTab
          addProjectPath={props.addProjectPath}
          createTargetDirectory={props.createTargetDirectory}
          disabledRows={disabledRows()}
          health={health()}
          knownProjectPaths={props.knownProjectPaths}
          knownProjectPathsError={props.knownProjectPathsError}
          onApplyReconcile={props.onApplyReconcile}
          onCancelReconcile={props.onCancelReconcile}
          onOpenSkill={props.onOpenSkill}
          onPreviewReconcile={props.onPreviewReconcile}
          operationMessage={props.operationMessage}
          pendingOperation={props.pendingOperation}
          projectPathDraft={props.projectPathDraft}
          projectPaths={props.projectPaths}
          reconcilePlan={props.reconcilePlan}
          removeProjectPath={props.removeProjectPath}
          saveConfig={props.saveConfig}
          setProjectPathDraft={props.setProjectPathDraft}
          setSourceRepoPath={props.setSourceRepoPath}
          snapshot={props.snapshot}
          snapshotDiagnostics={snapshotDiagnostics()}
          sourceRepoPath={props.sourceRepoPath}
          toggleSkill={props.toggleSkill}
          unmanagedGroups={unmanagedGroups()}
        />
      ),
      label: 'Global',
      value: 'global',
    },
    {
      content: () => (
        <ProjectsTab
          addProjectPath={props.addProjectPath}
          knownProjectPaths={props.knownProjectPaths}
          knownProjectPathsError={props.knownProjectPathsError}
          operationMessage={props.operationMessage}
          pendingOperation={props.pendingOperation}
          projectInventories={props.projectInventories}
          projectInventoriesLoading={props.projectInventoriesLoading}
          projectPathDraft={props.projectPathDraft}
          projectPaths={props.projectPaths}
          removeProjectPath={props.removeProjectPath}
          saveConfig={props.saveConfig}
          setProjectPathDraft={props.setProjectPathDraft}
          setSourceRepoPath={props.setSourceRepoPath}
          sourceRepoPath={props.sourceRepoPath}
        />
      ),
      label: `Projects (${props.projectPaths.length})`,
      value: 'projects',
    },
  ]);

  return (
    <Tabs ariaLabel="Skill views" items={projectItems()} onValueChange={props.setActiveTab} value={props.activeTab} />
  );
}

function GlobalTab(props: {
  addProjectPath: () => void;
  createTargetDirectory: (targetId: string) => void;
  disabledRows: readonly ReturnType<typeof buildSkillMatrix>['rows'][number][];
  health: ReturnType<typeof buildSkillHealthSummary>;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onOpenSkill: (skillName: string, element: HTMLElement) => void;
  onPreviewReconcile: () => void;
  operationMessage: string | null;
  pendingOperation: string | null;
  projectPathDraft: string;
  projectPaths: readonly string[];
  reconcilePlan: ReconcilePlanSummary | null;
  removeProjectPath: (value: string) => void;
  saveConfig: () => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  snapshot: SkillManagementSnapshot;
  snapshotDiagnostics: readonly SkillManagementSnapshot['diagnostics'][number][];
  sourceRepoPath: string;
  toggleSkill: (skillName: string, enabled: boolean) => void;
  unmanagedGroups: ReturnType<typeof groupUnmanagedEntries>;
}) {
  return (
    <div class={stack}>
      <SkillsHealth snapshot={props.snapshot} summary={props.health} />
      <SkillsMatrix
        onApplyReconcile={props.onApplyReconcile}
        onCancelReconcile={props.onCancelReconcile}
        onOpenSkill={props.onOpenSkill}
        onPreviewReconcile={props.onPreviewReconcile}
        operationMessage={props.operationMessage}
        pendingOperation={props.pendingOperation}
        reconcilePlan={props.reconcilePlan}
        snapshot={props.snapshot}
        toggleSkill={props.toggleSkill}
      />
      <SkillsConsolidate groups={props.unmanagedGroups} total={props.health.consolidateCount} />
      <div class={foldsGrid}>
        <DisabledFold
          disabledRows={props.disabledRows}
          pendingOperation={props.pendingOperation}
          toggleSkill={props.toggleSkill}
        />
        <ConfigurationFold
          addProjectPath={props.addProjectPath}
          createTargetDirectory={props.createTargetDirectory}
          knownProjectPaths={props.knownProjectPaths}
          knownProjectPathsError={props.knownProjectPathsError}
          operationMessage={props.operationMessage}
          pendingOperation={props.pendingOperation}
          projectPathDraft={props.projectPathDraft}
          projectPaths={props.projectPaths}
          removeProjectPath={props.removeProjectPath}
          saveConfig={props.saveConfig}
          setProjectPathDraft={props.setProjectPathDraft}
          setSourceRepoPath={props.setSourceRepoPath}
          snapshot={props.snapshot}
          snapshotDiagnostics={props.snapshotDiagnostics}
          sourceRepoPath={props.sourceRepoPath}
        />
      </div>
    </div>
  );
}

function ProjectsTab(props: {
  addProjectPath: () => void;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  operationMessage: string | null;
  pendingOperation: string | null;
  projectInventories: ProjectInventoriesResult | undefined;
  projectInventoriesLoading: boolean;
  projectPathDraft: string;
  projectPaths: readonly string[];
  removeProjectPath: (value: string) => void;
  saveConfig: () => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  sourceRepoPath: string;
}) {
  const inventories = () => (props.projectInventories?.ok ? props.projectInventories.data : []);
  return (
    <div class={stack}>
      <Show when={props.projectInventories?.ok === false}>
        <section class={panel}>
          <p class={meta}>{props.projectInventories?.ok === false ? props.projectInventories.error.message : ''}</p>
        </section>
      </Show>
      <Show
        fallback={
          <section class={panel}>
            <p class={meta}>Loading projects…</p>
          </section>
        }
        when={!props.projectInventoriesLoading}
      >
        <SkillsProjects inventories={inventories()} />
      </Show>
      <details class={cx(panel, fold)}>
        <summary class={foldSummary}>
          <span class={strongCell}>Add a project</span>
        </summary>
        <div class={foldBody}>
          <ConfigPanel
            addProjectPath={props.addProjectPath}
            knownProjectPaths={props.knownProjectPaths}
            knownProjectPathsError={props.knownProjectPathsError}
            operationMessage={props.operationMessage}
            pendingOperation={props.pendingOperation}
            projectPathDraft={props.projectPathDraft}
            projectPaths={props.projectPaths}
            removeProjectPath={props.removeProjectPath}
            saveConfig={props.saveConfig}
            setProjectPathDraft={props.setProjectPathDraft}
            setSourceRepoPath={props.setSourceRepoPath}
            sourceRepoPath={props.sourceRepoPath}
          />
        </div>
      </details>
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
                  class={ghostButton}
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
  operationMessage: string | null;
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
        <span class={meta}>{props.snapshot.targets.length} runtimes</span>
      </summary>
      <div class={foldBody}>
        <ConfigPanel
          addProjectPath={props.addProjectPath}
          knownProjectPaths={props.knownProjectPaths}
          knownProjectPathsError={props.knownProjectPathsError}
          operationMessage={props.operationMessage}
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
  operationMessage: string | null;
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
            class={commandButton}
            disabled={props.pendingOperation !== null}
            onClick={props.saveConfig}
            type="button"
          >
            Save
          </button>
        </div>
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
                <span class={helpText}>{props.knownProjectPaths.length} scanned projects available.</span>
              </Show>
            </label>
            <ManualProjectPathField
              addProjectPath={props.addProjectPath}
              projectPathDraft={props.projectPathDraft}
              setProjectPathDraft={props.setProjectPathDraft}
            />
            <button
              class={ghostButton}
              disabled={props.projectPathDraft.trim().length === 0}
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
                    <button class={ghostButton} onClick={() => props.removeProjectPath(projectPath)} type="button">
                      Remove
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
      <Show when={props.operationMessage}>{(message) => <div class={operationPanel}>{message()}</div>}</Show>
    </section>
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
        <p class={panelSub}>{props.snapshot.summary.targetCount} configured runtime targets</p>
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
                class={ghostButton}
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

function UnconfiguredPanel(props: {
  addProjectPath: () => void;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  operationMessage: string | null;
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
      <section class={emptyState}>
        Configure <span class={strongCell}>skills.sourceRepoPath</span> in the ai-usage config to load the local skill
        source repository.
      </section>
      <section class={panel}>
        <ConfigPanel
          addProjectPath={props.addProjectPath}
          knownProjectPaths={props.knownProjectPaths}
          knownProjectPathsError={props.knownProjectPathsError}
          operationMessage={props.operationMessage}
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
