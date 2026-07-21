import { css, cx } from '@ai-usage/design-system/css';
import {
  commandButton,
  ghostButton,
  meta,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  pendingButton,
  skillsDiagnosticRow,
  skillsReconcilePlanList,
  statusPill,
  statusPillDanger,
  statusPillInfo,
  statusPillOk,
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import type { SkillDiagnosticSeverity, SkillManagementSnapshot, SkillValidationStatus } from '@ai-usage/skills';
import { useNavigate } from '@tanstack/solid-router';
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { deriveInstallationAction, groupSkillDiagnostics } from './skill-document-inspector-model';
import {
  buildGlobalSkillExposure,
  buildSkillHealthSummary,
  canReconcileAll,
  findGlobalSkill,
  findProjectSkillRow,
  type KnownProjectScope,
  projectSourcePathsForScope,
  type ReconcilePlanSummary,
  type SkillCellStateFilter,
  type SkillSelection,
  skillInvocation,
} from './skills-page-model';
import { SKILLS_DESKTOP_MEDIA_QUERY } from './skills-responsive';
import type { ProjectInventoriesResult } from './skills-workspace';

const contextPanel = css({
  alignSelf: 'start',
  position: { base: 'static', xl: 'sticky' },
  top: '16px',
});

const stack = css({
  display: 'grid',
  gap: '12px',
});

const actionGrid = css({
  display: 'grid',
  gap: '8px',
});

const metricList = css({
  display: 'grid',
  gap: '6px',
});

const metricRow = css({
  appearance: 'none',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'baseline',
  border: '1px solid transparent',
  borderRadius: 'sm',
  bg: 'transparent',
  color: 'ink',
  fontSize: '13px',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: {
    bg: 'surfaceMuted',
    borderColor: 'line',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const metricStaticRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'baseline',
  fontSize: '13px',
});

const inspectorSection = css({
  display: 'grid',
  gap: '8px',
  pt: '12px',
  borderTop: '1px solid token(colors.line)',
});

const inspectorSummary = css({
  cursor: 'pointer',
});

const inspectorHeading = css({
  fontSize: '13px',
  fontWeight: 700,
});

const sourceRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'center',
});

const sourceValue = css({
  display: 'block',
  minW: 0,
  overflow: 'hidden',
  color: 'muted',
  fontFamily: 'mono',
  fontSize: '11px',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const runtimeDisclosure = css({
  borderTop: '1px solid token(colors.line)',
  _first: {
    borderTop: '0',
  },
});

const runtimeSummary = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'center',
  py: '8px',
  cursor: 'pointer',
});

const runtimePaths = css({
  display: 'grid',
  gap: '4px',
  pb: '8px',
  color: 'muted',
  fontFamily: 'mono',
  fontSize: '11px',
  overflowWrap: 'anywhere',
});

const diagnosticHeading = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  alignItems: 'center',
});

