<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { ghostButton, searchInput } from '@ai-usage/design-system/svelte/passive';
  import { MAX_CAMPAIGN_LABEL_LENGTH } from '@ai-usage/report-core/campaign-label';
  import { untrack } from 'svelte';
  import type { CampaignLabelEditorState } from './campaign-label-editor-state';

  const drawerTitle = css({ fontSize: '15px', fontWeight: 650, lineHeight: '1.35', overflowWrap: 'anywhere' });
  const drawerCompare = css({ color: 'muted', fontSize: '12px' });
  const muted = css({ color: 'muted' });
  const drawerActions = css({ display: 'flex', flexWrap: 'wrap', gap: '8px' });
  const campaignLabelInputId = 'session-drawer-campaign-label';
  const editorLayout = css({ display: 'grid', gap: '8px' });

  let { editor }: { editor: CampaignLabelEditorState } = $props();
  let draft = $state(untrack(() => editor.effectiveLabel));
  $effect(() => {
    if (editor.campaignKey === '') {
      return;
    }
    draft = editor.effectiveLabel;
  });
  const trimmedDraft = $derived(draft.trim());

  const rename = async (): Promise<void> => {
    if (!(trimmedDraft && trimmedDraft !== editor.effectiveLabel)) {
      return;
    }
    const effectiveLabel = await editor.onRename(trimmedDraft);
    if (effectiveLabel !== null) {
      draft = effectiveLabel;
    }
  };
  const reset = async (): Promise<void> => {
    const effectiveLabel = await editor.onReset();
    if (effectiveLabel !== null) {
      draft = effectiveLabel;
    }
  };
</script>

<div class={cx(drawerCompare, editorLayout)} data-campaign-label-editor>
  <label class={drawerTitle} for={campaignLabelInputId}>Campaign label</label>
  <div class={drawerActions}>
    <input class={searchInput} id={campaignLabelInputId} maxlength={MAX_CAMPAIGN_LABEL_LENGTH} bind:value={draft}>
    <button
      class={ghostButton}
      disabled={editor.mutationStatus === 'saving' || !trimmedDraft || trimmedDraft === editor.effectiveLabel}
      onclick={rename}
      type="button"
    >
      Rename
    </button>
    <button
      class={ghostButton}
      disabled={editor.mutationStatus === 'saving' || !editor.hasOverride}
      onclick={reset}
      type="button"
    >
      Reset
    </button>
  </div>
  <div aria-live="polite" class={muted} data-campaign-label-status>
    {#if editor.loadStatus === 'loading'}
      Loading campaign labels…
    {/if}
    {#if editor.loadStatus === 'error'}
      <span>Unable to load campaign labels: {editor.loadError}</span>
      <button class={ghostButton} onclick={() => editor.onRetry()} type="button">Retry labels</button>
    {/if}
    {#if editor.mutationStatus === 'saving'}
      Saving campaign label…
    {/if}
    {#if editor.mutationStatus === 'error'}
      Unable to save campaign label: {editor.mutationError}
    {/if}
  </div>
</div>
