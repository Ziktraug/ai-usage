import { tick } from 'svelte';

/** A campaign virtual list that can bring a row into view and focus it. */
export interface CampaignFocusTarget {
  readonly focusKey: (key: string) => Promise<boolean>;
}

/** The two ends of a navigation, as `beforeNavigate` reports them. */
export interface CampaignNavigationEnds {
  readonly from?: { readonly url: URL } | null;
  readonly to?: { readonly url: URL } | null;
}

export interface CampaignFocusRestorationOptions {
  readonly campaignView: () => 'list' | 'timeline';
  readonly pathname: () => string;
  readonly searchExpanded: () => boolean;
  readonly selectedSessionId: () => string;
}

/**
 * A direct mobile link can close onto the campaign list while the Map is
 * hidden. Focus the visible viewport without revealing or acquiring rows.
 */
const focusVisibleCampaignSurface = (): void => {
  const visibleSurfaces = [...document.querySelectorAll<HTMLElement>('[data-campaign-scroll]')].filter(
    (element) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' &&
      !element.closest('[hidden], [inert]'),
  );
  if (!visibleSurfaces.some((element) => element === document.activeElement)) {
    visibleSurfaces[0]?.focus({ preventScroll: true });
  }
};

/**
 * Returns keyboard focus to the row a session panel was opened from once the panel closes. A
 * navigation or the page's destruction while a restoration waits for the DOM cancels it. The
 * component registers `beforeNavigate`, `afterNavigate` and `onDestroy` with these handlers; the
 * virtual lists bind themselves to the three list targets.
 */
export const createCampaignFocusRestoration = (options: CampaignFocusRestorationOptions) => {
  let pendingFocus = '';
  let detailOpenerId = $state('');
  let focusRestoreGeneration = 0;
  let mapVirtualList = $state<CampaignFocusTarget>();
  let timelineVirtualList = $state<CampaignFocusTarget>();
  let searchVirtualList = $state<CampaignFocusTarget>();

  /** A restoration that started at `generation` no longer applies once a session is open or the page left. */
  const superseded = (generation: number): boolean =>
    generation !== focusRestoreGeneration ||
    Boolean(options.selectedSessionId()) ||
    options.pathname() !== '/campaigns';

  const restoreFocus = async (): Promise<void> => {
    if (!pendingFocus) {
      return;
    }
    const key = pendingFocus;
    pendingFocus = '';
    const generation = focusRestoreGeneration;
    await tick();
    if (superseded(generation)) {
      return;
    }
    detailOpenerId = '';
    let restored = false;
    if (options.searchExpanded()) {
      restored = (await searchVirtualList?.focusKey(key)) ?? false;
    } else {
      const direct = document.querySelector<HTMLElement>(`[data-matching-row-id="${CSS.escape(key)}"]`);
      if (direct) {
        direct.focus({ preventScroll: true });
        restored = document.activeElement === direct;
      } else {
        restored =
          (await (options.campaignView() === 'timeline' ? timelineVirtualList : mapVirtualList)?.focusKey(key)) ??
          false;
      }
    }
    if (restored || superseded(generation)) {
      return;
    }
    focusVisibleCampaignSurface();
  };

  return {
    /** The `beforeNavigate` handler: closing a session panel on the page marks its row for focus. */
    beforeNavigate: (navigation: CampaignNavigationEnds): void => {
      focusRestoreGeneration += 1;
      const from = navigation.from?.url;
      const to = navigation.to?.url;
      if (from?.pathname === '/campaigns' && to?.pathname === '/campaigns' && !to.searchParams.has('selectedSession')) {
        pendingFocus = detailOpenerId || from.searchParams.get('selectedSession') || '';
      }
    },
    /** The `onDestroy` handler: a restoration still waiting for the DOM no longer applies. */
    destroy: (): void => {
      focusRestoreGeneration += 1;
    },
    /** The row a session panel was opened from, kept for focus once the panel closes. */
    get detailOpenerId(): string {
      return detailOpenerId;
    },
    set detailOpenerId(value: string) {
      detailOpenerId = value;
    },
    get mapVirtualList(): CampaignFocusTarget | undefined {
      return mapVirtualList;
    },
    set mapVirtualList(value: CampaignFocusTarget | undefined) {
      mapVirtualList = value;
    },
    /** The row to focus after the next navigation; set when the page closes a panel itself. */
    get pendingFocus(): string {
      return pendingFocus;
    },
    set pendingFocus(value: string) {
      pendingFocus = value;
    },
    /** The `afterNavigate` work: focus the pending row, or a visible campaign viewport. */
    restoreFocus,
    get searchVirtualList(): CampaignFocusTarget | undefined {
      return searchVirtualList;
    },
    set searchVirtualList(value: CampaignFocusTarget | undefined) {
      searchVirtualList = value;
    },
    get timelineVirtualList(): CampaignFocusTarget | undefined {
      return timelineVirtualList;
    },
    set timelineVirtualList(value: CampaignFocusTarget | undefined) {
      timelineVirtualList = value;
    },
  };
};

export type CampaignFocusRestoration = ReturnType<typeof createCampaignFocusRestoration>;
