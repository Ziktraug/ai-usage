<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
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
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
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
  import { applySkillsConfigurationSnapshotToCache, skillsSnapshotKey } from '../../../query/options/skills';
  import { createBrowserWebRpcClient } from '../../../rpc/client';
  import { createSkillsClient } from '../../../rpc/skills-client';
  import type { SkillsManagementPlanController } from '../shell/management-plan-controller';
  import type { SkillsShellSlotContext } from '../shell/slot-context';
  import {
    observeInspectorDisclosure,
    resolveSkillsRefreshAcceptance,
    runSkillsManagementOperation,
    runSkillsRefreshOperation,
    type SkillsConfigurationClient,
    type SkillsManagementOperation,
    type SkillsRefreshAcceptanceTarget,
    type SkillsRefreshClient,
    type SkillsRefreshDecisionState,
    shouldAnnounceSkillsHydrationReload,
    skillsManagementSuccessMessage,
    skillsSnapshotAcceptanceSignature,
    toggleOperation,
  } from './model';
  import SkillsConfiguration from './skills-configuration.svelte';
  import SkillsConsolidate from './skills-consolidate.svelte';
  import {
    button,
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
    onRefreshFocus,
    onRefreshPendingChange,
    onRefreshReady,
  }: {
    client?: SkillsHealthClient;
    context: SkillsShellSlotContext;
    managementPlan: SkillsManagementPlanController;
    onRefreshFocus?: () => void;
    onRefreshPendingChange?: (pending: boolean) => void;
    onRefreshReady?: (action: () => Promise<void>) => void;
  } = $props();
  const queryClient = useQueryClient();
  let browserClient: SkillsHealthClient | undefined;
  let pendingOperation = $state<string | null>(null);
  let inspectorSectionsOpen = $state(false);
  let operationMessage = $state<{ message: string; tone: 'error' | 'success' } | null>(null);
  let awaitingRefresh = $state<SkillsRefreshAcceptanceTarget>();
  let refreshDecisionOpen = $state(false);
  let mounted = $state(false);
  let hydrationReloadAnnounced = $state(false);
  const hydrationSnapshot = untrack(() => context.snapshot);
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreFocusFrame: number | undefined;
  const health = $derived(buildSkillHealthSummary(context.snapshot));
  const unmanagedGroups = $derived(groupUnmanagedEntries(context.snapshot));
  const selectedSkill = $derived(
    context.view.selectionDetail.kind === 'global-skill' ? context.view.selectionDetail.skill : undefined,
  );
  const diagnostics = $derived(selectedSkill ? groupSkillDiagnostics(selectedSkill.diagnostics) : []);
  const exposure = $derived(selectedSkill ? buildGlobalSkillExposure(context.snapshot, selectedSkill.name) : []);
  const installationAction = $derived(selectedSkill ? deriveInstallationAction(selectedSkill, exposure) : undefined);
  const resolveClient = (): SkillsHealthClient => {
    browserClient ??=
      injectedClient ?? createSkillsClient(createBrowserWebRpcClient('skills-management-inspector').skills);
    return browserClient;
  };
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
  const clearDismissTimer = (): void => {
    if (dismissTimer !== undefined) {
      clearTimeout(dismissTimer);
      dismissTimer = undefined;
    }
  };
  const setErrorMessage = (message: string): void => {
    clearDismissTimer();
    operationMessage = { message, tone: 'error' };
  };
  const setSuccessMessage = (message: string): void => {
    clearDismissTimer();
    operationMessage = { message, tone: 'success' };
    dismissTimer = setTimeout(() => {
      dismissTimer = undefined;
      operationMessage = null;
    }, 5000);
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
    onRefreshReady?.(refreshSkills);
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
  $effect(() => onRefreshPendingChange?.(pendingOperation !== null));
  $effect(() => {
    const nextSnapshot = context.snapshot;
    if (!(mounted && !hydrationReloadAnnounced && nextSnapshot !== hydrationSnapshot)) {
      return;
    }
    hydrationReloadAnnounced = true;
    if (shouldAnnounceSkillsHydrationReload(hydrationSnapshot, nextSnapshot, operationMessage !== null)) {
      setSuccessMessage('Skills reloaded.');
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
      setSuccessMessage('Skills reloaded.');
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
    if (pendingOperation !== null) {
      return;
    }
    pendingOperation = pendingLabel;
    managementPlan.clear();
    operationMessage = null;
    try {
      const result = await runSkillsManagementOperation(resolveClient(), operation);
      if (!result.ok) {
        setErrorMessage(result.error);
        return;
      }
      managementPlan.publish(result.plan);
      queryClient.setQueryData(skillsSnapshotKey(), result.snapshot);
      setSuccessMessage(skillsManagementSuccessMessage(operation, result));
      if (operation === 'preview-reconcile') {
        await tick();
        await goto('/skills/matrix');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Skills are unavailable.');
    } finally {
      pendingOperation = null;
    }
  };
  const refreshSkills = async (): Promise<void> => {
    if (pendingOperation !== null) {
      return;
    }
    pendingOperation = 'refresh-skills';
    operationMessage = null;
    clearDismissTimer();
    try {
      const client = resolveClient();
      const result = await runSkillsRefreshOperation(client);
      if (!result.ok) {
        setErrorMessage(result.error);
        return;
      }
      const signature = skillsSnapshotAcceptanceSignature(result.snapshot);
      awaitingRefresh = { publicationReady: false, signature };
      await applySkillsConfigurationSnapshotToCache(queryClient, client, result.snapshot, true);
      if (awaitingRefresh?.signature === signature) {
        awaitingRefresh = { publicationReady: true, signature };
      }
    } catch (error) {
      awaitingRefresh = undefined;
      setErrorMessage(error instanceof Error ? error.message : 'Skills are unavailable.');
    } finally {
      pendingOperation = null;
    }
  };
  const reviewConsolidation = async (): Promise<void> => {
    await goto('/skills/matrix');
  };
  const copyText = async (value: string): Promise<void> => {
    await navigator.clipboard.writeText(value);
  };
</script>

<div class={stack} data-skills-management-health-slot>
  {#if context.view.selectionDetail.kind === 'global-scope'}
    <section class={compactStack}>
      <h3 class={heading}>Source health</h3>
      <a href="/skills/matrix">Healthy links {health.healthyLinkCount}/{health.expectedLinkCount}</a>
      <a href="/skills/matrix">To repair {health.toRepairCount}</a>
      <a href="/skills/matrix">Blocked {health.blockedCount}</a>
      <button
        {...previewBusyAttributes}
        class={button}
        disabled={pendingOperation !== null || !canReconcileAll(context.snapshot)}
        onclick={() => execute('preview-reconcile', 'preview-reconcile')}
        type="button"
      >
        Preview reconcile
      </button>
    </section>
    <SkillsConsolidate groups={unmanagedGroups} onReviewEntry={reviewConsolidation} total={health.consolidateCount} />
    <SkillsConfiguration {...(injectedClient === undefined ? {} : { client: injectedClient })} {context} />
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
              installationAction.mode === 'preview' ? 'preview-reconcile' : `reconcile:${selectedSkill.name}`,
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
  {#if operationMessage?.tone === 'error'}
    <p class={cx(banner, bannerError, operationNotice)} role="alert">{operationMessage.message}</p>
  {:else if operationMessage}
    <p aria-live="polite" class={cx(banner, bannerOk, operationNotice, passiveOperationNotice)} role="status">
      {operationMessage.message}
    </p>
  {/if}
</div>
