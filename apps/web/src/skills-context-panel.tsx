import { css, cx } from '@ai-usage/design-system/css';
import {
  commandButton,
  ghostButton,
  meta,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  statusPill,
  statusPillDanger,
  statusPillInfo,
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import type { ProjectionState, SkillManagementSnapshot } from '@ai-usage/skills';
import { createMemo, For, Show } from 'solid-js';
import {
  buildGlobalSkillExposure,
  buildSkillHealthSummary,
  canReconcileAll,
  findGlobalSkill,
  findProjectSkillRow,
  projectionStateLabel,
  type ReconcilePlanSummary,
  type SkillSelection,
} from './skills-page-model';
import type { ProjectInventoriesResult } from './skills-workspace';

const contextPanel = css({
  alignSelf: 'start',
  position: { base: 'static', xl: 'sticky' },
  top: '16px',
  maxH: { base: 'none', xl: 'calc(100vh - 32px)' },
  overflow: 'auto',
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
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'baseline',
  fontSize: '13px',
});

const issueRow = css({
  display: 'grid',
  gap: '3px',
  p: '8px 0',
  borderTop: '1px solid token(colors.line)',
});

const planList = css({
  display: 'grid',
  gap: '3px',
  m: 0,
  pl: '18px',
  fontFamily: 'mono',
  fontSize: '12px',
  color: 'ink',
  overflowWrap: 'anywhere',
});

const busyButton = css({
  '&[data-pending=true]': {
    _after: {
      content: '" ..."',
      color: 'accent',
    },
  },
});

const unhealthyStates = new Set(['missing', 'broken-link', 'wrong-target', 'missing-target', 'unmanaged-copy']);

const projectionLabelForIssue = (state: string) =>
  projectionStateLabel((state === 'not-applicable' ? 'missing' : state) as ProjectionState);

export const SkillsContextPanel = (props: {
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onOpenMatrix: () => void;
  onPreviewReconcile: () => void;
  pendingOperation: string | null;
  projectInventories: ProjectInventoriesResult | undefined;
  reconcilePlan: ReconcilePlanSummary | null;
  reconcileSkill: (skillName: string) => void;
  selection: SkillSelection;
  snapshot: SkillManagementSnapshot;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) => {
  const health = createMemo(() => buildSkillHealthSummary(props.snapshot));
  const inventories = createMemo(() => (props.projectInventories?.ok ? props.projectInventories.data : []));
  const selectedGlobalSkill = createMemo(() =>
    props.selection.type === 'global-skill' ? findGlobalSkill(props.snapshot, props.selection.skillName) : undefined,
  );
  const selectedProjectSkill = createMemo(() =>
    props.selection.type === 'project-skill'
      ? findProjectSkillRow(inventories(), props.selection.projectPath, props.selection.skillName)
      : undefined,
  );
  const selectedProjectInventory = createMemo(() => {
    const selection = props.selection;
    return selection.type === 'project-scope'
      ? inventories().find((inventory) => inventory.projectPath === selection.projectPath)
      : undefined;
  });
  const exposureIssues = createMemo(() =>
    props.selection.type === 'global-skill'
      ? buildGlobalSkillExposure(props.snapshot, props.selection.skillName).filter((entry) =>
          unhealthyStates.has(entry.state),
        )
      : [],
  );

  return (
    <aside aria-label="Selection actions" class={cx(panel, contextPanel)}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Actions</h2>
        <p class={panelSub}>Context for the current selection</p>
      </div>
      <div class={stack}>
        <Show when={props.selection.type === 'global-scope'}>
          <ScopeActions
            canReconcile={canReconcileAll(props.snapshot)}
            health={health()}
            onApplyReconcile={props.onApplyReconcile}
            onCancelReconcile={props.onCancelReconcile}
            onOpenMatrix={props.onOpenMatrix}
            onPreviewReconcile={props.onPreviewReconcile}
            pendingOperation={props.pendingOperation}
            reconcilePlan={props.reconcilePlan}
          />
        </Show>
        <Show when={selectedGlobalSkill()}>
          {(skill) => (
            <GlobalSkillActions
              exposureIssues={exposureIssues()}
              pendingOperation={props.pendingOperation}
              reconcileSkill={props.reconcileSkill}
              skill={skill()}
              toggleSkill={props.toggleSkill}
            />
          )}
        </Show>
        <Show when={selectedProjectInventory()}>
          {(inventory) => (
            <ProjectActions
              diagnostics={inventory().diagnostics}
              observedCount={inventory().observations.length}
              path={inventory().projectPath}
            />
          )}
        </Show>
        <Show when={selectedProjectSkill()}>
          {(row) => (
            <ProjectSkillActions
              diagnosticsCount={row().observations.reduce(
                (total, observation) => total + observation.diagnostics.length,
                0,
              )}
              observationCount={row().observations.length}
            />
          )}
        </Show>
      </div>
    </aside>
  );
};

const ScopeActions = (props: {
  canReconcile: boolean;
  health: ReturnType<typeof buildSkillHealthSummary>;
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onOpenMatrix: () => void;
  onPreviewReconcile: () => void;
  pendingOperation: string | null;
  reconcilePlan: ReconcilePlanSummary | null;
}) => (
  <>
    <section class={stack}>
      <div class={metricList}>
        <div class={metricRow}>
          <span class={meta}>Healthy links</span>
          <strong>
            {props.health.healthyLinkCount}/{props.health.expectedLinkCount}
          </strong>
        </div>
        <div class={metricRow}>
          <span class={meta}>To repair</span>
          <strong>{props.health.toRepairCount}</strong>
        </div>
        <div class={metricRow}>
          <span class={meta}>Blocked</span>
          <strong>{props.health.blockedCount}</strong>
        </div>
        <div class={metricRow}>
          <span class={meta}>To consolidate</span>
          <strong>{props.health.consolidateCount}</strong>
        </div>
      </div>
    </section>
    <section class={actionGrid}>
      <button class={ghostButton} onClick={props.onOpenMatrix} type="button">
        Exposure matrix
      </button>
      <button
        aria-busy={props.pendingOperation === 'preview-reconcile' ? 'true' : undefined}
        class={cx(ghostButton, busyButton)}
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
            <ul class={planList}>
              <For each={plan().apply}>{(action) => <li>{action}</li>}</For>
            </ul>
          </Show>
          <Show when={plan().skipped.length > 0}>
            <ul class={planList}>
              <For each={plan().skipped}>{(action) => <li>{action}</li>}</For>
            </ul>
          </Show>
          <div class={actionGrid}>
            <button
              aria-busy={props.pendingOperation === 'reconcile-all' ? 'true' : undefined}
              class={cx(commandButton, busyButton)}
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

const GlobalSkillActions = (props: {
  exposureIssues: readonly ReturnType<typeof buildGlobalSkillExposure>[number][];
  pendingOperation: string | null;
  reconcileSkill: (skillName: string) => void;
  skill: NonNullable<ReturnType<typeof findGlobalSkill>>;
  toggleSkill: (skillName: string, enabled: boolean) => void;
}) => {
  const hasReconciliableIssue = () => props.exposureIssues.some((issue) => issue.canReconcile);
  return (
    <>
      <section class={actionGrid}>
        <button
          aria-busy={props.pendingOperation === `toggle:${props.skill.name}` ? 'true' : undefined}
          class={cx(ghostButton, busyButton)}
          data-pending={props.pendingOperation === `toggle:${props.skill.name}` ? 'true' : undefined}
          disabled={props.pendingOperation !== null}
          onClick={() => props.toggleSkill(props.skill.name, !props.skill.enabled)}
          type="button"
        >
          {props.skill.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          aria-busy={props.pendingOperation === `reconcile:${props.skill.name}` ? 'true' : undefined}
          class={cx(commandButton, busyButton)}
          data-pending={props.pendingOperation === `reconcile:${props.skill.name}` ? 'true' : undefined}
          disabled={props.pendingOperation !== null || !hasReconciliableIssue()}
          onClick={() => props.reconcileSkill(props.skill.name)}
          type="button"
        >
          Reconcile
        </button>
      </section>
      <section class={stack}>
        <div class={strongCell}>Issues</div>
        <Show fallback={<p class={meta}>No runtime exposure issues.</p>} when={props.exposureIssues.length > 0}>
          <For each={props.exposureIssues}>
            {(issue) => (
              <div class={issueRow}>
                <span class={cx(statusPill, issue.state === 'missing' ? statusPillWarn : statusPillDanger)}>
                  {projectionLabelForIssue(issue.state)}
                </span>
                <div class={meta}>{issue.expectedPath}</div>
              </div>
            )}
          </For>
        </Show>
      </section>
    </>
  );
};

const ProjectActions = (props: {
  diagnostics: readonly SkillManagementSnapshot['diagnostics'][number][];
  observedCount: number;
  path: string;
}) => (
  <section class={stack}>
    <div class={metricList}>
      <div class={metricRow}>
        <span class={meta}>Observed skills</span>
        <strong>{props.observedCount}</strong>
      </div>
      <div class={metricRow}>
        <span class={meta}>Diagnostics</span>
        <strong>{props.diagnostics.length}</strong>
      </div>
    </div>
    <p class={meta}>{props.path}</p>
    <For each={props.diagnostics}>
      {(diagnostic) => (
        <div class={issueRow}>
          <span class={cx(statusPill, diagnostic.severity === 'error' ? statusPillDanger : statusPillWarn)}>
            {diagnostic.severity}
          </span>
          <div class={meta}>{diagnostic.message}</div>
        </div>
      )}
    </For>
  </section>
);

const ProjectSkillActions = (props: { diagnosticsCount: number; observationCount: number }) => (
  <section class={metricList}>
    <div class={metricRow}>
      <span class={meta}>Runtime observations</span>
      <strong>{props.observationCount}</strong>
    </div>
    <div class={metricRow}>
      <span class={meta}>Diagnostics</span>
      <strong>{props.diagnosticsCount}</strong>
    </div>
    <span class={cx(statusPill, statusPillInfo)}>Read-only</span>
  </section>
);
