/**
 * The detail panel's identity lives in the URL: `/sessions/<rowId>` for one
 * session, `/campaigns/<campaignKey>` for a campaign. Both keep the dashboard
 * search (tab, filters, range) so the table behind the panel stays where it
 * was, and a direct load renders the same table with the panel open.
 */
export type SessionRoute =
  | { readonly kind: 'campaign'; readonly campaignKey: string }
  | { readonly kind: 'session'; readonly rowId: string };

const SESSION_PREFIX = '/sessions/';
const CAMPAIGN_PREFIX = '/campaigns/';

const decodeSegment = (segment: string): string | null => {
  if (segment.length === 0 || segment.includes('/')) {
    return null;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export const sessionRouteFor = (pathname: string): SessionRoute | null => {
  if (pathname.startsWith(SESSION_PREFIX)) {
    const rowId = decodeSegment(pathname.slice(SESSION_PREFIX.length));
    return rowId === null ? null : { kind: 'session', rowId };
  }
  if (pathname.startsWith(CAMPAIGN_PREFIX)) {
    const campaignKey = decodeSegment(pathname.slice(CAMPAIGN_PREFIX.length));
    return campaignKey === null ? null : { kind: 'campaign', campaignKey };
  }
  return null;
};

/** `/` and the two detail routes share one mounted report. */
export const isReportPathname = (pathname: string): boolean => pathname === '/' || sessionRouteFor(pathname) !== null;

export const sessionRoutePathname = (route: SessionRoute): string =>
  route.kind === 'session'
    ? `${SESSION_PREFIX}${encodeURIComponent(route.rowId)}`
    : `${CAMPAIGN_PREFIX}${encodeURIComponent(route.campaignKey)}`;

/** The detail URL for a route, keeping the current dashboard search. */
export const sessionRouteUrl = (currentUrl: URL, route: SessionRoute): URL => {
  const next = new URL(currentUrl);
  next.pathname = sessionRoutePathname(route);
  next.hash = '';
  return next;
};

/** The list URL that closes the panel, keeping the current dashboard search. */
export const sessionListUrl = (currentUrl: URL): URL => {
  const next = new URL(currentUrl);
  next.pathname = '/';
  next.hash = '';
  return next;
};

export const sameSessionRoute = (left: SessionRoute | null, right: SessionRoute | null): boolean => {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === 'session' && right.kind === 'session'
    ? left.rowId === right.rowId
    : left.kind === 'campaign' && right.kind === 'campaign' && left.campaignKey === right.campaignKey;
};

/**
 * History state the panel writes when it opens from the report, so closing
 * can travel back to the list entry instead of pushing a third one. A direct
 * load has no such entry and closes by navigating to the list URL.
 */
export interface SessionPanelHistoryState {
  readonly aiUsageSessionPanel?: { readonly openedFromReport: true };
}

export const sessionPanelHistoryState = <State extends object>(
  state: State,
): State & Required<SessionPanelHistoryState> => ({
  ...state,
  aiUsageSessionPanel: { openedFromReport: true },
});

export const panelOpenedFromReport = (state: SessionPanelHistoryState | null | undefined): boolean =>
  state?.aiUsageSessionPanel?.openedFromReport === true;
