<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    commandButton,
    ghostButton,
    statusPill,
    statusPillDanger,
    statusPillInfo,
    statusPillOk,
    statusPillWarn,
    strongCell,
  } from '@ai-usage/design-system/svelte';
  import { onDestroy, untrack } from 'svelte';
  import type { SkillMarkdownEditorController, SkillMarkdownEditorState } from './controller';
  import { isSkillMarkdownSaveShortcut } from './controller';
  import DiscardConfirmationDialog from './discard-confirmation-dialog.svelte';

  let {
    controller,
    onFocusReady,
  }: {
    controller: SkillMarkdownEditorController;
    onFocusReady?: (focus: () => void) => void;
  } = $props();

  const editorController = untrack(() => controller);
  const initialEditorState = untrack(() => editorController.getState());
  let editorState = $state(initialEditorState);
  let draftValue = $state(initialEditorState.draft);
  let editorElement = $state<HTMLTextAreaElement>();
  let reloadRequested = $state(false);
  const stopState = editorController.subscribe((next) => {
    editorState = next;
    draftValue = next.draft;
  });
  onDestroy(stopState);

  const focusEditor = (): void => {
    editorElement?.focus();
  };
  $effect(() => {
    if (editorElement) {
      onFocusReady?.(focusEditor);
    }
  });

  const editorSection = css({
    display: 'grid',
    gridTemplateAreas: {
      base: '"header" "editor" "actions"',
      md: '"header actions" "editor editor"',
    },
    gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1fr) auto' },
    columnGap: { base: '12px', md: 0 },
    rowGap: '12px',
    minW: 0,
  });
  const documentToolbar = css({
    gridArea: 'header',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    alignItems: 'center',
    p: '10px 12px',
    border: '1px solid token(colors.line)',
    borderRightWidth: { base: '1px', md: 0 },
    borderTopLeftRadius: 'sm',
    borderTopRightRadius: { base: 'sm', md: 0 },
    borderBottomRightRadius: { base: 'sm', md: 0 },
    borderBottomLeftRadius: 'sm',
    bg: 'surfaceMuted',
  });
  const documentActions = css({
    gridArea: 'actions',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    alignItems: 'center',
    justifyContent: { base: 'flex-start', md: 'flex-end' },
    p: '10px 12px',
    border: '1px solid token(colors.line)',
    borderTopLeftRadius: { base: 'sm', md: 0 },
    borderTopRightRadius: 'sm',
    borderBottomRightRadius: 'sm',
    borderBottomLeftRadius: { base: 'sm', md: 0 },
    bg: 'surfaceMuted',
  });
  const editorArea = css({
    gridArea: 'editor',
    boxSizing: 'border-box',
    minH: { base: '60vh', md: 'clamp(480px, 65vh, 900px)' },
    maxW: '100%',
    w: '100%',
    overflowX: 'hidden',
    overflowWrap: 'anywhere',
    p: '14px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    fontFamily: 'mono',
    fontSize: '13px',
    lineHeight: 1.6,
    resize: 'vertical',
    tabSize: 2,
    whiteSpace: 'pre-wrap',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const loadingBlock = css({
    gridArea: 'editor',
    display: 'grid',
    minH: { base: '60vh', md: 'clamp(480px, 65vh, 900px)' },
    placeItems: 'center',
    p: '14px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surfaceMuted',
  });

  interface DocumentStatus {
    readonly error: boolean;
    readonly label: string;
    readonly tone: string;
  }
  const documentStatus = (next: SkillMarkdownEditorState): DocumentStatus => {
    if (next.loading || (next.document === undefined && next.error === null)) {
      return { error: false, label: 'Loading…', tone: statusPillInfo };
    }
    if (next.saving) {
      return { error: false, label: 'Saving…', tone: statusPillInfo };
    }
    if (next.conflict) {
      return { error: true, label: 'Changed on disk', tone: statusPillDanger };
    }
    if (next.error !== null) {
      return { error: true, label: next.error, tone: statusPillDanger };
    }
    if (next.message === 'SKILL.md saved; newer edits remain unsaved.') {
      return { error: false, label: next.message, tone: statusPillWarn };
    }
    if (next.message !== null && next.message !== 'SKILL.md saved.') {
      return { error: true, label: next.message, tone: statusPillDanger };
    }
    if (next.dirty) {
      return { error: false, label: 'Unsaved changes', tone: statusPillWarn };
    }
    return { error: false, label: 'Saved', tone: statusPillOk };
  };
  const status = $derived(documentStatus(editorState));

  const saveDraft = async (): Promise<void> => {
    await editorController.save();
  };
  const reloadFromDisk = async (): Promise<void> => {
    if (editorState.dirty) {
      reloadRequested = true;
      return;
    }
    await editorController.refresh();
  };
  const keepEditing = (): void => {
    reloadRequested = false;
  };
  const discardAndReload = async (): Promise<void> => {
    editorController.discardDraft();
    reloadRequested = false;
    await editorController.refresh();
  };
  const handleShortcut = async (event: KeyboardEvent): Promise<void> => {
    if (!isSkillMarkdownSaveShortcut(event)) {
      return;
    }
    event.preventDefault();
    if (editorState.dirty && !editorState.saving && !editorState.conflict) {
      await saveDraft();
    }
  };
</script>

<section
  {...(editorState.loading ||
  editorState.saving ||
  (editorState.document === undefined && editorState.error === null)
    ? { 'aria-busy': 'true' as const }
    : {})}
  class={editorSection}
  data-skill-markdown-editor
>
  <div class={documentToolbar}>
    <h3 class={strongCell}>SKILL.md</h3>
    {#if status.error}
      <span class={cx(statusPill, status.tone)} role="alert">{status.label}</span>
    {:else}
      <span aria-live="polite" class={cx(statusPill, status.tone)}>{status.label}</span>
    {/if}
  </div>
  {#if editorState.document}
    <textarea
      aria-label={`${editorState.skillName} SKILL.md`}
      class={editorArea}
      disabled={editorState.saving}
      oninput={(event) => editorController.setDraft(event.currentTarget.value)}
      onkeydown={handleShortcut}
      wrap="soft"
      bind:this={editorElement}
      bind:value={draftValue}
    ></textarea>
  {:else}
    <div aria-hidden="true" class={loadingBlock}></div>
  {/if}
  <div class={documentActions}>
    <button
      {...(editorState.saving ? { 'aria-busy': 'true' as const } : {})}
      class={commandButton}
      disabled={editorState.document === undefined ||
        !editorState.dirty ||
        editorState.loading ||
        editorState.saving ||
        editorState.conflict}
      onclick={saveDraft}
      type="button"
    >
      Save
    </button>
    <button
      class={ghostButton}
      disabled={!editorState.dirty || editorState.loading || editorState.saving}
      onclick={editorController.discardDraft}
      type="button"
    >
      Revert changes
    </button>
    <button
      class={ghostButton}
      disabled={editorState.loading || editorState.saving || editorState.skillName === ''}
      onclick={reloadFromDisk}
      type="button"
    >
      Reload from disk
    </button>
  </div>
  <DiscardConfirmationDialog
    description="Your SKILL.md draft has not been saved. Discarding it cannot be undone."
    idPrefix="discard-skill-draft"
    onDiscard={discardAndReload}
    onKeep={keepEditing}
    open={reloadRequested}
    restoreFocus={focusEditor}
  />
</section>
