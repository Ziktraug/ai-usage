<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tooltipContentClass } from './styles';

  interface Props {
    children: Snippet;
    content: Snippet | string;
    contentClass?: string;
    openDelay?: number;
  }

  let { children, content, contentClass, openDelay = 300 }: Props = $props();

  const propsId = $props.id();
  const tooltipId = `ai-usage-tooltip-${propsId}`;

  const TOOLTIP_GUTTER_PX = 4;
  const VIEWPORT_EDGE_PADDING_PX = 4;
  const WHITESPACE_PATTERN = /\s+/u;
  const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const ROLE_BEARING_SELECTOR = '[role]:not([role="presentation"]):not([role="none"])';

  let tooltipElement = $state<HTMLSpanElement | null>(null);
  let triggerElement = $state<HTMLSpanElement | null>(null);
  let isOpen = $state(false);
  let hasFocus = false;
  let hasHover = false;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let topPosition = $state(0);
  let leftPosition = $state(0);
  let placement: 'top' | 'bottom' = $state('top');

  const clearOpenTimer = (): void => {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  };

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

  const resolveDescribedByTarget = (host: HTMLElement | null): HTMLElement | null => {
    if (!host) {
      return null;
    }
    const focusable = host.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable) {
      return focusable;
    }
    const roleTarget = host.querySelector<HTMLElement>(ROLE_BEARING_SELECTOR);
    if (roleTarget) {
      return roleTarget;
    }
    const firstChild = host.firstElementChild;
    return firstChild instanceof HTMLElement ? firstChild : null;
  };

  const computePlacement = (): void => {
    if (!tooltipElement || typeof window === 'undefined') {
      return;
    }
    const positionTarget = resolveDescribedByTarget(triggerElement) ?? triggerElement;
    if (!positionTarget) {
      return;
    }
    const triggerRect = positionTarget.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const contentHeight = tooltipElement.getBoundingClientRect().height;
    const fitsAbove = triggerRect.top - contentHeight - TOOLTIP_GUTTER_PX >= VIEWPORT_EDGE_PADDING_PX;
    const fitsBelow =
      triggerRect.bottom + contentHeight + TOOLTIP_GUTTER_PX <= viewportHeight - VIEWPORT_EDGE_PADDING_PX;
    if (fitsAbove) {
      placement = 'top';
    } else if (fitsBelow) {
      placement = 'bottom';
    } else {
      placement = triggerRect.top >= viewportHeight - triggerRect.bottom ? 'top' : 'bottom';
    }
  };

  const computePosition = (): void => {
    if (!tooltipElement || typeof window === 'undefined') {
      return;
    }
    const positionTarget = resolveDescribedByTarget(triggerElement) ?? triggerElement;
    if (!positionTarget) {
      return;
    }
    const triggerRect = positionTarget.getBoundingClientRect();
    const tooltipRect = tooltipElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const desiredCenterX = triggerRect.left + triggerRect.width / 2;
    const halfTooltipWidth = tooltipRect.width / 2;
    const minLeft = VIEWPORT_EDGE_PADDING_PX + halfTooltipWidth;
    const maxLeft = viewportWidth - VIEWPORT_EDGE_PADDING_PX - halfTooltipWidth;
    leftPosition = Math.max(minLeft, Math.min(maxLeft, desiredCenterX));

    const desiredTop =
      placement === 'top'
        ? triggerRect.top - tooltipRect.height - TOOLTIP_GUTTER_PX
        : triggerRect.bottom + TOOLTIP_GUTTER_PX;
    const maxTop = Math.max(VIEWPORT_EDGE_PADDING_PX, viewportHeight - tooltipRect.height - VIEWPORT_EDGE_PADDING_PX);
    topPosition = Math.max(VIEWPORT_EDGE_PADDING_PX, Math.min(maxTop, desiredTop));
  };

  const updateDescriptionToken = (target: HTMLElement, shouldInclude: boolean): void => {
    const tokens = new Set((target.getAttribute('aria-describedby') ?? '').split(WHITESPACE_PATTERN).filter(Boolean));
    if (shouldInclude) {
      tokens.add(tooltipId);
    } else {
      tokens.delete(tooltipId);
    }
    const value = [...tokens].join(' ');
    if (value.length > 0) {
      target.setAttribute('aria-describedby', value);
    } else {
      target.removeAttribute('aria-describedby');
    }
  };

  const describeFocusable = (
    node: HTMLElement,
    descriptionId: string | null,
  ): { destroy: () => void; update: (nextId: string | null) => void } => {
    let currentId = descriptionId;
    let currentTarget: HTMLElement | null = null;
    const synchronize = (): void => {
      const nextTarget = resolveDescribedByTarget(node);
      if (currentTarget && currentTarget !== nextTarget) {
        updateDescriptionToken(currentTarget, false);
      }
      currentTarget = nextTarget;
      if (currentTarget) {
        updateDescriptionToken(currentTarget, currentId !== null);
      }
    };
    const observer = new MutationObserver(synchronize);
    observer.observe(node, {
      attributeFilter: ['disabled', 'role', 'tabindex'],
      attributes: true,
      childList: true,
      subtree: true,
    });
    synchronize();
    return {
      destroy(): void {
        observer.disconnect();
        if (currentTarget) {
          updateDescriptionToken(currentTarget, false);
        }
      },
      update(nextId: string | null): void {
        currentId = nextId;
        synchronize();
      },
    };
  };

  const show = (): void => {
    if (isOpen || openTimer !== null) {
      return;
    }
    clearOpenTimer();
    openTimer = setTimeout(() => {
      openTimer = null;
      isOpen = true;
    }, openDelay);
  };

  const hide = (): void => {
    clearOpenTimer();
    isOpen = false;
  };

  const onFocusIn = (): void => {
    hasFocus = true;
    show();
  };

  const onFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && triggerElement?.contains(event.relatedTarget)) {
      return;
    }
    hasFocus = false;
    if (!hasHover) {
      hide();
    }
  };

  const onMouseEnter = (): void => {
    hasHover = true;
    show();
  };

  const onMouseLeave = (): void => {
    hasHover = false;
    if (!hasFocus) {
      hide();
    }
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && isOpen) {
      hide();
    }
  };

  $effect(() => {
    if (isOpen) {
      queueMicrotask(() => {
        computePlacement();
        computePosition();
      });
      window.addEventListener('keydown', onKeydown);
      window.addEventListener('resize', hide);
      document.addEventListener('scroll', hide, { capture: true, passive: true });
      const resizeObserver = new ResizeObserver(() => {
        computePlacement();
        computePosition();
      });
      if (tooltipElement) {
        resizeObserver.observe(tooltipElement);
      }
      return () => {
        resizeObserver.disconnect();
        window.removeEventListener('keydown', onKeydown);
        window.removeEventListener('resize', hide);
        document.removeEventListener('scroll', hide, { capture: true });
      };
    }
  });

  $effect(() => () => clearOpenTimer());
</script>

<!-- biome-ignore lint/a11y/noStaticElementInteractions: This non-focusable owner delegates hover and focus events from the rendered trigger. -->
<span
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
  onmouseenter={onMouseEnter}
  onmouseleave={onMouseLeave}
  role="presentation"
  bind:this={triggerElement}
  use:describeFocusable={isOpen ? tooltipId : null}
>
  {@render children()}
</span>

{#if isOpen}
  <span
    class={contentClass ?? tooltipContentClass}
    data-placement={placement}
    id={tooltipId}
    role="tooltip"
    bind:this={tooltipElement}
    style:left={`${leftPosition}px`}
    style:max-height="calc(100vh - 8px)"
    style:max-width="calc(100vw - 8px)"
    style:overflow="auto"
    style:pointer-events="none"
    style:position="fixed"
    style:top={`${topPosition}px`}
    style:transform="translateX(-50%)"
    style:z-index="50"
    use:portalElement
  >
    {#if typeof content === 'string'}
      {content}
    {:else}
      {@render content()}
    {/if}
  </span>
{/if}

<style>
  @media (prefers-reduced-motion: reduce) {
    span[role="tooltip"] {
      animation: none !important;
    }
  }
</style>
