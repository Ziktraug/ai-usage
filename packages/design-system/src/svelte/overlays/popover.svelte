<script lang="ts">
  import { type Snippet, tick } from 'svelte';
  import { popoverContentClass } from './styles';

  interface Props {
    children: Snippet;
    closeOnInteract?: boolean;
    contentClass?: string;
    trigger: Snippet;
    triggerAriaLabel?: string;
    triggerClass?: string;
    triggerTitle?: string;
  }

  let {
    children,
    closeOnInteract = false,
    contentClass,
    trigger,
    triggerAriaLabel,
    triggerClass,
    triggerTitle,
  }: Props = $props();

  const propsId = $props.id();
  const popoverId = `ai-usage-popover-${propsId}`;

  const POPOVER_GUTTER_PX = 4;
  const VIEWPORT_EDGE_PADDING_PX = 4;
  const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  let popoverElement = $state<HTMLElement | null>(null);
  let triggerElement = $state<HTMLButtonElement | null>(null);
  let isMounted = $state(false);
  let isOpen = $state(false);
  let topPosition = $state(0);
  let leftPosition = $state(0);
  let placement: 'top' | 'bottom' = $state('bottom');
  const expandedProps = $derived({ 'aria-expanded': isOpen ? ('true' as const) : ('false' as const) });

  const portalElement = (node: HTMLElement): { destroy: () => void } => {
    document.body.appendChild(node);
    return {
      destroy(): void {
        if (node.parentElement === document.body) {
          document.body.removeChild(node);
        }
      },
    };
  };

  const closeOnContentInteraction = (node: HTMLElement): { destroy: () => void } => {
    node.addEventListener('click', onContentClick);
    return {
      destroy(): void {
        node.removeEventListener('click', onContentClick);
      },
    };
  };

  const computePlacement = (): void => {
    if (!(triggerElement && popoverElement) || typeof window === 'undefined') {
      return;
    }
    const triggerRect = triggerElement.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const contentHeight = popoverElement.getBoundingClientRect().height;
    const fitsBelow =
      triggerRect.bottom + contentHeight + POPOVER_GUTTER_PX <= viewportHeight - VIEWPORT_EDGE_PADDING_PX;
    const fitsAbove = triggerRect.top - contentHeight - POPOVER_GUTTER_PX >= VIEWPORT_EDGE_PADDING_PX;
    if (fitsBelow) {
      placement = 'bottom';
    } else if (fitsAbove) {
      placement = 'top';
    } else {
      placement = triggerRect.bottom + triggerRect.height / 2 < viewportHeight / 2 ? 'bottom' : 'top';
    }
  };

  const computePosition = (): void => {
    if (!(triggerElement && popoverElement) || typeof window === 'undefined') {
      return;
    }
    const triggerRect = triggerElement.getBoundingClientRect();
    const popoverRect = popoverElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const desiredCenterX = triggerRect.left + triggerRect.width / 2;
    const halfPopoverWidth = popoverRect.width / 2;
    const minLeft = VIEWPORT_EDGE_PADDING_PX + halfPopoverWidth;
    const maxLeft = viewportWidth - VIEWPORT_EDGE_PADDING_PX - halfPopoverWidth;
    leftPosition = Math.max(minLeft, Math.min(maxLeft, desiredCenterX));

    const desiredTop =
      placement === 'top'
        ? triggerRect.top - popoverRect.height - POPOVER_GUTTER_PX
        : triggerRect.bottom + POPOVER_GUTTER_PX;
    const maxTop = Math.max(VIEWPORT_EDGE_PADDING_PX, viewportHeight - popoverRect.height - VIEWPORT_EDGE_PADDING_PX);
    topPosition = Math.max(VIEWPORT_EDGE_PADDING_PX, Math.min(maxTop, desiredTop));
  };

  const focusFirstContentControl = (): void => {
    const firstFocusable = popoverElement?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();
  };

  const onTriggerClick = async (): Promise<void> => {
    if (isOpen) {
      popoverElement?.hidePopover();
      return;
    }
    isMounted = true;
    await tick();
    popoverElement?.showPopover();
  };

  const onToggle = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    isOpen = target.matches(':popover-open');
    if (isOpen) {
      queueMicrotask(() => {
        computePlacement();
        computePosition();
        focusFirstContentControl();
      });
    } else {
      isMounted = false;
    }
  };

  const onResize = (): void => {
    if (!isOpen) {
      return;
    }
    computePlacement();
    computePosition();
  };

  const onCaptureScroll = (): void => {
    if (!isOpen) {
      return;
    }
    computePlacement();
    computePosition();
  };

  const onContentClick = (): void => {
    if (!closeOnInteract) {
      return;
    }
    popoverElement?.hidePopover();
    triggerElement?.focus();
  };

  $effect(() => {
    if (!isOpen) {
      return;
    }
    window.addEventListener('resize', onResize);
    document.addEventListener('scroll', onCaptureScroll, { capture: true, passive: true });
    const resizeObserver = new ResizeObserver(() => {
      computePlacement();
      computePosition();
    });
    if (popoverElement) {
      resizeObserver.observe(popoverElement);
    }
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('scroll', onCaptureScroll, { capture: true });
    };
  });
</script>

<button
  {...expandedProps}
  aria-controls={popoverId}
  aria-haspopup="dialog"
  aria-label={triggerAriaLabel}
  class={triggerClass}
  id={`${popoverId}-trigger`}
  onclick={onTriggerClick}
  title={triggerTitle}
  type="button"
  bind:this={triggerElement}
>
  {@render trigger()}
</button>

{#if isMounted}
  <div
    aria-labelledby={`${popoverId}-trigger`}
    id={popoverId}
    ontoggle={onToggle}
    popover="auto"
    role="dialog"
    bind:this={popoverElement}
    style:left={`${leftPosition}px`}
    style:top={`${topPosition}px`}
    style:transform="translateX(-50%)"
    use:closeOnContentInteraction
    use:portalElement
  >
    {#if isOpen}
      <div class={contentClass ?? popoverContentClass}>
        {@render children()}
      </div>
    {/if}
  </div>
{/if}

<style>
  div[popover] {
    position: fixed;
    inset: auto;
    top: auto;
    right: auto;
    bottom: auto;
    left: auto;
    width: max-content;
    max-width: calc(100vw - 8px);
    max-height: calc(100vh - 8px);
    padding: 0;
    margin: 0;
    overflow: auto;
    color: inherit;
    background: transparent;
    border: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    div[popover] {
      animation: none !important;
    }
  }
</style>