export const SkillsContextPanel = (props: {
  matrixOpen: boolean;
  knownProjects: readonly KnownProjectScope[];
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onCellStateFilterChange: (filter: SkillCellStateFilter | undefined) => void;
  onPreviewReconcile: () => void;
  pendingOperation: string | null;
  projectInventories: ProjectInventoriesResult | undefined;
  reconcilePlan: ReconcilePlanSummary | null;
  reconcileSkill: (skillName: string) => void;
  selection: SkillSelection;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) => {
  const navigate = useNavigate();
  const [inspectorSectionsOpen, setInspectorSectionsOpen] = createSignal(false);
  onMount(() => {
    const desktopMedia = window.matchMedia(SKILLS_DESKTOP_MEDIA_QUERY);
    const syncInspectorSections = (): void => {
      setInspectorSectionsOpen(desktopMedia.matches);
    };
    syncInspectorSections();
    desktopMedia.addEventListener('change', syncInspectorSections);
    onCleanup(() => desktopMedia.removeEventListener('change', syncInspectorSections));
  });
  // Selection changes go through the router so the URL, the tree highlight,
  // and the detail pane can never disagree.
  const openFilteredMatrix = (filter: SkillCellStateFilter) => {
    props.onCellStateFilterChange(filter);
    navigate({ to: '/skills/matrix' });
  };
  const toggleMatrix = () => {
    navigate({ to: props.matrixOpen ? '/skills/global' : '/skills/matrix' });
  };
  const openOverview = () => {
    navigate({ to: '/skills/global' });
  };
  const health = createMemo(() => buildSkillHealthSummary(props.snapshot));
  const inventories = createMemo(() => (props.projectInventories?.ok ? props.projectInventories.data : []));
  const selectedGlobalSkill = createMemo(() =>
    props.selection.type === 'global-skill' ? findGlobalSkill(props.snapshot, props.selection.skillName) : undefined,
  );
  const selectedProjectSkill = createMemo(() =>
    props.selection.type === 'project-skill'
      ? findProjectSkillRow(inventories(), props.selection.projectPath, props.selection.skillName, props.knownProjects)
      : undefined,
  );
  const selectedProjectInventories = createMemo(() => {
    const selection = props.selection;
    if (selection.type !== 'project-scope') {
      return [];
    }
    const sourcePaths = new Set(projectSourcePathsForScope(selection.projectPath, props.knownProjects));
    return inventories().filter((inventory) => sourcePaths.has(inventory.projectPath));
  });
  const selectedProjectSourcePaths = createMemo(() =>
    props.selection.type === 'project-scope'
      ? projectSourcePathsForScope(props.selection.projectPath, props.knownProjects)
      : [],
  );
  const selectedGlobalExposure = createMemo(() =>
    props.selection.type === 'global-skill' ? buildGlobalSkillExposure(props.snapshot, props.selection.skillName) : [],
  );
  const isGlobalSkill = createMemo(() => props.selection.type === 'global-skill');
  const subtitle = createMemo(() => {
    if (props.selection.type === 'global-scope') {
      return 'Global source';
    }
    if (props.selection.type === 'global-skill') {
      return 'Global skill';
    }
    if (props.selection.type === 'project-scope') {
      return 'Project scope';
    }
    return 'Project skill - read-only';
  });
  const reviewInstallation = (): void => {
    props.onPreviewReconcile();
    navigate({ to: '/skills/matrix' });
  };

  return (
    <aside aria-label={isGlobalSkill() ? 'Inspector' : 'Selection actions'} class={cx(panel, contextPanel)}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>{isGlobalSkill() ? 'Inspector' : 'Context'}</h2>
        <p class={panelSub}>{subtitle()}</p>
      </div>
      <div class={stack}>
        <Show when={!isGlobalSkill()}>
          <SourceHealth health={health()} onOpenFilteredMatrix={openFilteredMatrix} onOpenOverview={openOverview} />
        </Show>
        <Show when={props.selection.type === 'global-scope'}>
          <ScopeActions
            canReconcile={canReconcileAll(props.snapshot)}
            matrixOpen={props.matrixOpen}
            onApplyReconcile={props.onApplyReconcile}
            onCancelReconcile={props.onCancelReconcile}
            onPreviewReconcile={props.onPreviewReconcile}
            onToggleMatrix={toggleMatrix}
            pendingOperation={props.pendingOperation}
            reconcilePlan={props.reconcilePlan}
          />
        </Show>
        <Show when={selectedGlobalSkill()}>
          {(skill) => (
            <GlobalSkillInspector
              exposure={selectedGlobalExposure()}
              onReviewInstallation={reviewInstallation}
              pendingOperation={props.pendingOperation}
              reconcileSkill={props.reconcileSkill}
              sectionsOpen={inspectorSectionsOpen()}
              skill={skill()}
              snapshot={props.snapshot}
              toggleSkill={props.toggleSkill}
            />
          )}
        </Show>
        <Show when={props.selection.type === 'project-scope'}>
          <Show when={selectedProjectInventories()}>
            {(inventories) => (
              <ProjectActions
                diagnostics={inventories().flatMap((inventory) => inventory.diagnostics)}
                observedCount={inventories().reduce((total, inventory) => total + inventory.observations.length, 0)}
                paths={selectedProjectSourcePaths()}
              />
            )}
          </Show>
        </Show>
        <Show when={selectedProjectSkill()}>
          {(row) => <ProjectSkillActions path={row().observations.at(0)?.path ?? ''} />}
        </Show>
      </div>
    </aside>
  );
};

const SourceHealth = (props: {
  health: ReturnType<typeof buildSkillHealthSummary>;
  onOpenFilteredMatrix: (filter: SkillCellStateFilter) => void;
  onOpenOverview: () => void;
}) => (
  <section class={stack}>
    <div>
      <div class={strongCell}>Source health</div>
      <div class={meta}>Managed runtime exposure</div>
    </div>
    <div class={metricList}>
      <button class={metricRow} onClick={() => props.onOpenFilteredMatrix('linked')} type="button">
        <span class={meta}>Healthy links</span>
        <strong>
          {props.health.healthyLinkCount}/{props.health.expectedLinkCount}
        </strong>
      </button>
      <button class={metricRow} onClick={() => props.onOpenFilteredMatrix('broken')} type="button">
        <span class={meta}>To repair</span>
        <strong>{props.health.toRepairCount}</strong>
      </button>
      <button class={metricRow} onClick={() => props.onOpenFilteredMatrix('blocked')} type="button">
        <span class={meta}>Blocked</span>
        <strong>{props.health.blockedCount}</strong>
      </button>
      <button class={metricRow} onClick={() => props.onOpenOverview()} type="button">
        <span class={meta}>To consolidate</span>
        <strong>{props.health.consolidateCount}</strong>
      </button>
    </div>
  </section>
);

const ScopeActions = (props: {
  canReconcile: boolean;
  matrixOpen: boolean;
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onPreviewReconcile: () => void;
  onToggleMatrix: () => void;
  pendingOperation: string | null;
  reconcilePlan: ReconcilePlanSummary | null;
}) => (
  <>
    <section class={actionGrid}>
      <button class={ghostButton} onClick={props.onToggleMatrix} type="button">
        {props.matrixOpen ? 'Close matrix' : 'Exposure matrix'}
      </button>
      <button
        aria-busy={props.pendingOperation === 'preview-reconcile' ? 'true' : undefined}
        class={cx(ghostButton, pendingButton)}
        data-pending={props.pendingOperation === 'preview-reconcile' ? 'true' : undefined}
        disabled={props.pendingOperation !== null || !props.canReconcile}
        onClick={props.onPreviewReconcile}
        type="button"
      >
        Preview reconcile
      </button>
    </section>
    <Show when={props.reconcilePlan}>
      {(plan) => (
        <section class={stack}>
          <div>
            <div class={strongCell}>Reconcile preview</div>
            <div class={meta}>{plan().apply.length} changes ready</div>
          </div>
          <Show when={plan().apply.length > 0}>
            <ul class={skillsReconcilePlanList}>
              <For each={plan().apply}>{(action) => <li>{action}</li>}</For>
            </ul>
          </Show>
          <Show when={plan().skipped.length > 0}>
            <ul class={skillsReconcilePlanList}>
              <For each={plan().skipped}>{(action) => <li>{action}</li>}</For>
            </ul>
          </Show>
          <div class={actionGrid}>
            <button
              aria-busy={props.pendingOperation === 'reconcile-all' ? 'true' : undefined}
              class={cx(commandButton, pendingButton)}
              data-pending={props.pendingOperation === 'reconcile-all' ? 'true' : undefined}
              disabled={props.pendingOperation !== null || plan().apply.length === 0}
              onClick={props.onApplyReconcile}
              type="button"
            >
              Apply
            </button>
            <button
              class={ghostButton}
              disabled={props.pendingOperation !== null}
              onClick={props.onCancelReconcile}
              type="button"
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </Show>
  </>
);

type GlobalSkillExposure = ReturnType<typeof buildGlobalSkillExposure>[number];

const validationTones = {
  invalid: statusPillDanger,
  valid: statusPillOk,
  warning: statusPillWarn,
} satisfies Record<SkillValidationStatus, string>;

const diagnosticTones = {
  error: statusPillDanger,
  info: statusPillInfo,
  warning: statusPillWarn,
} satisfies Record<SkillDiagnosticSeverity, string>;

const exposureTones = {
  'broken-link': statusPillDanger,
  'disabled-exposed': statusPillDanger,
  'duplicate-name-conflict': statusPillDanger,
  'duplicate-same-content': statusPillDanger,
  linked: statusPillOk,
  missing: statusPillWarn,
  'missing-target': statusPillDanger,
  'not-applicable': statusPillDanger,
  'unmanaged-copy': statusPillDanger,
  'unmanaged-symlink': statusPillDanger,
  'wrong-target': statusPillDanger,
} satisfies Record<GlobalSkillExposure['state'], string>;

const GlobalSkillInspector = (props: {
  exposure: readonly GlobalSkillExposure[];
  onReviewInstallation: () => void;
  pendingOperation: string | null;
  reconcileSkill: (skillName: string) => void;
  sectionsOpen: boolean;
  skill: NonNullable<ReturnType<typeof findGlobalSkill>>;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) => {
  const diagnostics = createMemo(() => groupSkillDiagnostics(props.skill.diagnostics));
  const installationAction = createMemo(() => deriveInstallationAction(props.skill, props.exposure));
  const installationOperation = createMemo(() =>
    installationAction().mode === 'preview' ? 'preview-reconcile' : `reconcile:${props.skill.name}`,
  );
  const runInstallationAction = (): void => {
    if (installationAction().mode === 'preview') {
      props.onReviewInstallation();
      return;
    }
    if (installationAction().mode === 'direct') {
      props.reconcileSkill(props.skill.name);
    }
  };

  return (
    <>
      <details class={inspectorSection} open={props.sectionsOpen}>
        <summary class={inspectorSummary}>
          <h3 class={inspectorHeading}>Validation</h3>
        </summary>
        <div>
          <span class={cx(statusPill, validationTones[props.skill.validationStatus])}>
            {props.skill.validationStatus}
          </span>
        </div>
        <Show fallback={<p class={meta}>No validation diagnostics.</p>} when={diagnostics().length > 0}>
          <For each={diagnostics()}>
            {(diagnostic) => (
              <div class={skillsDiagnosticRow}>
                <div class={diagnosticHeading}>
                  <span class={cx(statusPill, diagnosticTones[diagnostic.severity])}>{diagnostic.severity}</span>
                  <span class={strongCell}>{diagnostic.code}</span>
                  <Show when={diagnostic.count > 1}>
                    <span class={meta}>{diagnostic.count} occurrences</span>
                  </Show>
                </div>
                <p class={meta}>{diagnostic.message}</p>
                <Show when={diagnostic.paths.length > 0}>
                  <details>
                    <summary class={meta}>Related paths</summary>
                    <For each={diagnostic.paths}>
                      {(path) => (
                        <code class={sourceValue} title={path}>
                          {path}
                        </code>
                      )}
                    </For>
                  </details>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </details>

      <details class={inspectorSection} open={props.sectionsOpen}>
        <summary class={inspectorSummary}>
          <h3 class={inspectorHeading}>Document</h3>
        </summary>
        <div class={metricList}>
          <div class={metricStaticRow}>
            <span class={meta}>Total tokens</span>
            <strong>{props.skill.tokenCount?.total ?? 'Unknown'}</strong>
          </div>
          <Show when={props.skill.tokenCount}>
            {(tokens) => (
              <div class={metricStaticRow}>
                <span class={meta}>SKILL.md tokens</span>
                <strong>{tokens().skillMd}</strong>
              </div>
            )}
          </Show>
          <div class={metricStaticRow}>
            <span class={meta}>Invocation</span>
            <strong>{skillInvocation(props.skill) === 'auto' ? 'Auto' : 'Manual'}</strong>
          </div>
          <div class={metricStaticRow}>
            <span class={meta}>State</span>
            <strong>{props.skill.enabled ? 'Enabled' : 'Disabled'}</strong>
          </div>
        </div>
      </details>

      <details class={inspectorSection} open={props.sectionsOpen}>
        <summary class={inspectorSummary}>
          <h3 class={inspectorHeading}>Source</h3>
        </summary>
        <div class={sourceRow}>
          <div>
            <div class={meta}>Source path</div>
            <code class={sourceValue} title={props.skill.path}>
              {props.skill.path}
            </code>
          </div>
          <CopyButton label="Copy source path" value={props.skill.path} />
        </div>
        <div class={sourceRow}>
          <div>
            <div class={meta}>SKILL.md</div>
            <code class={sourceValue} title={props.skill.skillMdPath}>
              {props.skill.skillMdPath}
            </code>
          </div>
          <CopyButton label="Copy SKILL.md path" value={props.skill.skillMdPath} />
        </div>
      </details>

      <details class={inspectorSection} open={props.sectionsOpen}>
        <summary class={inspectorSummary}>
          <h3 class={inspectorHeading}>Installed in</h3>
        </summary>
        <Show fallback={<p class={meta}>No enabled runtimes.</p>} when={props.exposure.length > 0}>
          <For each={props.exposure}>
            {(entry) => {
              const target = () => props.snapshot.targets.find((candidate) => candidate.id === entry.targetId);
              return (
                <details class={runtimeDisclosure}>
                  <summary class={runtimeSummary}>
                    <span class={strongCell}>{target()?.label ?? entry.targetId}</span>
                    <span class={cx(statusPill, exposureTones[entry.state])}>{entry.label}</span>
                  </summary>
                  <div class={runtimePaths}>
                    <div>Expected: {entry.expectedPath}</div>
                    <Show when={entry.actualPath}>{(actualPath) => <div>Actual: {actualPath()}</div>}</Show>
                  </div>
                </details>
              );
            }}
          </For>
        </Show>
      </details>

      <details class={inspectorSection} open={props.sectionsOpen}>
        <summary class={inspectorSummary}>
          <h3 class={inspectorHeading}>Actions</h3>
        </summary>
        <div class={actionGrid}>
          <button
            aria-busy={props.pendingOperation === `toggle:${props.skill.name}` ? 'true' : undefined}
            class={cx(ghostButton, pendingButton)}
            data-pending={props.pendingOperation === `toggle:${props.skill.name}` ? 'true' : undefined}
            disabled={props.pendingOperation !== null}
            onClick={() => props.toggleSkill(props.skill.name, !props.skill.enabled)}
            type="button"
          >
            {props.skill.enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            aria-busy={props.pendingOperation === installationOperation() ? 'true' : undefined}
            class={cx(commandButton, pendingButton)}
            data-pending={props.pendingOperation === installationOperation() ? 'true' : undefined}
            disabled={props.pendingOperation !== null || installationAction().mode === 'none'}
            onClick={runInstallationAction}
            type="button"
          >
            {installationAction().label}
          </button>
        </div>
      </details>
    </>
  );
};

const ProjectActions = (props: {
  diagnostics: readonly SkillManagementSnapshot['diagnostics'][number][];
  observedCount: number;
  paths: readonly string[];
}) => (
  <section class={stack}>
    <Show when={props.paths.length === 1}>
      <CopyButton label="Copy project path" value={props.paths[0] ?? ''} />
    </Show>
    <div class={metricList}>
      <div class={metricStaticRow}>
        <span class={meta}>Observed skills</span>
        <strong>{props.observedCount}</strong>
      </div>
      <div class={metricStaticRow}>
        <span class={meta}>Diagnostics</span>
        <strong>{props.diagnostics.length}</strong>
      </div>
    </div>
    <For each={props.diagnostics}>
      {(diagnostic) => (
        <div class={skillsDiagnosticRow}>
          <span class={cx(statusPill, diagnostic.severity === 'error' ? statusPillDanger : statusPillWarn)}>
            {diagnostic.severity}
          </span>
          <div class={meta}>{diagnostic.message}</div>
        </div>
      )}
    </For>
  </section>
);

const ProjectSkillActions = (props: { path: string }) => (
  <section class={stack}>
    <CopyButton label="Copy skill path" value={props.path} />
    <p class={meta}>Read-only - adopt-into-source arrives in a later plan.</p>
  </section>
);

const CopyButton = (props: { label: string; value: string }) => {
  const [copied, setCopied] = createSignal(false);
  const copyValue = async () => {
    if (!props.value) {
      return;
    }
    await navigator.clipboard?.writeText(props.value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button class={ghostButton} disabled={!props.value} onClick={copyValue} type="button">
      {copied() ? 'Copied' : props.label}
    </button>
  );
};
