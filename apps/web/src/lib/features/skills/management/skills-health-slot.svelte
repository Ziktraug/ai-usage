<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { skillsReconcilePlanList } from '@ai-usage/design-system/report';
  import {
    banner,
    bannerError,
    bannerOk,
    commandButton,
    ghostButton,
    meta,
    muted,
    pendingButton,
    strongCell,
  } from '@ai-usage/design-system/svelte';
  import { onDestroy, onMount } from 'svelte';
  import { canReconcileAll } from '../../../../skills-page-model';
  import type { SkillsShellSlotContext } from '../shell/slot-context';
  import {
    previewReconcileOperation,
    reconcileAllOperation,
    resolveSkillsRefreshAcceptance,
    type SkillsManagementOperation,
    type SkillsRefreshAcceptanceTarget,
    type SkillsRefreshDecisionState,
    skillsSnapshotAcceptanceSignature,
  } from './model';
  import { operationNotice, passiveOperationNotice, stack } from './styles';

  /**
   * The worktable's operation host.
   *
   * It renders no facts: the table carries those now (plan 113). What lives here is the pair of
   * page-level operations — refresh the snapshot, reconcile the links — plus the reconcile plan
   * that must be read before anything is written, and the notice every operation reports through.
   * The page header owns the two buttons, so both actions are registered outward rather than drawn.
   */
  let {
    context,
    onReconcileReady,
    onRefreshFocus,
    onRefreshPendingChange,
    onRefreshReady,
  }: {
    context: SkillsShellSlotContext;
    onReconcileReady?: (action: (() => Promise<void>) | undefined) => void;
    onRefreshFocus?: () => void;
    onRefreshPendingChange?: (pending: boolean) => void;
    onRefreshReady?: (action: () => Promise<void>) => void;
  } = $props();

  let operationMessage = $state<{ message: string; tone: 'error' | 'success' } | null>(null);
  let awaitingRefresh = $state<SkillsRefreshAcceptanceTarget>();
  let refreshDecisionOpen = $state(false);
  let mounted = $state(false);
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreFocusFrame: number | undefined;
  const SUCCESS_MESSAGE_DURATION_MS = 5000;
  const pendingOperation = $derived(context.management.pendingOperation);
  const reconcilePlan = $derived(context.management.plan);
  const managementNotice = $derived(
    context.management.notice?.owner === 'health-page' ? context.management.notice : null,
  );
  const reconcileAvailable = $derived(canReconcileAll(context.snapshot));
  const applyBusyAttributes = $derived({
    'aria-busy': pendingOperation === 'reconcile-all' ? 'true' : 'false',
  } as const);

  const clearDismissTimer = (): void => {
    if (dismissTimer !== undefined) {
      clearTimeout(dismissTimer);
      dismissTimer = undefined;
    }
  };
  const setSuccessMessage = (message: string): void => {
    clearDismissTimer();
    operationMessage = { message, tone: 'success' };
    dismissTimer = setTimeout(() => {
      dismissTimer = undefined;
      operationMessage = null;
    }, SUCCESS_MESSAGE_DURATION_MS);
  };
  const scheduleRefreshFocus = (): void => {
    if (typeof window === 'undefined') {
      return;
    }
    if (restoreFocusFrame !== undefined) {
      window.cancelAnimationFrame(restoreFocusFrame);
    }
    restoreFocusFrame = window.requestAnimationFrame(() => {
      restoreFocusFrame = undefined;
      onRefreshFocus?.();
    });
  };
  const execute = async (operation: SkillsManagementOperation, pendingLabel: string): Promise<void> => {
    if (pendingOperation !== null) {
      return;
    }
    operationMessage = null;
    clearDismissTimer();
    await context.management.execute({
      kind: 'management',
      operation,
      owner: 'health-page',
      pendingLabel,
    });
  };
  const previewReconcile = async (): Promise<void> => {
    await execute(previewReconcileOperation, 'preview-reconcile');
  };
  const refreshSkills = async (): Promise<void> => {
    if (pendingOperation !== null) {
      return;
    }
    operationMessage = null;
    clearDismissTimer();
    const result = await context.management.execute({
      kind: 'refresh',
      owner: 'health-page',
      pendingLabel: 'refresh-skills',
    });
    if (result === undefined) {
      awaitingRefresh = undefined;
      return;
    }
    const signature = skillsSnapshotAcceptanceSignature(result.snapshot);
    awaitingRefresh = { publicationReady: false, signature };
    if (awaitingRefresh?.signature === signature) {
      awaitingRefresh = { publicationReady: true, signature };
    }
  };

  onMount(() => {
    mounted = true;
  });
  onDestroy(() => {
    clearDismissTimer();
    if (restoreFocusFrame !== undefined) {
      window.cancelAnimationFrame(restoreFocusFrame);
    }
    onReconcileReady?.(undefined);
  });
  $effect(() => {
    if (mounted) {
      onRefreshReady?.(refreshSkills);
    }
  });
  $effect(() => {
    onReconcileReady?.(mounted && reconcileAvailable && pendingOperation === null ? previewReconcile : undefined);
  });
  $effect(() => {
    onRefreshPendingChange?.(pendingOperation !== null);
  });
  $effect(() => {
    const decisionPending = context.snapshotUpdates.pendingDecision !== undefined;
    if (decisionPending && awaitingRefresh !== undefined) {
      refreshDecisionOpen = true;
    }
    const decisionClosed = !decisionPending && refreshDecisionOpen;
    let decisionState: SkillsRefreshDecisionState = 'none';
    if (decisionPending) {
      decisionState = 'pending';
    } else if (decisionClosed) {
      decisionState = 'closed';
    }
    const acceptance = resolveSkillsRefreshAcceptance(awaitingRefresh, context.snapshot, decisionState);
    if (acceptance === 'announce') {
      awaitingRefresh = undefined;
      setSuccessMessage('Skills refreshed.');
    } else if (acceptance === 'clear') {
      awaitingRefresh = undefined;
    }
    if (decisionClosed) {
      refreshDecisionOpen = false;
      scheduleRefreshFocus();
    }
  });

  const planPanel = css({
    display: 'grid',
    gap: '8px',
    p: '12px 14px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'accentTint',
  });
  const planLabel = css({
    color: 'muted',
    fontSize: '11px',
    fontWeight: 650,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
  });
  const planActions = css({ display: 'flex', flexWrap: 'wrap', gap: '8px' });
  const planSkippedList = css({ color: 'muted' });
  const positionedButton = css({ position: 'relative' });
