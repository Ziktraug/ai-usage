<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { useQueryClient } from '@tanstack/svelte-query';
  import {
    buildSkillHealthSummary,
    type ReconcilePlanSummary,
    type SkillCellStateFilter,
  } from '../../../../skills-page-model';
  import { skillsSnapshotKey } from '../../../query/options/skills';
  import { createBrowserWebRpcClient } from '../../../rpc/client';
  import { createSkillsClient } from '../../../rpc/skills-client';
  import type { SkillsManagementPlanController } from '../shell/management-plan-controller';
  import type { SkillsShellSlotContext } from '../shell/slot-context';
  import {
    runSkillsManagementOperation,
    type SkillsManagementClient,
    type SkillsManagementOperation,
    skillsManagementSuccessMessage,
    toggleOperation,
  } from './model';
  import SkillsHealth from './skills-health.svelte';
  import SkillsMatrix from './skills-matrix.svelte';
  import { errorNotice, notice, stack } from './styles';

  let {
    client: injectedClient,
    context,
    managementPlan,
  }: {
    client?: SkillsManagementClient;
    context: SkillsShellSlotContext;
    managementPlan: SkillsManagementPlanController;
  } = $props();
  const queryClient = useQueryClient();
  let browserClient: SkillsManagementClient | undefined;
  let activeFilter = $state<SkillCellStateFilter | undefined>();
  let pendingOperation = $state<string | null>(null);
  let reconcilePlan = $state<ReconcilePlanSummary | null>(null);
  $effect(() => {
    reconcilePlan = managementPlan.getState();
    return managementPlan.subscribe((plan) => {
      reconcilePlan = plan;
    });
  });
  let operationMessage = $state<{ message: string; tone: 'error' | 'success' } | null>(null);
  const health = $derived(buildSkillHealthSummary(context.snapshot));
  const resolveClient = (): SkillsManagementClient => {
    browserClient ??= injectedClient ?? createSkillsClient(createBrowserWebRpcClient('skills-management').skills);
    return browserClient;
  };
  const publish = (snapshot: typeof context.snapshot): void => {
    queryClient.setQueryData(skillsSnapshotKey(), snapshot);
  };
  const execute = async (operation: SkillsManagementOperation, pendingLabel: string): Promise<void> => {
    if (pendingOperation !== null) {
      return;
    }
    pendingOperation = pendingLabel;
    managementPlan.clear();
    operationMessage = null;
    try {
      const result = await runSkillsManagementOperation(resolveClient(), operation);
      if (!result.ok) {
        operationMessage = { message: result.error, tone: 'error' };
        return;
      }
      publish(result.snapshot);
      managementPlan.publish(result.plan);
      operationMessage = { message: skillsManagementSuccessMessage(operation, result), tone: 'success' };
    } catch (error) {
      operationMessage = { message: error instanceof Error ? error.message : 'Skills are unavailable.', tone: 'error' };
    } finally {
      pendingOperation = null;
    }
  };
</script>

<div class={stack} data-skills-management-matrix-slot>
  <SkillsHealth
    {...(activeFilter === undefined ? {} : { activeFilter })}
    onFilterChange={(filter) => {
      activeFilter = activeFilter === filter ? undefined : filter;
    }}
    snapshot={context.snapshot}
    summary={health}
  />
  {#if operationMessage?.tone === 'error'}
    <p class={cx(notice, errorNotice)} role="alert">{operationMessage.message}</p>
  {:else if operationMessage}
    <p aria-live="polite" class={notice} role="status">{operationMessage.message}</p>
  {/if}
  <SkillsMatrix
    {...(activeFilter === undefined ? {} : { activeCellStateFilter: activeFilter })}
    onApplyReconcile={() => execute('reconcile-all', 'reconcile-all')}
    onCancelReconcile={() => {
      managementPlan.clear();
    }}
    onCellStateFilterChange={(filter) => {
      activeFilter = filter;
    }}
    onPreviewReconcile={() => execute('preview-reconcile', 'preview-reconcile')}
    {pendingOperation}
    {reconcilePlan}
    snapshot={context.snapshot}
    toggleSkill={(skillName, enabled) => execute(toggleOperation(skillName, enabled), `toggle:${skillName}`)}
  />
</div>
