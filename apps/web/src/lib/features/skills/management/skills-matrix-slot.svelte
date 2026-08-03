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
  import type { SkillsShellSlotContext } from '../shell/slot-context';
  import {
    runSkillsManagementOperation,
    type SkillsManagementClient,
    type SkillsManagementOperation,
    toggleOperation,
  } from './model';
  import SkillsHealth from './skills-health.svelte';
  import SkillsMatrix from './skills-matrix.svelte';
  import { errorNotice, notice, stack } from './styles';

  let { client: injectedClient, context }: { client?: SkillsManagementClient; context: SkillsShellSlotContext } =
    $props();
  const queryClient = useQueryClient();
  let browserClient: SkillsManagementClient | undefined;
  let activeFilter = $state<SkillCellStateFilter | undefined>();
  let pendingOperation = $state<string | null>(null);
  let reconcilePlan = $state<ReconcilePlanSummary | null>(null);
  let operationMessage = $state<{ message: string; tone: 'error' | 'success' } | null>(null);
  const health = $derived(buildSkillHealthSummary(context.snapshot));
  const resolveClient = (): SkillsManagementClient => {
    browserClient ??= injectedClient ?? createSkillsClient(createBrowserWebRpcClient('skills-management').skills);
    return browserClient;
  };
  const successMessage = (operation: SkillsManagementOperation, actionCount: number): string => {
    if (operation === 'preview-reconcile') {
      return 'Reconcile preview refreshed.';
    }
    return actionCount === 0 ? 'Nothing to change.' : 'Skills updated.';
  };
  const publish = (snapshot: typeof context.snapshot): void => {
    queryClient.setQueryData(skillsSnapshotKey(), snapshot);
  };
  const execute = async (operation: SkillsManagementOperation, pendingLabel: string): Promise<void> => {
    if (pendingOperation !== null) {
      return;
    }
    pendingOperation = pendingLabel;
    operationMessage = null;
    try {
      const result = await runSkillsManagementOperation(resolveClient(), operation);
      if (!result.ok) {
        operationMessage = { message: result.error, tone: 'error' };
        return;
      }
      publish(result.snapshot);
      reconcilePlan = result.plan;
      operationMessage = { message: successMessage(operation, result.actions.length), tone: 'success' };
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
      reconcilePlan = null;
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
