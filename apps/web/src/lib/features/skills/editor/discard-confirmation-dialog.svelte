<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { commandButton, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import { onDestroy, tick } from 'svelte';
  import { createDiscardDialogController } from './discard-dialog-controller';

  let {
    description,
    idPrefix,
    onDiscard,
    onKeep,
    open,
    restoreFocus,
  }: {
    description: string;
    idPrefix: string;
    onDiscard: () => Promise<void> | void;
    onKeep: () => void;
    open: boolean;
    restoreFocus?: () => void;
  } = $props();

  let keepButton = $state<HTMLButtonElement>();
  let discardButton = $state<HTMLButtonElement>();
  const decision = createDiscardDialogController({
    onDiscard: async () => await onDiscard(),
    onKeep: () => onKeep(),
  });
  let pending = $state(decision.pending.getState());
  const stopPending = decision.pending.subscribe((next) => {
    pending = next;
  });
  onDestroy(stopPending);

  const backdrop = css({
    position: 'fixed',
    inset: 0,
    zIndex: 80,
    display: 'grid',
    placeItems: 'center',
    p: '18px',
    bg: 'rgba(0, 0, 0, 0.55)',
  });
  const dialog = css({
    display: 'grid',
    gap: '14px',
    w: 'min(440px, 100%)',
    p: '18px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: 'lg',
  });
  const actions = css({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: '8px',
    alignItems: 'center',
  });
  const keepButtonStyle = css({
    minH: '38px',
    px: '12px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surface',
    color: 'ink',
    fontWeight: 700,
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      decision.keep();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    if (pending) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const activeElement = document.activeElement;
    const focusIsOutside = activeElement !== keepButton && activeElement !== discardButton;
    const reverseFromKeep = event.shiftKey && activeElement === keepButton;
    const forwardFromDiscard = !event.shiftKey && activeElement === discardButton;
    if (focusIsOutside || reverseFromKeep || forwardFromDiscard) {
      event.preventDefault();
      event.stopPropagation();
      (event.shiftKey ? discardButton : keepButton)?.focus();
    }
  };

  $effect(() => {
    if (!open) {
      return;
    }
    const returnFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    tick().then(() => keepButton?.focus());
    document.addEventListener('keydown', onKeydown, true);
    return () => {
      document.removeEventListener('keydown', onKeydown, true);
      queueMicrotask(() => {
        if (restoreFocus) {
          restoreFocus();
        } else if (returnFocusElement?.isConnected) {
          returnFocusElement.focus();
        }
      });
    };
  });
</script>

{#if open}
  <div class={backdrop}>
    <div
      aria-describedby={`${idPrefix}-description`}
      aria-labelledby={`${idPrefix}-title`}
      aria-modal="true"
      class={dialog}
      role="alertdialog"
    >
      <h2 class={panelTitle} id={`${idPrefix}-title`}>Discard unsaved changes?</h2>
      <p class={panelSub} id={`${idPrefix}-description`}>{description}</p>
      <div class={actions}>
        <button class={keepButtonStyle} disabled={pending} onclick={decision.keep} type="button" bind:this={keepButton}>
          Keep editing
        </button>
        <button
          {...(pending ? { 'aria-busy': 'true' as const } : {})}
          class={commandButton}
          disabled={pending}
          onclick={decision.discard}
          type="button"
          bind:this={discardButton}
        >
          {pending ? 'Discarding…' : 'Discard changes'}
        </button>
      </div>
    </div>
  </div>
{/if}
