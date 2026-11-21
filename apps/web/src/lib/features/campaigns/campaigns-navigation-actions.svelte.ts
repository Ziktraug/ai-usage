import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
import { type DashboardSearch, dashboardSearchDefaultsFor } from '../../foundation/dashboard/dashboard-search';
import { dashboardUrlFor } from '../../foundation/navigation/svelte/dashboard-url';
import { panelOpenedFromReport, sessionPanelHistoryState } from '../sessions/detail/session-route';
import { dashboardSearchCodec } from '../shell/navigation';
import type { ShellNavigationOwner } from '../shell/navigation-owner-context';
import type { CampaignExplorationState } from './campaigns-exploration-state.svelte';
import { type CampaignRevision, filteredSearchFrom } from './campaigns-page-model';

export interface CampaignNavigationActionsOptions {
  /** The exploration fields a selection resets or reveals, and the restart onto the latest results. */
  readonly exploration: Pick<
    CampaignExplorationState,
    | 'automaticCampaign'
    | 'collapsedNodes'
    | 'mapNavigation'
    | 'matchingRestoration'
    | 'mobileMap'
    | 'restart'
    | 'searchNavigation'
  >;
  /** The session panel opener and the row to focus once the page closes the panel itself. */
  readonly focus: { detailOpenerId: string; pendingFocus: string };
  readonly goto: ShellNavigationOwner['goto'];
  /** The current page URL; each action edits a copy of it. */
  readonly href: () => string;
  readonly latest: () => CampaignRevision | null;
  readonly pageState: () => App.PageState;
  /** The current page URL as the dashboard URL helpers take it. */
  readonly pageUrl: () => URL;
  /** The revision a loaded row was read at; none for a row the page has not acquired. */
  readonly rowRevisionFor: (rowId: string) => string | undefined;
  readonly search: () => DashboardSearch;
  readonly selectedKey: () => string;
  readonly selectedSessionId: () => string;
  /** The row of the open session panel, when it is open. */
  readonly selectionRowId: () => string | undefined;
}

/**
 * The page's URL-driven actions: selecting a campaign, view, filters or session, and closing the
 * session panel. Each edits a copy of the current URL and navigates through the shell; a failed
 * navigation is reported in `navigationError`, never thrown.
 */
export const createCampaignNavigationActions = (options: CampaignNavigationActionsOptions) => {
  const { exploration, focus } = options;
  let navigationError = $state<string | null>(null);

  /** The shell goto is asynchronous: a failure arrives as its rejection, one microtask after it. */
  const navigate = (
    url: URL,
    navigationOptions: { readonly replace?: boolean; readonly state?: App.PageState } = {},
  ): void => {
    navigationError = null;
    options.goto(url, { reset: false, ...navigationOptions }).catch((cause: unknown) => {
      navigationError = cause instanceof Error ? cause.message : 'Campaign navigation failed.';
    });
  };

  const openSession = (row: Pick<SessionPresentationRow, 'rowId'>): void => {
    const selectedRevision = options.rowRevisionFor(row.rowId);
    if (!selectedRevision) {
      return;
    }
    exploration.mobileMap = true;
    if (!options.selectedSessionId()) {
      focus.detailOpenerId = row.rowId;
    }
    const url = new URL(options.href());
    url.searchParams.set('selectedCampaign', options.selectedKey());
    url.searchParams.set('selectedSession', row.rowId);
    const replacing = Boolean(options.selectedSessionId());
    navigate(url, {
      replace: replacing,
      state:
        replacing && !panelOpenedFromReport(options.pageState())
          ? options.pageState()
          : sessionPanelHistoryState(options.pageState()),
    });
  };

  return {
    applyFilters: (event: SubmitEvent): void => {
      event.preventDefault();
      if (!(event.currentTarget instanceof HTMLFormElement)) {
        return;
      }
      const next = filteredSearchFrom(options.search(), new FormData(event.currentTarget));
      const url = dashboardUrlFor(options.pageUrl(), next, dashboardSearchCodec);
      url.searchParams.delete('selectedCampaign');
      url.searchParams.delete('selectedSession');
      navigate(url);
    },
    /** Opens the given session, or closes the panel and returns focus to its row. */
    changeSelection: (next: { readonly row: Pick<SessionPresentationRow, 'rowId'> } | null): void => {
      if (next) {
        openSession(next.row);
        return;
      }
      focus.pendingFocus = options.selectionRowId() ?? options.selectedSessionId();
      if (panelOpenedFromReport(options.pageState())) {
        window.history.back();
        return;
      }
      const url = new URL(options.href());
      url.searchParams.delete('selectedSession');
      navigate(url, { replace: true });
    },
    clearFilters: (): void => {
      const url = dashboardUrlFor(options.pageUrl(), dashboardSearchDefaultsFor('date'), dashboardSearchCodec);
      url.searchParams.delete('selectedCampaign');
      url.searchParams.delete('selectedSession');
      navigate(url);
    },
    clearSelection: (): void => {
      exploration.automaticCampaign = '';
      const url = new URL(options.href());
      url.searchParams.delete('selectedCampaign');
      url.searchParams.delete('selectedSession');
      navigate(url);
    },
    /** Reports a focus restoration that failed after a navigation. */
    focusFailed: (cause: unknown): void => {
      navigationError = cause instanceof Error ? cause.message : 'Session focus could not be restored.';
    },
    get navigationError(): string | null {
      return navigationError;
    },
    openSession,
    /** Returns to the latest results from the top, closing the session panel. */
    restart: (): void => {
      exploration.restart(options.latest());
      const url = new URL(options.href());
      url.searchParams.delete('selectedSession');
      navigate(url);
    },
    selectCampaign: (campaignKey: string): void => {
      const url = new URL(options.href());
      url.searchParams.set('selectedCampaign', campaignKey);
      if (campaignKey !== options.selectedKey()) {
        exploration.matchingRestoration = null;
        exploration.searchNavigation = {};
        url.searchParams.delete('selectedSession');
        exploration.mapNavigation = {};
        exploration.collapsedNodes = new Set();
      }
      exploration.mobileMap = true;
      navigate(url);
    },
    selectView: (view: 'list' | 'timeline'): void => {
      const url = new URL(options.href());
      if (view === 'timeline') {
        url.searchParams.set('campaignView', 'timeline');
      } else {
        url.searchParams.delete('campaignView');
      }
      navigate(url);
    },
  };
};
