<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, skillsDisclosurePanel, skillsDisclosureSummary } from '@ai-usage/design-system/report';
  import {
    banner,
    bannerError,
    bannerOk,
    commandButton,
    ghostButton,
    meta,
    pendingButton,
    statusPill,
    statusPillOk,
    statusPillWarn,
    strongCell,
  } from '@ai-usage/design-system/svelte';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { deriveInstallationAction, groupSkillDiagnostics } from '../../../../skill-document-inspector-model';
  import {
    buildGlobalSkillExposure,
    buildSkillHealthSummary,
    canReconcileAll,
    count,
    groupUnmanagedEntries,
    skillDiagnosticLabel,
    skillInvocation,
  } from '../../../../skills-page-model';
  import { SKILLS_DESKTOP_MEDIA_QUERY } from '../../../../skills-responsive';
  import { fmtNum } from '../../../foundation/presentation/format';
  import {
    applySkillsConfigurationSnapshotToCache,
    skillsMutationOptions,
    skillsSnapshotKey,
  } from '../../../query/options/skills';
  import { useOptionalWebQueryRpcContext } from '../../../query/rpc-context.svelte';
  import { createSkillsClient } from '../../../rpc/skills-client';
  import type { SkillsManagementPlanController } from '../shell/management-plan-controller';
  import type { SkillsHealthSlotPlacement, SkillsShellSlotContext } from '../shell/slot-context';
  import {
    observeInspectorDisclosure,
    previewReconcileOperation,
    reconcileSkillOperation,
    resolveSkillsRefreshAcceptance,
    runSkillsManagementOperation,
    runSkillsRefreshOperation,
    type SkillsConfigurationClient,
    type SkillsManagementOperation,
    type SkillsRefreshAcceptanceTarget,
    type SkillsRefreshClient,
    type SkillsRefreshDecisionState,
    skillsManagementSuccessMessage,
    skillsSnapshotAcceptanceSignature,
    toggleOperation,
  } from './model';
  import SkillsConfiguration from './skills-configuration.svelte';
  import SkillsConsolidate from './skills-consolidate.svelte';
  import {
    compactStack,
    diagnosticRow,
    heading,
    muted,
    operationNotice,
    passiveOperationNotice,
    pathText,
    stack,
  } from './styles';

  type SkillsHealthClient = SkillsConfigurationClient & SkillsRefreshClient;

  let {
    client: injectedClient,
    context,
    managementPlan,
    placement = 'inspector',
    onRefreshFocus,
    onRefreshPendingChange,
    onRefreshReady,
  }: {
    client?: SkillsHealthClient;
    context: SkillsShellSlotContext;
    managementPlan: SkillsManagementPlanController;
    placement?: SkillsHealthSlotPlacement;
    onRefreshFocus?: () => void;
    onRefreshPendingChange?: (pending: boolean) => void;
    onRefreshReady?: (action: () => Promise<void>) => void;
  } = $props();
  const queryClient = useQueryClient();
  const rpc = useOptionalWebQueryRpcContext()?.rpc;
  let browserClient: SkillsHealthClient | undefined;
  let inspectorSectionsOpen = $state(false);
  let operationMessage = $state<{ message: string; tone: 'error' | 'success' } | null>(null);
  let awaitingRefresh = $state<SkillsRefreshAcceptanceTarget>();
  let refreshDecisionOpen = $state(false);
  let mounted = $state(false);
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreFocusFrame: number | undefined;
  const ownsRefreshRegistration = $derived(
    placement === 'detail' || context.view.selectionDetail.kind !== 'global-scope' || context.view.matrixOpen,
  );
  const health = $derived(buildSkillHealthSummary(context.snapshot));
  const disabledSkills = $derived(context.snapshot.skills.filter((skill) => !skill.enabled));
  const unmanagedGroups = $derived(groupUnmanagedEntries(context.snapshot));
  const selectedSkill = $derived(
    context.view.selectionDetail.kind === 'global-skill' ? context.view.selectionDetail.skill : undefined,
  );
  const diagnostics = $derived(selectedSkill ? groupSkillDiagnostics(selectedSkill.diagnostics) : []);
  const exposure = $derived(selectedSkill ? buildGlobalSkillExposure(context.snapshot, selectedSkill.name) : []);
  const installationAction = $derived(selectedSkill ? deriveInstallationAction(selectedSkill, exposure) : undefined);
  const resolveClient = (): SkillsHealthClient => {
    if (injectedClient) {
      return injectedClient;
    }
    if (!rpc) {
      throw new Error('The shared browser RPC context is unavailable.');
    }
    browserClient ??= createSkillsClient(rpc.skills);
    return browserClient;
  };
  const managementMutation = createMutation(() =>
    skillsMutationOptions(
      'health-management',
      async (variables: { operation: SkillsManagementOperation; pendingLabel: string }) => {
        const result = await runSkillsManagementOperation(resolveClient(), variables.operation);
        if (!result.ok) {
          throw new Error(result.error);
        }
        return { ...result, ...variables };
      },
    ),
  );
  const refreshMutation = createMutation(() =>
    skillsMutationOptions('refresh-snapshot', async (_variables: undefined) => {
      const client = resolveClient();
      const result = await runSkillsRefreshOperation(client);
      if (!result.ok) {
        throw new Error(result.error);
      }
      await applySkillsConfigurationSnapshotToCache(queryClient, client, result.snapshot, true);
      return result;
    }),
  );
  const pendingOperation = $derived.by<string | null>(() => {
    if (refreshMutation.isPending) {
      return 'refresh-skills';
    }
    return managementMutation.isPending ? (managementMutation.variables?.pendingLabel ?? null) : null;
  });
  const operationError = $derived.by<string | null>(() => {
    if (managementMutation.error instanceof Error) {
      return managementMutation.error.message;
    }
    return refreshMutation.error instanceof Error ? refreshMutation.error.message : null;
  });
  const inspectorSection = css({ borderTop: '1px solid token(colors.line)', display: 'grid', gap: '8px', pt: '12px' });
  const inspectorRow = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'center',
  });
  const metricList = css({ display: 'grid', gap: '6px' });
  const metricRow = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'baseline',
    fontSize: '13px',
  });
  const inspectorHeading = css({ fontSize: '13px', fontWeight: 700 });
  const inspectorMeta = css({ color: 'muted', fontSize: '13px' });
  const inspectorValue = css({ minW: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
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
  const runtimeSummary = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'center',
    py: '8px',
    cursor: 'pointer',
  });
  const runtimeDisclosure = css({ borderTop: '1px solid token(colors.line)', _first: { borderTop: '0' } });
  const runtimePaths = css({
    display: 'grid',
    gap: '4px',
    pb: '8px',
    color: 'muted',
    fontFamily: 'mono',
    fontSize: '11px',
    overflowWrap: 'anywhere',
  });
  const actionGrid = css({ display: 'grid', gap: '8px' });
  const foldBody = css({ display: 'grid', gap: '14px', p: '0 16px 16px' });
  const detailSlotStack = css({ display: 'grid', gap: '14px' });
  const SUCCESS_MESSAGE_DURATION_MS = 5000;
  const foldsGrid = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', xl: 'minmax(0, 0.75fr) minmax(360px, 1.25fr)' },
    gap: '16px',
  });
  const disabledRow = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '10px',
    alignItems: 'center',
    p: '10px 0',
    borderTop: '1px solid token(colors.line)',
  });
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
  onMount(() => {
    mounted = true;
    return observeInspectorDisclosure(window.matchMedia(SKILLS_DESKTOP_MEDIA_QUERY), (open) => {
      inspectorSectionsOpen = open;
    });
  });
  onDestroy(() => {
    clearDismissTimer();
    if (restoreFocusFrame !== undefined) {
      window.cancelAnimationFrame(restoreFocusFrame);
    }
  });
  $effect(() => {
    if (mounted && ownsRefreshRegistration) {
      onRefreshReady?.(refreshSkills);
    }
  });
  $effect(() => {
    if (ownsRefreshRegistration) {
      onRefreshPendingChange?.(pendingOperation !== null);
    }
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
  const previewBusyAttributes = $derived({
    'aria-busy': pendingOperation === 'preview-reconcile' ? 'true' : 'false',
  } as const);
  const execute = async (operation: SkillsManagementOperation, pendingLabel: string): Promise<void> => {
    if (managementMutation.isPending || refreshMutation.isPending) {
      return;
    }
    managementPlan.clear();
    operationMessage = null;
    clearDismissTimer();
    try {
      const result = await managementMutation.mutateAsync({ operation, pendingLabel });
      managementPlan.publish(result.plan);
      queryClient.setQueryData(skillsSnapshotKey(), result.snapshot);
      setSuccessMessage(skillsManagementSuccessMessage(operation, result));
      if (operation.type === 'preview-reconcile') {
        await tick();
        await goto('/skills/matrix');
      }
    } catch {
      return;
    }
  };
  const refreshSkills = async (): Promise<void> => {
    if (managementMutation.isPending || refreshMutation.isPending) {
      return;
    }
    operationMessage = null;
    clearDismissTimer();
    try {
      const result = await refreshMutation.mutateAsync(undefined);
      const signature = skillsSnapshotAcceptanceSignature(result.snapshot);
      awaitingRefresh = { publicationReady: false, signature };
      if (awaitingRefresh?.signature === signature) {
        awaitingRefresh = { publicationReady: true, signature };
      }
    } catch {
      awaitingRefresh = undefined;
    }
  };
  const reviewConsolidation = async (): Promise<void> => {
    await goto('/skills/matrix');
  };
  const copyText = async (value: string): Promise<void> => {
    await navigator.clipboard.writeText(value);
  };
</script>

<div
  class={context.view.selectionDetail.kind === 'global-scope' && placement === 'detail' ? detailSlotStack : stack}
  data-skills-management-health-slot
>
  {#if context.view.selectionDetail.kind === 'global-scope'}
    {#if placement === 'detail'}
      <SkillsConsolidate groups={unmanagedGroups} onReviewEntry={reviewConsolidation} total={health.consolidateCount} />
      <div class={foldsGrid}>
        <details class={cx(panel, skillsDisclosurePanel)}>
          <summary class={skillsDisclosureSummary}>
            <span class={strongCell}>Disabled</span>
            <span class={meta}>{disabledSkills.length}</span>
          </summary>
          <div class={foldBody}>
            {#if disabledSkills.length === 0}
              <p class={meta}>No disabled skills.</p>
            {:else}
              {#each disabledSkills as skill (skill.name)}
                <div class={disabledRow}>
                  <div>
                    <div class={strongCell}>{skill.name}</div>
                    <div class={meta}>{skill.description || 'No description'}</div>
                  </div>
                  <button
                    class={cx(ghostButton, pendingButton)}
                    disabled={pendingOperation !== null}
                    onclick={() => execute(toggleOperation(skill.name, true), `toggle:${skill.name}`)}
                    type="button"
                  >
                    Enable
                  </button>
                </div>
              {/each}
            {/if}
          </div>
        </details>
        <SkillsConfiguration {...(injectedClient === undefined ? {} : { client: injectedClient })} {context} />
      </div>
    {:else}
      <section class={actionGrid}>
        <button
          class={ghostButton}
          onclick={() => goto(context.view.matrixOpen ? '/skills/global' : '/skills/matrix')}
          type="button"
        >
          {context.view.matrixOpen ? 'Close matrix' : 'Exposure matrix'}
        </button>
        <button
          {...previewBusyAttributes}
          class={cx(ghostButton, pendingButton)}
          disabled={pendingOperation !== null || !canReconcileAll(context.snapshot)}
          onclick={() => execute(previewReconcileOperation, 'preview-reconcile')}
          type="button"
        >
          Preview reconcile
        </button>
      </section>
    {/if}
  {:else if selectedSkill}
    <details class={inspectorSection} data-inspector-section="validation" open={inspectorSectionsOpen}>
      <summary><h3 class={inspectorHeading}>Validation</h3></summary>
      {#if diagnostics.length === 0}
        <p class={meta}>No validation diagnostics.</p>
      {/if}
      {#each diagnostics as diagnostic, index}
        <fieldset
          aria-label={`Finding ${index + 1}: ${diagnostic.severity}`}
          class={diagnosticRow}
          data-severity={diagnostic.severity}
          data-validation-finding={index + 1}
        >
          <span class={muted}>Finding {index + 1}</span>
          <code>{skillDiagnosticLabel(diagnostic.code)}</code>
          {#if diagnostic.count > 1}
            <span class={muted}>{diagnostic.count} occurrences</span>
          {/if}
          <p class={muted}>{diagnostic.message}</p>
          {#if diagnostic.tokenMeasurement}
            <p class={muted} data-token-measurement>
              {fmtNum(diagnostic.tokenMeasurement.observed)}
              / {fmtNum(diagnostic.tokenMeasurement.threshold)} tokens
            </p>
          {/if}
          {#if diagnostic.paths.length > 0}
            <details>
              <summary class={muted}>Related paths</summary>
              {#each diagnostic.paths as path}
                <code class={pathText} title={path}>{path}</code>
              {/each}
            </details>
          {/if}
        </fieldset>
      {/each}
    </details>
    <details class={inspectorSection} data-inspector-section="document" open={inspectorSectionsOpen}>
      <summary><h3 class={inspectorHeading}>Document</h3></summary>
      <div class={metricList}>
        <div class={metricRow}>
          <span class={inspectorMeta}>Total tokens</span>
          <strong>{selectedSkill.tokenCount ? fmtNum(selectedSkill.tokenCount.total) : 'Unknown'}</strong>
        </div>
        {#if selectedSkill.tokenCount}
          <div class={metricRow}>
            <span class={inspectorMeta}>SKILL.md tokens</span>
            <strong>{fmtNum(selectedSkill.tokenCount.skillMd)}</strong>
          </div>
        {/if}
        <div class={metricRow}>
          <span class={inspectorMeta}>Invocation</span>
          <strong>{skillInvocation(selectedSkill) === 'auto' ? 'Auto' : 'Manual'}</strong>
        </div>
        <div class={metricRow}>
          <span class={inspectorMeta}>State</span>
          <strong>{selectedSkill.enabled ? 'Enabled' : 'Disabled'}</strong>
        </div>
      </div>
    </details>
    <details class={inspectorSection} data-inspector-section="source" open={inspectorSectionsOpen}>
      <summary><h3 class={inspectorHeading}>Source</h3></summary>
      <div class={inspectorRow}>
        <div class={inspectorValue}>
          <div class={meta}>Source path</div>
          <code class={sourceValue} title={selectedSkill.path}>{selectedSkill.path}</code>
        </div>
        <button class={ghostButton} onclick={() => copyText(selectedSkill.path)} type="button">Copy source path</button>
      </div>
      <div class={inspectorRow}>
        <div class={inspectorValue}>
          <div class={meta}>SKILL.md</div>
          <code class={sourceValue} title={selectedSkill.skillMdPath}>{selectedSkill.skillMdPath}</code>
        </div>
        <button class={ghostButton} onclick={() => copyText(selectedSkill.skillMdPath)} type="button">
          Copy SKILL.md path
        </button>
      </div>
    </details>
    <details class={inspectorSection} data-inspector-section="installed-in" open={inspectorSectionsOpen}>
      <summary><h3 class={inspectorHeading}>Installed in</h3></summary>
      {#each exposure as item}
        <details class={runtimeDisclosure}>
          <summary class={runtimeSummary}>
            <span class={strongCell}
              >{context.snapshot.targets.find((target) => target.id === item.targetId)?.label ?? item.targetId}</span
            >
            <span class={cx(statusPill, item.state === 'linked' ? statusPillOk : statusPillWarn)}>{item.label}</span>
          </summary>
          <div class={runtimePaths}>
            <div>Expected: {item.expectedPath}</div>
            {#if item.actualPath}
              <div>Actual: {item.actualPath}</div>
            {/if}
          </div>
        </details>
      {/each}
    </details>
    <details class={inspectorSection} data-inspector-section="actions" open={inspectorSectionsOpen}>
      <summary><h3 class={inspectorHeading}>Actions</h3></summary>
      <div class={actionGrid}>
        <button
          class={cx(ghostButton, pendingButton)}
          disabled={pendingOperation !== null}
          onclick={() => execute(toggleOperation(selectedSkill.name, !selectedSkill.enabled), `toggle:${selectedSkill.name}`)}
          type="button"
        >
          {selectedSkill.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          class={cx(commandButton, pendingButton)}
          disabled={pendingOperation !== null || installationAction?.mode === 'none'}
          onclick={() => {
            if (!installationAction || installationAction.mode === 'none') {
              return;
            }
            execute(
              installationAction.mode === 'preview'
                ? previewReconcileOperation
                : reconcileSkillOperation(selectedSkill.name),
              installationAction.mode === 'preview' ? 'preview-reconcile' : `reconcile:${selectedSkill.name}`,
            );
          }}
          type="button"
        >
          {installationAction?.label ?? 'Install'}
        </button>
      </div>
    </details>
  {:else if context.view.selectionDetail.kind === 'project-scope'}
    <section class={compactStack}>
      <h3 class={heading}>Project scope</h3>
      <p class={pathText}>{context.view.selectionDetail.project.path}</p>
      <p>{count(context.view.selectionDetail.inventories.length, 'inventory', 'inventories')}</p>
    </section>
  {:else}
    <section class={compactStack}>
      <h3 class={heading}>Project skill</h3>
      <p class={muted}>Read-only runtime observation.</p>
    </section>
  {/if}
  {#if operationError}
    <p class={cx(banner, bannerError, operationNotice)} role="alert">{operationError}</p>
  {:else if operationMessage}
    <p aria-live="polite" class={cx(banner, bannerOk, operationNotice, passiveOperationNotice)} role="status">
      {operationMessage.message}
    </p>
  {/if}
</div>
