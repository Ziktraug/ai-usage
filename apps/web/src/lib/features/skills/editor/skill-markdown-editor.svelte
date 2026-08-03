<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { commandButton } from '@ai-usage/design-system/svelte';
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
  let state = $state(editorController.getState());
  let editorElement = $state<HTMLTextAreaElement>();
  let reloadRequested = $state(false);
  const stopState = editorController.subscribe((next) => {
    state = next;
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
    gridTemplateAreas: { base: '"header" "editor" "actions"', md: '"header actions" "editor editor"' },
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
  const titleStyle = css({ fontWeight: 700 });
  const ghostButton = css({
    minH: '36px',
    px: '11px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    color: 'ink',
    fontWeight: 650,
    _disabled: { cursor: 'not-allowed', opacity: 0.55 },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const statusPill = css({
    display: 'inline-flex',
    alignItems: 'center',
    minH: '24px',
    px: '8px',
    borderRadius: 'full',
    fontSize: '12px',
    fontWeight: 700,
  });
  const statusInfo = css({ bg: 'surface', color: 'muted' });
  const statusDanger = css({ bg: 'status.dangerSoft', color: 'status.danger' });
  const statusWarn = css({ bg: 'status.warnSoft', color: 'status.warn' });
  const statusOk = css({ bg: 'status.okSoft', color: 'status.ok' });

  interface DocumentStatus {
    readonly error: boolean;
    readonly label: string;
    readonly tone: string;
  }
  const documentStatus = (next: SkillMarkdownEditorState): DocumentStatus => {
    if (next.loading || (next.document === undefined && next.error === null)) {
      return { error: false, label: 'Loading…', tone: statusInfo };
    }
    if (next.saving) {
      return { error: false, label: 'Saving…', tone: statusInfo };
    }
    if (next.conflict) {
      return { error: true, label: 'Changed on disk', tone: statusDanger };
    }
    if (next.error !== null) {
      return { error: true, label: next.error, tone: statusDanger };
    }
    if (next.message === 'SKILL.md saved; newer edits remain unsaved.') {
      return { error: false, label: next.message, tone: statusWarn };
    }
    if (next.message !== null && next.message !== 'SKILL.md saved.') {
      return { error: true, label: next.message, tone: statusDanger };
    }
    if (next.dirty) {
      return { error: false, label: 'Unsaved changes', tone: statusWarn };
    }
    return { error: false, label: 'Saved', tone: statusOk };
  };
  const status = $derived(documentStatus(state));

  const saveDraft = async (): Promise<void> => {
    await editorController.save();
  };
  const reloadFromDisk = async (): Promise<void> => {
    if (state.dirty) {
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
    if (state.dirty && !state.saving && !state.conflict) {
      await saveDraft();
    }
  };
</script>

<section
  {...(state.loading || state.saving || (state.document === undefined && state.error === null)
    ? { 'aria-busy': 'true' as const }
    : {})}
  class={editorSection}
  data-skill-markdown-editor
>
  <div class={documentToolbar}>
    <h3 class={titleStyle}>SKILL.md</h3>
    {#if status.error}
      <span class={cx(statusPill, status.tone)} role="alert">{status.label}</span>
    {:else}
      <span aria-live="polite" class={cx(statusPill, status.tone)}>{status.label}</span>
    {/if}
  </div>
  {#if state.document}
    <textarea
      aria-label={`${state.skillName} SKILL.md`}
      class={editorArea}
      disabled={state.saving}
      oninput={(event) => editorController.setDraft(event.currentTarget.value)}
      onkeydown={handleShortcut}
      value={state.draft}
      wrap="soft"
      bind:this={editorElement}
    ></textarea>
  {:else}
    <div aria-hidden="true" class={loadingBlock}></div>
  {/if}
  <div class={documentActions}>
    <button
      {...(state.saving ? { 'aria-busy': 'true' as const } : {})}
      class={commandButton}
      disabled={state.document === undefined || !state.dirty || state.loading || state.saving || state.conflict}
      onclick={saveDraft}
      type="button"
    >
      Save
    </button>
    <button
      class={ghostButton}
      disabled={!state.dirty || state.loading || state.saving}
      onclick={editorController.discardDraft}
      type="button"
    >
      Revert changes
    </button>
    <button
      class={ghostButton}
      disabled={state.loading || state.saving || state.skillName === ''}
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
