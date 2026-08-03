<script lang="ts">
  import { MAX_CAMPAIGN_LABEL_LENGTH } from '@ai-usage/report-core/campaign-label';
  import { untrack } from 'svelte';
  import { button, field, muted, row, stack, title } from '../breakdown/styles';

  export interface CampaignLabelEditorState {
    readonly campaignKey: string;
    readonly effectiveLabel: string;
    readonly hasOverride: boolean;
    readonly loadError: string | null;
    readonly loadStatus: 'error' | 'idle' | 'loading' | 'ready';
    readonly mutationError: string | null;
    readonly mutationStatus: 'error' | 'idle' | 'saving';
    readonly onRename: (label: string) => Promise<string | null>;
    readonly onReset: () => Promise<string | null>;
    readonly onRetry: () => Promise<boolean> | undefined;
  }

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

<section class={stack} data-campaign-label-editor>
  <label class={title} for="p8-campaign-label">Campaign label</label>
  <div class={row}>
    <input class={field} id="p8-campaign-label" maxlength={MAX_CAMPAIGN_LABEL_LENGTH} bind:value={draft}>
    <button
      class={button}
      disabled={editor.mutationStatus === 'saving' || !trimmedDraft || trimmedDraft === editor.effectiveLabel}
      onclick={rename}
      type="button"
    >
      Rename
    </button>
    <button
      class={button}
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
      <button class={button} onclick={() => editor.onRetry()} type="button">Retry labels</button>
    {/if}
    {#if editor.mutationStatus === 'saving'}
      Saving campaign label…
    {/if}
    {#if editor.mutationStatus === 'error'}
      Unable to save campaign label: {editor.mutationError}
    {/if}
  </div>
</section>
