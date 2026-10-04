<!-- biome-ignore-all lint/a11y/useValidAriaValues: Virtual positions are integers derived from array indexes and lengths. -->
<script generics="Row extends CampaignVirtualRow" lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { onMount, type Snippet, tick, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import {
    type CampaignScrollState,
    type CampaignVirtualRow,
    campaignAnchorFor,
    campaignOffsets,
    campaignRestoreAnchor,
    campaignVirtualWindow,
    createCampaignAcquisitionBudget,
  } from './campaign-virtual-window';

  let {
    rows,
    children,
    label,
    surface,
    estimate = 100,
    navigation = $bindable({}),
    onRange,
    onNearEnd,
    footer,
  }: {
    rows: readonly Row[];
    children: Snippet<[Row, number]>;
    label: string;
    surface: 'list' | 'map' | 'timeline' | 'search';
    estimate?: number;
    navigation?: CampaignScrollState;
    onRange?: (start: number, end: number) => boolean;
    onNearEnd?: () => boolean;
    footer?: Snippet;
  } = $props();
  let element = $state<HTMLElement>();
  let top = $state(0);
  let viewport = $state(500);
  let availableHeight = $state(500);
  let active = $state(false);
  let acquisition = $state(createCampaignAcquisitionBudget());
  const heights = new SvelteMap<string, number>();
  let previousKeys: readonly string[] = [];
  let layoutVersion = 0;
  let programmaticTop: number | null = null;
  let scrollIntentUntil = 0;
  const keys = $derived(rows.map((row) => row.key));
  const offsets = $derived(campaignOffsets(keys, heights, estimate));
  const renderWindow = $derived(campaignVirtualWindow(offsets, top, viewport));
  const total = $derived(offsets.at(-1) ?? 0);
  const visible = (host: HTMLElement): boolean =>
    host.isConnected &&
    !document.hidden &&
    host.getClientRects().length > 0 &&
    getComputedStyle(host).visibility !== 'hidden' &&
    !host.closest('[hidden], [inert]');
  const advance = (): void => {
    acquisition = createCampaignAcquisitionBudget();
  };
  const capture = (): void => {
    if (!(element && visible(element))) {
      return;
    }
    const nextTop = element.scrollTop;
    const moved = Math.abs(nextTop - top) > 0.5;
    const programmed = programmaticTop !== null && Math.abs(nextTop - programmaticTop) < 1;
    programmaticTop = null;
    if (moved && !programmed && performance.now() < scrollIntentUntil) {
      advance();
      scrollIntentUntil = performance.now() + 1500;
    }
    top = nextTop;
    const anchor = campaignAnchorFor(keys, offsets, top);
    if (anchor) {
      navigation = { ...navigation, anchor };
    }
  };
  const scrollTo = (host: HTMLElement, position: number): void => {
    host.scrollTop = position;
    programmaticTop = host.scrollTop;
    top = host.scrollTop;
  };
  const measure = (node: HTMLElement) => {
    const resize = new ResizeObserver(() => {
      const key = node.dataset.virtualKey;
      const height = node.getBoundingClientRect().height;
      if (key && height > 0 && Math.abs((heights.get(key) ?? estimate) - height) > 0.5) {
        heights.set(key, height);
      }
    });
    resize.observe(node);
    return { destroy: () => resize.disconnect() };
  };
  const focusable = (row: HTMLElement): HTMLElement[] =>
    [
      ...row.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((control) => control.tabIndex >= 0 && control.getClientRects().length > 0);
  export const focusKey = async (key: string, last = false): Promise<boolean> => {
    const host = element;
    if (!(host && visible(host))) {
      return false;
    }
    const index = keys.indexOf(key);
    if (index < 0) {
      host.focus({ preventScroll: true });
      return false;
    }
    const start = offsets[index] ?? 0;
    const end = offsets[index + 1] ?? start;
    if (start < top || end > top + viewport) {
      scrollTo(host, start);
      const anchor = campaignAnchorFor(keys, offsets, top);
      if (anchor) {
        navigation = { ...navigation, anchor };
      }
    }
    await tick();
    if (!visible(host)) {
      return false;
    }
    const row = host.querySelector<HTMLElement>(`[data-virtual-key="${CSS.escape(key)}"]`);
    if (!row) {
      host.focus({ preventScroll: true });
      return false;
    }
    const controls = focusable(row);
    const target = (last ? controls.at(-1) : controls[0]) ?? row;
    target.focus({ preventScroll: true });
    navigation = { ...navigation, focusKey: key };
    return document.activeElement === target;
  };
  const keydown = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLElement) || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (event.target.matches('input, textarea, select, [contenteditable="true"]')) {
      return;
    }
    const row = event.target.closest<HTMLElement>('[data-virtual-key]');
    const index = keys.indexOf(row?.dataset.virtualKey ?? '');
    if (index < 0) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = keys[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        event.preventDefault();
        advance();
        focusKey(next);
      }
    } else if (event.key === 'Tab' && row) {
      const controls = focusable(row);
      const edge = event.shiftKey ? controls[0] : controls.at(-1);
      const nextIndex = index + (event.shiftKey ? -1 : 1);
      const next = keys[nextIndex];
      if (event.target === edge && next && (nextIndex < renderWindow.start || nextIndex >= renderWindow.end)) {
        event.preventDefault();
        advance();
        focusKey(next, event.shiftKey);
      }
    }
  };
  $effect.pre(() => {
    const layout = offsets;
    const currentKeys = keys;
    const host = element;
    const enabled = active;
    const windowStart = renderWindow.start;
    const windowEnd = renderWindow.end;
    if (!(host && enabled)) {
      return;
    }
    const version = ++layoutVersion;
    const oldKeys = previousKeys;
    const anchor = untrack(() => navigation.anchor);
    const restored = anchor ? campaignRestoreAnchor(anchor, currentKeys, layout, oldKeys) : null;
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>('[data-virtual-key]')
        : null;
    const focusedKey = focused && host.contains(focused) ? focused.dataset.virtualKey : undefined;
    const focusIndex = focusedKey ? currentKeys.indexOf(focusedKey) : -1;
    const removedFocus =
      focusedKey && focusIndex < 0
        ? campaignRestoreAnchor({ key: focusedKey, offset: 0 }, currentKeys, layout, oldKeys)?.anchor.key
        : undefined;
    if (currentKeys !== previousKeys) {
      const retained = new Set(currentKeys);
      untrack(() => {
        for (const key of heights.keys()) {
          if (!retained.has(key)) {
            heights.delete(key);
          }
        }
      });
      previousKeys = currentKeys;
    }
    tick().then(() => {
      if (version !== layoutVersion || !visible(host)) {
        return;
      }
      if (restored) {
        scrollTo(host, restored.top);
        navigation = { ...navigation, anchor: restored.anchor };
      }
      if (focusedKey && focusIndex < 0) {
        if (removedFocus) {
          focusKey(removedFocus);
        } else {
          host.focus({ preventScroll: true });
        }
      } else if (focusedKey && (focusIndex < windowStart || focusIndex >= windowEnd)) {
        // Scrolling can unmount a focused row; keep a deliberate fallback in this region.
        host.focus({ preventScroll: true });
      }
    });
  });
  $effect(() => {
    if (!active || viewport <= 0 || !element || !visible(element)) {
      return;
    }
    if (onRange) {
      acquisition.run(() => onRange?.(renderWindow.start, renderWindow.end));
    }
    if (total - top - viewport < viewport * 0.75) {
      acquisition.run(onNearEnd);
    }
  });
  onMount(() => {
    if (!element) {
      return;
    }
    const host = element;
    let frame = 0;
    let windowWidth = window.innerWidth;
    let windowHeight = window.innerHeight;
    const syncViewport = (): void => {
      frame = 0;
      active = visible(host);
      if (!active) {
        return;
      }
      const reserve = window.innerWidth < 768 ? 88 : 40;
      availableHeight = Math.max(220, Math.floor(window.innerHeight - host.getBoundingClientRect().top - reserve));
      viewport = host.clientHeight;
      if (!navigation.anchor) {
        capture();
      }
    };
    const scheduleViewport = (): void => {
      if (!frame) {
        frame = requestAnimationFrame(syncViewport);
      }
    };
    const resizeWindow = (): void => {
      if (windowWidth !== window.innerWidth || windowHeight !== window.innerHeight) {
        windowWidth = window.innerWidth;
        windowHeight = window.innerHeight;
        advance();
      }
      scheduleViewport();
    };
    const intent = (): void => {
      scrollIntentUntil = performance.now() + 1500;
    };
    const focusin = (event: FocusEvent): void => {
      const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-virtual-key]') : null;
      if (row?.dataset.virtualKey) {
        navigation = { ...navigation, focusKey: row.dataset.virtualKey };
      }
    };
    const resize = new ResizeObserver(scheduleViewport);
    const mutations = new MutationObserver(scheduleViewport);
    for (let ancestor: HTMLElement | null = host; ancestor; ancestor = ancestor.parentElement) {
      resize.observe(ancestor);
      mutations.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'] });
    }
    host.addEventListener('keydown', keydown);
    host.addEventListener('keydown', intent);
    host.addEventListener('wheel', intent, { passive: true });
    host.addEventListener('touchmove', intent, { passive: true });
    host.addEventListener('pointerdown', intent, { passive: true });
    host.addEventListener('focusin', focusin);
    window.addEventListener('resize', resizeWindow);
    document.addEventListener('visibilitychange', scheduleViewport);
    syncViewport();
    return () => {
      layoutVersion += 1;
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      host.removeEventListener('keydown', keydown);
      host.removeEventListener('keydown', intent);
      host.removeEventListener('wheel', intent);
      host.removeEventListener('touchmove', intent);
      host.removeEventListener('pointerdown', intent);
      host.removeEventListener('focusin', focusin);
      window.removeEventListener('resize', resizeWindow);
      document.removeEventListener('visibilitychange', scheduleViewport);
    };
  });
  const list = css({ listStyleType: 'none', m: 0, p: 0 });
  const scroller = css({
    overflowY: 'auto',
    overflowX: 'hidden',
    overflowAnchor: 'none',
    minW: 0,
    minH: '220px',
    overscrollBehaviorY: 'contain',
    scrollbarGutter: 'stable',
    _focusVisible: { outline: '2px solid token(colors.accent)' },
  });
</script>

<section
  aria-label={label}
  class={scroller}
  data-campaign-scroll={surface}
  data-loaded-rows={rows.length}
  onscroll={capture}
  tabindex="-1"
  bind:this={element}
  style:height={`${availableHeight}px`}
>
  <ul aria-label={label} class={list}>
    <li aria-hidden="true" role="presentation" style:height={`${offsets[renderWindow.start] ?? 0}px`}></li>
    {#each rows.slice(renderWindow.start, renderWindow.end) as row, index (row.key)}
      <li
        aria-posinset={renderWindow.start + index + 1}
        aria-setsize={rows.length}
        data-virtual-key={row.key}
        tabindex="-1"
        use:measure
      >
        {@render children(row, renderWindow.start + index)}
      </li>
    {/each}
    <li
      aria-hidden="true"
      role="presentation"
      style:height={`${Math.max(0, total - (offsets[renderWindow.end] ?? 0))}px`}
    ></li>
  </ul>
  {#if footer}
    {@render footer()}
  {/if}
</section>
