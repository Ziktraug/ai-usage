<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { searchInput } from '@ai-usage/design-system/svelte';
  import {
    editingMachineLabel,
    machineLabelDraftError,
    machineLabelIsSavable,
    machineLabelSaved,
    machineLabelSaveFailed,
    savingMachineLabel,
    viewingMachineLabel,
  } from './machine-label-editor-model';
  import { actionRow, ghostButton } from './styles';

  // Only the local machine is editable: the engine command renames *this* machine, and labels for
  // peers travel with their merge bundles.
  let {
    editable,
    label,
    onRename,
  }: {
    editable: boolean;
    label: string;
    onRename: (label: string) => Promise<string | null>;
  } = $props();

  const machineTitle = css({ fontSize: '15px', fontWeight: 750, overflowWrap: 'anywhere' });
  const editorLayout = css({ display: 'grid', gap: '8px', minW: 0 });
  const editorStatus = css({ color: 'muted', fontSize: '12px' });

  let editor = $state(viewingMachineLabel());
  const savable = $derived(machineLabelIsSavable(editor, label, editable));
  const draftError = $derived(machineLabelDraftError(editor, editable));

  const save = async (): Promise<void> => {
    if (!savable) {
      return;
    }
    const draft = editor.draft.trim();
    editor = savingMachineLabel(editor);
    const renamed = await onRename(draft);
    editor = renamed === null ? machineLabelSaveFailed(editor) : machineLabelSaved();
  };
</script>

{#if editor.phase === 'view'}
  <div class={cx(actionRow, editorLayout)} data-machine-label-editor="view">
    <h3 class={machineTitle}>{label}</h3>
    {#if editable}
      <button class={ghostButton} onclick={() => (editor = editingMachineLabel(label))} type="button">Rename</button>
    {/if}
  </div>
{:else}
  <div class={editorLayout} data-machine-label-editor={editor.phase}>
    <label class={editorStatus} for="machine-fleet-label">Machine label</label>
    <div class={actionRow}>
      <input
        class={searchInput}
        disabled={editor.phase === 'saving'}
        id="machine-fleet-label"
        bind:value={editor.draft}
      >
      <button class={ghostButton} disabled={editor.phase === 'saving' || !savable} onclick={save} type="button">
        {editor.phase === 'saving' ? 'Saving' : 'Save'}
      </button>
      <button
        class={ghostButton}
        disabled={editor.phase === 'saving'}
        onclick={() => (editor = viewingMachineLabel())}
        type="button"
      >
        Cancel
      </button>
    </div>
    <div aria-live="polite" class={editorStatus}>
      {#if editor.phase === 'saving'}
        Renaming this machine…
      {:else if draftError}
        {draftError}
      {/if}
    </div>
  </div>
{/if}
