<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { HarnessBadge } from '@ai-usage/design-system/svelte';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';
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
  import { skillsSnapshotKey } from '../../../query/options/skills';
  import { createBrowserWebRpcClient } from '../../../rpc/client';
  import { createSkillsClient } from '../../../rpc/skills-client';
  import type { SkillsShellSlotContext } from '../shell/slot-context';
  import {
    matrixDotTone,
    observeInspectorDisclosure,
    runSkillsManagementOperation,
    type SkillsManagementClient,
    type SkillsManagementOperation,
    toggleOperation,
  } from './model';
  import SkillsConfiguration from './skills-configuration.svelte';
  import SkillsConsolidate from './skills-consolidate.svelte';
  import {
    actionRow,
    brokenDot,
    button,
    compactStack,
    copyDot,
    diagnosticRow,
    errorNotice,
    heading,
    linkedDot,
    missingDot,
    muted,
    notice,
    pathText,
    primaryButton,
    stack,
    statusDot,
  } from './styles';

  let { client: injectedClient, context }: { client?: SkillsManagementClient; context: SkillsShellSlotContext } =
    $props();
  const queryClient = useQueryClient();
  let browserClient: SkillsManagementClient | undefined;
  let pendingOperation = $state<string | null>(null);
  let inspectorSectionsOpen = $state(false);
  let operationMessage = $state<{ message: string; tone: 'error' | 'success' } | null>(null);
  const health = $derived(buildSkillHealthSummary(context.snapshot));
  const unmanagedGroups = $derived(groupUnmanagedEntries(context.snapshot));
  const selectedSkill = $derived(
    context.view.selectionDetail.kind === 'global-skill' ? context.view.selectionDetail.skill : undefined,
  );
  const diagnostics = $derived(selectedSkill ? groupSkillDiagnostics(selectedSkill.diagnostics) : []);
  const exposure = $derived(selectedSkill ? buildGlobalSkillExposure(context.snapshot, selectedSkill.name) : []);
  const installationAction = $derived(selectedSkill ? deriveInstallationAction(selectedSkill, exposure) : undefined);
  const resolveClient = (): SkillsManagementClient => {
    browserClient ??=
      injectedClient ?? createSkillsClient(createBrowserWebRpcClient('skills-management-inspector').skills);
    return browserClient;
  };
  onMount(() =>
    observeInspectorDisclosure(window.matchMedia(SKILLS_DESKTOP_MEDIA_QUERY), (open) => {
      inspectorSectionsOpen = open;
    }),
  );
  const successMessage = (operation: SkillsManagementOperation, actionCount: number): string => {
    if (operation === 'preview-reconcile') {
      return 'Reconcile preview refreshed.';
    }
    return actionCount === 0 ? 'Nothing to change.' : 'Skills updated.';
  };
  const previewBusyAttributes = $derived({
    'aria-busy': pendingOperation === 'preview-reconcile' ? 'true' : 'false',
  } as const);
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
      queryClient.setQueryData(skillsSnapshotKey(), result.snapshot);
      operationMessage = { message: successMessage(operation, result.actions.length), tone: 'success' };
      if (operation === 'preview-reconcile') {
        await goto('/skills/matrix');
      }
    } catch (error) {
      operationMessage = { message: error instanceof Error ? error.message : 'Skills are unavailable.', tone: 'error' };
    } finally {
      pendingOperation = null;
    }
  };
  const reviewConsolidation = async (): Promise<void> => {
    await goto('/skills/matrix');
  };
  const dotClass = (state: Parameters<typeof matrixDotTone>[0]): string | undefined => {
    const tone = matrixDotTone(state);
    if (tone === 'linked') {
      return linkedDot;
    }
    if (tone === 'missing') {
      return missingDot;
    }
    if (tone === 'broken') {
      return brokenDot;
    }
    if (tone === 'copy') {
      return copyDot;
    }
    return;
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
    <details class={compactStack} data-inspector-section="validation" open={inspectorSectionsOpen}>
      <summary><h3 class={heading}>Validation</h3></summary>
      {#if diagnostics.length === 0}
        <p class={muted}>No validation diagnostics.</p>
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
    <details class={compactStack} data-inspector-section="document" open={inspectorSectionsOpen}>
      <summary><h3 class={heading}>Document</h3></summary>
      <div>
        Total tokens <strong>{selectedSkill.tokenCount ? fmtNum(selectedSkill.tokenCount.total) : 'Unknown'}</strong>
      </div>
      <div>Invocation <strong>{skillInvocation(selectedSkill) === 'auto' ? 'Auto' : 'Manual'}</strong></div>
      <div>State <strong>{selectedSkill.enabled ? 'Enabled' : 'Disabled'}</strong></div>
    </details>
    <details class={compactStack} data-inspector-section="source" open={inspectorSectionsOpen}>
      <summary><h3 class={heading}>Source</h3></summary>
      <div class={muted}>Source path</div>
      <code class={pathText} title={selectedSkill.path}>{selectedSkill.path}</code>
      <div class={muted}>SKILL.md</div>
      <code class={pathText} title={selectedSkill.skillMdPath}>{selectedSkill.skillMdPath}</code>
    </details>
    <details class={compactStack} data-inspector-section="installed-in" open={inspectorSectionsOpen}>
      <summary><h3 class={heading}>Installed in</h3></summary>
      <fieldset aria-label="Installed in">
        {#each exposure as item}
          <div class={actionRow}>
            <HarnessBadge
              name={context.snapshot.targets.find((target) => target.id === item.targetId)?.label ?? item.targetId}
            /><span class={cx(statusDot, dotClass(item.state))}></span><span>{item.label}</span>
          </div>
        {/each}
      </fieldset>
    </details>
    <details class={compactStack} data-inspector-section="actions" open={inspectorSectionsOpen}>
      <summary><h3 class={heading}>Actions</h3></summary>
      <div class={actionRow}>
        <button
          class={button}
          disabled={pendingOperation !== null}
          onclick={() => execute(toggleOperation(selectedSkill.name, !selectedSkill.enabled), `toggle:${selectedSkill.name}`)}
          type="button"
        >
          {selectedSkill.enabled ? 'Disable' : 'Enable'}
        </button>
        {#if installationAction && installationAction.mode !== 'none'}
          <button
            class={cx(button, primaryButton)}
            disabled={pendingOperation !== null}
            onclick={() => execute(installationAction.mode === 'preview' ? 'preview-reconcile' : `reconcile:${selectedSkill.name}`, installationAction.mode === 'preview' ? 'preview-reconcile' : `reconcile:${selectedSkill.name}`)}
            type="button"
          >
            {installationAction.label}
          </button>
        {/if}
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
    <p class={cx(notice, errorNotice)} role="alert">{operationMessage.message}</p>
  {:else if operationMessage}
    <p aria-live="polite" class={notice} role="status">{operationMessage.message}</p>
  {/if}
</div>
