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
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import type { ProjectionState, SkillManagementSnapshot } from '@ai-usage/skills';
import { createMemo, createSignal, For, Show } from 'solid-js';
import {
  buildGlobalSkillExposure,
  buildSkillHealthSummary,
  canReconcileAll,
  findGlobalSkill,
  findProjectSkillRow,
  projectionStateLabel,
  type ReconcilePlanSummary,
  type SkillCellStateFilter,
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
  onCellStateFilterChange: (filter: SkillCellStateFilter | undefined) => void;
  onOpenMatrix: () => void;
  onPreviewReconcile: () => void;
  onSelect: (selection: SkillSelection) => void;
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

  return (
    <aside aria-label="Selection actions" class={cx(panel, contextPanel)}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Context</h2>
        <p class={panelSub}>{subtitle()}</p>
      </div>
      <div class={stack}>
        <SourceHealth
          health={health()}
          onCellStateFilterChange={props.onCellStateFilterChange}
          onOpenMatrix={props.onOpenMatrix}
          onSelect={props.onSelect}
        />
        <Show when={props.selection.type === 'global-scope'}>
          <ScopeActions
            canReconcile={canReconcileAll(props.snapshot)}
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
          {(row) => <ProjectSkillActions path={row().observations.at(0)?.path ?? ''} />}
        </Show>
      </div>
    </aside>
  );
};

const SourceHealth = (props: {
  health: ReturnType<typeof buildSkillHealthSummary>;
  onCellStateFilterChange: (filter: SkillCellStateFilter | undefined) => void;
  onOpenMatrix: () => void;
  onSelect: (selection: SkillSelection) => void;
}) => {
  const openFilteredMatrix = (filter: SkillCellStateFilter) => {
    props.onSelect({ type: 'global-scope' });
    props.onCellStateFilterChange(filter);
    props.onOpenMatrix();
  };
  return (
    <section class={stack}>
      <div>
        <div class={strongCell}>Source health</div>
        <div class={meta}>Managed runtime exposure</div>
      </div>
      <div class={metricList}>
        <button class={metricRow} onClick={() => openFilteredMatrix('linked')} type="button">
          <span class={meta}>Healthy links</span>
          <strong>
            {props.health.healthyLinkCount}/{props.health.expectedLinkCount}
          </strong>
        </button>
        <button class={metricRow} onClick={() => openFilteredMatrix('broken')} type="button">
          <span class={meta}>To repair</span>
          <strong>{props.health.toRepairCount}</strong>
        </button>
        <button class={metricRow} onClick={() => openFilteredMatrix('blocked')} type="button">
          <span class={meta}>Blocked</span>
          <strong>{props.health.blockedCount}</strong>
        </button>
        <button
          class={metricRow}
          onClick={() => {
            props.onSelect({ type: 'global-scope' });
          }}
          type="button"
        >
          <span class={meta}>To consolidate</span>
          <strong>{props.health.consolidateCount}</strong>
        </button>
      </div>
    </section>
  );
};

const ScopeActions = (props: {
  canReconcile: boolean;
  onApplyReconcile: () => void;
  onCancelReconcile: () => void;
  onOpenMatrix: () => void;
  onPreviewReconcile: () => void;
  pendingOperation: string | null;
  reconcilePlan: ReconcilePlanSummary | null;
}) => (
  <>
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
    <CopyButton label="Copy project path" value={props.path} />
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
