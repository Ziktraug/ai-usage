import { css } from '@ai-usage/design-system/css';
import {
  commandButton,
  dateCell,
  ghostButton,
  header,
  headerActions,
  headerTop,
  meta,
  muted,
  navButton,
  page,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  shell,
  strongCell,
  summaryPill,
  table,
  tableWrap,
  title,
  titleBlock,
} from '@ai-usage/design-system/report';
import type { SkillManagementConfig, SkillManagementSnapshot } from '@ai-usage/skills';
import { createFileRoute, Link } from '@tanstack/solid-router';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { dashboardSearchDefaultsFor } from '../dashboard-search';
import { ThemeToggle } from '../dashboard-theme';
import {
  createManagedSkillTargetDirectory,
  getKnownSkillProjectPaths,
  getSkillManagementSnapshot,
  type KnownSkillProjectPath,
  reconcileAllManagedSkills,
  reconcileManagedSkill,
  saveSkillManagementConfig,
  toggleManagedSkill,
} from '../server/skills';
import {
  buildSkillSummaryTiles,
  canReconcileAllActiveSkills,
  canReconcileSkill,
  projectionStateLabel,
  skillProjectionSummary,
} from '../skills-page-model';

export const Route = createFileRoute('/skills')({
  loader: async () => ({
    knownProjectPaths: await getKnownSkillProjectPaths(),
    skills: await getSkillManagementSnapshot(),
  }),
  component: SkillsRoute,
});

const pageStack = css({
  display: 'grid',
  gap: '16px',
});

const dashboardSearchDefaults = dashboardSearchDefaultsFor('date');

type SkillSnapshotResult =
  | { ok: true; data: SkillManagementSnapshot }
  | {
      ok: false;
      error: {
        message: string;
        tag: string;
      };
    };

type KnownProjectPathsResult =
  | { ok: true; data: readonly KnownSkillProjectPath[] }
  | {
      ok: false;
      error: {
        message: string;
        tag: string;
      };
    };

interface SkillReconcileResult {
  actions: readonly { type: string }[];
  snapshot: SkillManagementSnapshot;
}

type SkillReconcileServerResult =
  | { ok: true; data: SkillReconcileResult }
  | {
      ok: false;
      error: {
        message: string;
        tag: string;
      };
    };

const skillSnapshotResultFrom = (value: unknown): SkillSnapshotResult => {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return { ok: false, error: { message: 'Invalid skills snapshot response', tag: 'InvalidResponse' } };
  }
  return value as SkillSnapshotResult;
};

const summaryGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'repeat(5, minmax(0, 1fr))' },
  gap: '12px',
});

const sectionGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', xl: 'minmax(0, 1.15fr) minmax(320px, 0.85fr)' },
  gap: '16px',
  alignItems: 'start',
});

