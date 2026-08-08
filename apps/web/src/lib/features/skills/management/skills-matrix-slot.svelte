<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import {
    buildSkillHealthSummary,
    type ReconcilePlanSummary,
    type SkillCellStateFilter,
  } from '../../../../skills-page-model';
  import { skillsMutationOptions, skillsSnapshotKey } from '../../../query/options/skills';
  import { useOptionalWebQueryRpcContext } from '../../../query/rpc-context.svelte';
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
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  let browserClient: SkillsManagementClient | undefined;
  let activeFilter = $state<SkillCellStateFilter | undefined>();
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
    if (injectedClient) {
      return injectedClient;
    }
    if (!rpc) {
      throw new Error('The shared browser RPC context is unavailable.');
    }
    browserClient ??= createSkillsClient(rpc.skills);
    return browserClient;
  };
  const operationMutation = createMutation(() =>
    skillsMutationOptions(
      'management',
      async (variables: { operation: SkillsManagementOperation; pendingLabel: string }) => {
        const result = await runSkillsManagementOperation(resolveClient(), variables.operation);
        if (!result.ok) {
          throw new Error(result.error);
        }
        return { ...result, ...variables };
      },
    ),
  );
  const pendingOperation = $derived(
    operationMutation.isPending ? (operationMutation.variables?.pendingLabel ?? null) : null,
  );
  const operationError = $derived(operationMutation.error instanceof Error ? operationMutation.error.message : null);
  const publish = (snapshot: typeof context.snapshot): void => {
    queryClient.setQueryData(skillsSnapshotKey(), snapshot);
  };
  const execute = async (operation: SkillsManagementOperation, pendingLabel: string): Promise<void> => {
    if (operationMutation.isPending) {
      return;
    }
    managementPlan.clear();
    operationMessage = null;
    try {
      const result = await operationMutation.mutateAsync({ operation, pendingLabel });
      publish(result.snapshot);
      managementPlan.publish(result.plan);
      operationMessage = { message: skillsManagementSuccessMessage(operation, result), tone: 'success' };
    } catch {
      return;
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
  {#if operationError}
    <p class={cx(notice, errorNotice)} role="alert">{operationError}</p>
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
