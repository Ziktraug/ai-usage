<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { tick } from 'svelte';

  let {
    onDiscard,
    onKeep,
    open,
  }: {
    onDiscard: () => Promise<void>;
    onKeep: () => void;
    open: boolean;
  } = $props();

  let keepButton = $state<HTMLButtonElement>();
  let discardButton = $state<HTMLButtonElement>();
  let pending = $state(false);

  const backdrop = css({
    position: 'fixed',
    inset: 0,
    zIndex: 80,
    display: 'grid',
    placeItems: 'center',
    p: '20px',
    bg: 'rgba(0, 0, 0, 0.48)',
  });
  const dialog = css({
    display: 'grid',
    gap: '12px',
    w: 'min(100%, 430px)',
    p: '20px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surface',
    boxShadow: '0 20px 54px rgba(0, 0, 0, 0.3)',
  });
  const actions = css({ display: 'flex', justifyContent: 'flex-end', gap: '8px' });
  const button = css({
    minH: '38px',
    px: '12px',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    bg: 'surface',
    color: 'ink',
    fontWeight: 700,
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });

  const discard = async (): Promise<void> => {
    pending = true;
    try {
      await onDiscard();
    } finally {
      pending = false;
    }
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault();
      event.stopPropagation();
      onKeep();
      return;
    }
    if (event.key !== 'Tab') {
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
      pending = false;
      return;
    }
    tick().then(() => keepButton?.focus());
    document.addEventListener('keydown', onKeydown, true);
    return () => document.removeEventListener('keydown', onKeydown, true);
  });
</script>

{#if open}
  <div class={backdrop}>
    <div
      aria-describedby="discard-navigation-description"
      aria-labelledby="discard-navigation-title"
      aria-modal="true"
      class={dialog}
      role="alertdialog"
    >
      <h2 id="discard-navigation-title">Discard unsaved changes?</h2>
      <p id="discard-navigation-description">Your unsaved draft will be lost if you leave this page.</p>
      <div class={actions}>
        <button class={button} disabled={pending} onclick={onKeep} type="button" bind:this={keepButton}>
          Keep editing
        </button>
        <button class={button} disabled={pending} onclick={discard} type="button" bind:this={discardButton}>
          {pending ? 'Discarding…' : 'Discard changes'}
        </button>
      </div>
    </div>
  </div>
{/if}