const stack = css({
  display: 'grid',
  gap: '12px',
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

const tableCompact = css({
  minW: '760px',
});

const statusText = css({
  display: 'inline-flex',
  alignItems: 'center',
  h: '22px',
  px: '8px',
  borderRadius: 'full',
  border: '1px solid token(colors.line)',
  bg: 'surface',
  fontSize: '11px',
  fontWeight: 650,
});

const actionRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
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
  const snapshot = createMemo(() => {
    const current = result();
    return current.ok ? current.data : undefined;
  });
  const errorMessage = createMemo(() => {
    const current = result();
    return current.ok ? '' : current.error.message;
  });
  const summaryTiles = createMemo(() => (snapshot() ? buildSkillSummaryTiles(snapshot()!) : []));
  const [sourceRepoPath, setSourceRepoPath] = createSignal(snapshot()?.config.sourceRepoPath ?? '');
  const [projectPaths, setProjectPaths] = createSignal<readonly string[]>(snapshot()?.config.projectPaths ?? []);
  const [projectPathDraft, setProjectPathDraft] = createSignal('');

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
    const actionSummary = next.data.actions.length
      ? next.data.actions.map((action) => action.type).join(', ')
      : 'no changes';
    setOperationMessage(`${fallbackMessage}: ${actionSummary}.`);
  };

  const runOperation = async (operation: string, action: () => Promise<void>) => {
    if (pendingOperation()) {
      return;
    }
    setPendingOperation(operation);
    setOperationMessage(null);
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
      applySnapshotResult(await saveSkillManagementConfig({ data: configInput() }), 'Skill config saved.');
    });

  const toggleSkill = (skillName: string, enabled: boolean) =>
    runOperation(`toggle:${skillName}`, async () => {
      applyReconcileResult(
        await toggleManagedSkill({ data: { enabled, skillName } }),
        enabled ? `Enabled ${skillName}` : `Disabled ${skillName}`,
      );
    });

  const reconcileSkill = (skillName: string) =>
    runOperation(`reconcile:${skillName}`, async () => {
      applyReconcileResult(await reconcileManagedSkill({ data: skillName }), `Reconciled ${skillName}`);
    });

  const reconcileAll = () =>
    runOperation('reconcile-all', async () => {
      applyReconcileResult(await reconcileAllManagedSkills(), 'Reconciled active skills');
    });

  const createTargetDirectory = (targetId: string) =>
    runOperation(`target:${targetId}`, async () => {
      applySnapshotResult(
        await createManagedSkillTargetDirectory({ data: { targetId } }),
        `Created target directory ${targetId}.`,
      );
    });

  return (
    <main class={page}>
      <div class={shell}>
        <header class={header}>
          <div class={headerTop}>
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
              when={snapshot()}
            >
              {(loadedSnapshot) => (
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
                  when={loadedSnapshot().configured}
                >
                  <ConfiguredSnapshot
                    addProjectPath={addProjectPath}
                    createTargetDirectory={createTargetDirectory}
                    knownProjectPaths={knownProjectPaths()}
                    knownProjectPathsError={knownProjectPathsError()}
                    operationMessage={operationMessage()}
                    pendingOperation={pendingOperation()}
                    projectPathDraft={projectPathDraft()}
                    projectPaths={projectPaths()}
                    reconcileAll={reconcileAll}
                    reconcileSkill={reconcileSkill}
                    removeProjectPath={removeProjectPath}
                    saveConfig={saveConfig}
                    setProjectPathDraft={setProjectPathDraft}
                    setSourceRepoPath={setSourceRepoPath}
                    snapshot={loadedSnapshot()}
                    sourceRepoPath={sourceRepoPath()}
                    summaryTiles={summaryTiles()}
                    toggleSkill={toggleSkill}
                  />
                </Show>
              )}
            </Show>
          </Show>
        </div>
      </div>
    </main>
  );
}

