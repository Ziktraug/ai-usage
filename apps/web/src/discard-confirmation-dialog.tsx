import { css } from '@ai-usage/design-system/css';
import { commandButton, ghostButton, panelHeader, panelSub, panelTitle } from '@ai-usage/design-system/report';
import { onCleanup, onMount } from 'solid-js';

const dialogOverlay = css({
  position: 'fixed',
  inset: 0,
  zIndex: 30,
  display: 'grid',
  placeItems: 'center',
  p: '18px',
  bg: 'rgba(0, 0, 0, 0.55)',
});

const dialogPanel = css({
  display: 'grid',
  gap: '14px',
  w: 'min(440px, 100%)',
  p: '18px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'lg',
});

const dialogActions = css({
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: '8px',
  alignItems: 'center',
});

const focusableSelector = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export const DiscardConfirmationDialog = (props: {
  description: string;
  idPrefix: string;
  onDiscard: () => Promise<void> | void;
  onKeep: () => void;
  restoreFocus?: () => void;
}) => {
  let dialogElement: HTMLElement | undefined;
  let keepButtonElement: HTMLButtonElement | undefined;

  onMount(() => {
    const returnFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    window.queueMicrotask(() => keepButtonElement?.focus());

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        props.onKeep();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }

      const focusableElements = dialogElement?.querySelectorAll<HTMLElement>(focusableSelector);
      const firstElement = focusableElements?.item(0);
      const lastElement = focusableElements?.item((focusableElements?.length ?? 0) - 1);
      if (!(firstElement && lastElement)) {
        event.preventDefault();
        return;
      }

      const focusIsOutsideDialog = !(dialogElement?.contains(document.activeElement) ?? false);
      if (event.shiftKey && (document.activeElement === firstElement || focusIsOutsideDialog)) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && (document.activeElement === lastElement || focusIsOutsideDialog)) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    onCleanup(() => {
      document.removeEventListener('keydown', handleKeyDown);
      window.queueMicrotask(() => {
        if (props.restoreFocus !== undefined) {
          props.restoreFocus();
        } else if (returnFocusElement?.isConnected) {
          returnFocusElement.focus();
        }
      });
    });
  });

  const titleId = `${props.idPrefix}-title`;
  const descriptionId = `${props.idPrefix}-description`;

  return (
    <div class={dialogOverlay}>
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        class={dialogPanel}
        ref={(element) => {
          dialogElement = element;
        }}
        role="alertdialog"
      >
        <div class={panelHeader}>
          <h2 class={panelTitle} id={titleId}>
            Discard unsaved changes?
          </h2>
          <p class={panelSub} id={descriptionId}>
            {props.description}
          </p>
        </div>
        <div class={dialogActions}>
          <button
            class={ghostButton}
            onClick={props.onKeep}
            ref={(element) => {
              keepButtonElement = element;
            }}
            type="button"
          >
            Keep editing
          </button>
          <button class={commandButton} onClick={props.onDiscard} type="button">
            Discard changes
          </button>
        </div>
      </section>
    </div>
  );
};
