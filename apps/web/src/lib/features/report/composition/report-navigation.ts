import { panelOpenedFromReport, sessionRouteFor } from '../../sessions/detail/session-route';
import type { ShellNavigationOwner } from '../../shell/navigation-owner-context';

export const createReportNavigation =
  (port: {
    readonly currentState: () => App.PageState;
    readonly currentUrl: () => URL;
    readonly goto: ShellNavigationOwner['goto'];
  }): ShellNavigationOwner['goto'] =>
  (url, options) => {
    const current = port.currentUrl();
    const next = new URL(url, current);
    const state = port.currentState();
    const detailOpen = sessionRouteFor(current.pathname) !== null;
    const browsingDetail = sessionRouteFor(next.pathname) !== null;
    const closingDirectDetail = next.pathname === '/' && !panelOpenedFromReport(state);
    // Filters and neighbor browsing belong to the existing panel entry. A direct
    // detail has no list entry to return to, so closing replaces that entry too.
    return port.goto(
      url,
      detailOpen && (browsingDetail || closingDirectDetail) ? { ...options, replaceState: true, state } : options,
    );
  };