function ConfiguredSnapshot(props: {
  addProjectPath: () => void;
  createTargetDirectory: (targetId: string) => void;
  knownProjectPaths: readonly KnownSkillProjectPath[];
  knownProjectPathsError: string | null;
  operationMessage: string | null;
  pendingOperation: string | null;
  projectPathDraft: string;
  projectPaths: readonly string[];
  reconcileAll: () => void;
  reconcileSkill: (skillName: string) => void;
  removeProjectPath: (value: string) => void;
  saveConfig: () => void;
  setProjectPathDraft: (value: string) => void;
  setSourceRepoPath: (value: string) => void;
  snapshot: SkillManagementSnapshot;
  sourceRepoPath: string;
  summaryTiles: readonly ReturnType<typeof buildSkillSummaryTiles>[number][];
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) {
  return (
    <>
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
      <section class={summaryGrid}>
        <For each={props.summaryTiles}>
          {(tile) => (
            <div class={panel}>
              <div class={panelHeader}>
                <div class={panelSub}>{tile.label}</div>
                <div class={panelTitle}>{tile.value}</div>
              </div>
            </div>
          )}
        </For>
      </section>

      <section class={sectionGrid}>
        <div class={stack}>
          <SkillsTable
            pendingOperation={props.pendingOperation}
            reconcileSkill={props.reconcileSkill}
            snapshot={props.snapshot}
            toggleSkill={props.toggleSkill}
          />
          <UnmanagedTable snapshot={props.snapshot} />
        </div>
        <div class={stack}>
          <ActionsPanel
            pendingOperation={props.pendingOperation}
            reconcileAll={props.reconcileAll}
            snapshot={props.snapshot}
          />
          <TargetsTable
            createTargetDirectory={props.createTargetDirectory}
            pendingOperation={props.pendingOperation}
            snapshot={props.snapshot}
          />
          <DiagnosticsPanel snapshot={props.snapshot} />
          <NativeRulesPanel snapshot={props.snapshot} />
        </div>
      </section>
    </>
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
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Configuration</h2>
        <p class={panelSub}>User-local settings in the ai-usage config file.</p>
      </div>
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
            <p class={panelSub}>
              Optional local projects for rule diagnostics. Pick from projects already present in the report, or add a
              path manually.
            </p>
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
  );
}

function SkillsTable(props: {
  pendingOperation: string | null;
  reconcileSkill: (skillName: string) => void;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) {
  return (
    <section>
      <div class={tableWrap}>
        <table class={`${table} ${tableCompact}`}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Enabled</th>
              <th>Tokens</th>
              <th>Validation</th>
              <th>Targets</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.snapshot.skills}>
              {(skill) => (
                <tr>
                  <td class={strongCell}>{skill.name}</td>
                  <td>{skill.description || <span class={muted}>No description</span>}</td>
                  <td>{skill.enabled ? 'Enabled' : 'Disabled'}</td>
                  <td class={dateCell}>{skill.tokenCount?.total ?? 0} approx</td>
                  <td>
                    <span class={statusText}>{skill.validationStatus}</span>
                  </td>
                  <td>{skillProjectionSummary(skill, props.snapshot.projections)}</td>
                  <td>
                    <div class={actionRow}>
                      <button
                        class={ghostButton}
                        disabled={props.pendingOperation !== null}
                        onClick={() => props.toggleSkill(skill.name, !skill.enabled)}
                        type="button"
                      >
                        {skill.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        class={ghostButton}
                        disabled={props.pendingOperation !== null || !canReconcileSkill(skill, props.snapshot)}
                        onClick={() => props.reconcileSkill(skill.name)}
                        type="button"
                      >
                        Reconcile
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ActionsPanel(props: {
  pendingOperation: string | null;
  reconcileAll: () => void;
  snapshot: SkillManagementSnapshot;
}) {
  const canReconcile = createMemo(() => canReconcileAllActiveSkills(props.snapshot));
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Reconcile</h2>
        <p class={panelSub}>Apply safe symlink actions for valid active skills.</p>
      </div>
      <div class={actionRow}>
        <button
          class={commandButton}
          disabled={props.pendingOperation !== null || !canReconcile()}
          onClick={props.reconcileAll}
          type="button"
        >
          Reconcile all
        </button>
      </div>
      <Show when={!canReconcile()}>
        <p class={meta}>Reconcile all is disabled while unmanaged target content needs review.</p>
      </Show>
    </section>
  );
}

function TargetsTable(props: {
  createTargetDirectory: (targetId: string) => void;
  pendingOperation: string | null;
  snapshot: SkillManagementSnapshot;
}) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Targets</h2>
        <p class={panelSub}>{props.snapshot.summary.targetCount} configured runtime targets</p>
      </div>
      <div class={stack}>
        <For each={props.snapshot.targets}>
          {(target) => (
            <div>
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
      </div>
    </section>
  );
}

function UnmanagedTable(props: { snapshot: SkillManagementSnapshot }) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Unmanaged target entries</h2>
        <p class={panelSub}>{props.snapshot.summary.unmanagedEntryCount} entries outside managed source skills</p>
      </div>
      <Show
        fallback={<p class={meta}>No unmanaged target entries.</p>}
        when={props.snapshot.unmanagedEntries.length > 0}
      >
        <div class={stack}>
          <For each={props.snapshot.unmanagedEntries}>
            {(entry) => (
              <div>
                <span class={summaryPill}>{projectionStateLabel(entry.state)}</span>
                <div class={meta}>{entry.expectedPath}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function DiagnosticsPanel(props: { snapshot: SkillManagementSnapshot }) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Diagnostics</h2>
        <p class={panelSub}>{props.snapshot.summary.diagnosticCount} findings</p>
      </div>
      <Show fallback={<p class={meta}>No diagnostics.</p>} when={props.snapshot.diagnostics.length > 0}>
        <div class={stack}>
          <For each={props.snapshot.diagnostics}>
            {(diagnostic) => (
              <div>
                <span class={summaryPill}>{diagnostic.severity}</span>
                <div class={strongCell}>{diagnostic.code}</div>
                <div class={meta}>{diagnostic.message}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function NativeRulesPanel(props: { snapshot: SkillManagementSnapshot }) {
  return (
    <section class={panel}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Native rules</h2>
        <p class={panelSub}>Read-only diagnostics will appear here for configured local projects.</p>
      </div>
      <Show
        fallback={<p class={meta}>No manual project paths.</p>}
        when={(props.snapshot.config.projectPaths?.length ?? 0) > 0}
      >
        <div class={projectPathList}>
          <For each={props.snapshot.config.projectPaths}>{(projectPath) => <div class={meta}>{projectPath}</div>}</For>
        </div>
      </Show>
    </section>
  );
}
