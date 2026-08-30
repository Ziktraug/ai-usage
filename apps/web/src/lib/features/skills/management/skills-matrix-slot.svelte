<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import type { SkillCellStateFilter } from '../../../../skills-page-model';
  import SkillObservationsPanel from '../observations/skill-observations.svelte';
  import type { SkillsShellSlotContext } from '../shell/slot-context';
  import {
    previewReconcileOperation,
    reconcileAllOperation,
    type SkillsManagementOperation,
    toggleOperation,
  } from './model';
  import SkillsHealth from './skills-health.svelte';
  import SkillsMatrix from './skills-matrix.svelte';
  import { errorNotice, notice, stack } from './styles';

  let { context }: { context: SkillsShellSlotContext } = $props();
  let activeFilter = $state<SkillCellStateFilter | undefined>();
  const health = $derived(context.presentation.health);
  const pendingOperation = $derived(context.management.pendingOperation);
  const reconcilePlan = $derived(context.management.plan);
  const operationNotice = $derived(context.management.notice?.owner === 'matrix' ? context.management.notice : null);
  const execute = async (operation: SkillsManagementOperation, pendingLabel: string): Promise<void> => {
    if (pendingOperation !== null) {
      return;
    }
    await context.management.execute({ kind: 'management', operation, owner: 'matrix', pendingLabel });
  };
</script>

<div class={stack} data-skills-management-matrix-slot>
  <SkillsHealth
    {...activeFilter === undefined ? {} : { activeFilter }}
    onFilterChange={(filter) => {
      activeFilter = activeFilter === filter ? undefined : filter;
    }}
    snapshot={context.snapshot}
    summary={health}
  />
  {#if operationNotice?.tone === 'error'}
    <p class={cx(notice, errorNotice)} role="alert">{operationNotice.message}</p>
  {:else if operationNotice}
    <p aria-live="polite" class={notice} role="status">
      {operationNotice.message}
    </p>
  {/if}
  <SkillsMatrix
    {...activeFilter === undefined
      ? {}
      : { activeCellStateFilter: activeFilter }}
    onApplyReconcile={() => execute(reconcileAllOperation, "reconcile-all")}
    onCancelReconcile={() => {
      context.management.clearPlan();
    }}
    onCellStateFilterChange={(filter) => {
      activeFilter = filter;
    }}
    onPreviewReconcile={() =>
      execute(previewReconcileOperation, "preview-reconcile")}
    {pendingOperation}
    {reconcilePlan}
    snapshot={context.snapshot}
    toggleSkill={(skillName, enabled) =>
      execute(toggleOperation(skillName, enabled), `toggle:${skillName}`)}
  />
  <SkillObservationsPanel observationPresentation={context.presentation.observations} variant="overview" />
</div>