</script>

<div class={stack} data-skills-management-health-slot>
  {#if reconcilePlan}
    <section aria-label="Reconcile plan" class={planPanel} data-skills-reconcile-plan>
      <div class={strongCell}>Planned actions ({reconcilePlan.apply.length})</div>
      {#if reconcilePlan.apply.length > 0}
        <ul class={skillsReconcilePlanList}>
          {#each reconcilePlan.apply as line (line)}
            <li>{line}</li>
          {/each}
        </ul>
      {:else}
        <p class={muted}>Nothing to apply — every active skill is already linked.</p>
      {/if}
      {#if reconcilePlan.skipped.length > 0}
        <div class={planLabel}>Skipped ({reconcilePlan.skipped.length}) — unmanaged content is never touched</div>
        <ul class={cx(skillsReconcilePlanList, planSkippedList)}>
          {#each reconcilePlan.skipped as line (line)}
            <li>{line}</li>
          {/each}
        </ul>
      {/if}
      <div class={planActions}>
        <button
          {...applyBusyAttributes}
          class={cx(commandButton, pendingButton, positionedButton)}
          data-pending={pendingOperation === 'reconcile-all' ? 'true' : undefined}
          disabled={pendingOperation !== null || reconcilePlan.apply.length === 0}
          onclick={() => execute(reconcileAllOperation, 'reconcile-all')}
          type="button"
        >
          Apply {reconcilePlan.apply.length}
          {reconcilePlan.apply.length === 1 ? 'action' : 'actions'}
        </button>
        <button
          class={ghostButton}
          disabled={pendingOperation !== null}
          onclick={() => context.management.clearPlan()}
          type="button"
        >
          Cancel
        </button>
      </div>
    </section>
  {:else if !reconcileAvailable}
    <p class={meta} data-skills-reconcile-unavailable>
      Reconcile needs a configured source repository with at least one enabled target.
    </p>
  {/if}
  {#if managementNotice?.tone === 'error'}
    <p class={cx(banner, bannerError, operationNotice)} role="alert">{managementNotice.message}</p>
  {:else if operationMessage}
    <p aria-live="polite" class={cx(banner, bannerOk, operationNotice, passiveOperationNotice)} role="status">
      {operationMessage.message}
    </p>
  {:else if managementNotice}
    <p aria-live="polite" class={cx(banner, bannerOk, operationNotice, passiveOperationNotice)} role="status">
      {managementNotice.message}
    </p>
  {/if}
</div>
