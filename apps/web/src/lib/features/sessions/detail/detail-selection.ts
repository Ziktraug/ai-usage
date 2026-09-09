import type { SessionPageItem, SessionPresentationRow, SessionQueryRequest } from '@ai-usage/report-core/session-query';
import {
  sessionAnalysisTargetForOverviewRow,
  sessionAnalysisTargetForPageItem,
  sessionAnalysisTargetForSession,
} from '../../../../session-analysis-target';
import { campaignSessionSelectionQuery } from '../../report/actions/campaign-session-controls-binding';
import type { SessionRoute } from './session-route';
import type { SessionSelectionInput } from './types';

interface CampaignPageLike {
  readonly items: readonly SessionPresentationRow[];
  readonly root: SessionPresentationRow | null;
  readonly sessionCount: number;
}

export interface DetailSelectionWindow {
  readonly campaignChildren: ReadonlyMap<string, CampaignPageLike>;
  readonly campaignSessions: ReadonlyMap<string, CampaignPageLike>;
  readonly items: readonly SessionPageItem[];
  readonly query: SessionQueryRequest;
  readonly sessionCount: number;
}

export interface DetailSelectionInput {
  /** Aggregate campaign item fetched for a campaign route the window did not hold. */
  readonly campaignLookup: SessionPageItem | null | undefined;
  /** Rows the reader was looking at when the panel opened (Overview top sessions, campaign members). */
  readonly contextRows: readonly SessionPresentationRow[];
  /** Presentation row fetched for a session route the window did not hold. */
  readonly lookupRow: SessionPresentationRow | null | undefined;
  readonly revision: string | undefined;
  readonly route: SessionRoute | null;
  /** The served Sessions window when the Sessions destination is focused. */
  readonly window: DetailSelectionWindow | undefined;
}

export type DetailSelectionState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading'; readonly lookup: 'campaign' | 'session' }
  | { readonly kind: 'missing'; readonly route: SessionRoute }
  | { readonly kind: 'open'; readonly selection: SessionSelectionInput };

const withRevision = (revision: string | undefined): { revision?: string } =>
  revision === undefined ? {} : { revision };

const memberSelection = (
  window: DetailSelectionWindow,
  campaignKey: string,
  page: CampaignPageLike,
  row: SessionPresentationRow,
): SessionSelectionInput => ({
  query: campaignSessionSelectionQuery(window.query, campaignKey),
  row,
  target: sessionAnalysisTargetForSession(row),
  total: page.sessionCount,
});

const sessionSelectionInWindow = (window: DetailSelectionWindow, rowId: string): SessionSelectionInput | undefined => {
  // Member pages hold plain session rows, including the root as a session of
  // its own; they come first so a root's session URL never shows its campaign.
  for (const pages of [window.campaignSessions, window.campaignChildren]) {
    for (const [campaignKey, page] of pages) {
      const row = page.root?.rowId === rowId ? page.root : page.items.find((candidate) => candidate.rowId === rowId);
      if (row) {
        return memberSelection(window, campaignKey, page, row);
      }
    }
  }
  // A top-level item is a campaign aggregate; only a campaign of one is also the session itself.
  const topLevel = window.items.find((item) => item.row.rowId === rowId && (item.row.campaignTotalCount ?? 1) <= 1);
  if (topLevel) {
    return {
      query: window.query,
      row: topLevel.row,
      target: sessionAnalysisTargetForSession(topLevel.row),
      total: window.sessionCount,
    };
  }
  return;
};

const campaignSelectionFor = (
  item: SessionPageItem,
  window: DetailSelectionWindow | undefined,
  revision: string | undefined,
): SessionSelectionInput =>
  window
    ? { query: window.query, row: item.row, target: sessionAnalysisTargetForPageItem(item), total: window.sessionCount }
    : { ...withRevision(revision), row: item.row, target: sessionAnalysisTargetForPageItem(item) };

/**
 * The panel's selection follows the URL. A route names a row; the row comes
 * from the loaded Sessions window, from the rows the reader was looking at,
 * or from an exact lookup at the served revision. Nothing here fetches: the
 * owner runs the lookups this function asks for through `loading`.
 */
export const resolveDetailSelection = (input: DetailSelectionInput): DetailSelectionState => {
  const { route } = input;
  if (route === null) {
    return { kind: 'closed' };
  }
  if (route.kind === 'campaign') {
    const item = input.window?.items.find((candidate) => candidate.campaignKey === route.campaignKey);
    if (item) {
      return { kind: 'open', selection: campaignSelectionFor(item, input.window, input.revision) };
    }
    const contextRow = input.contextRows.find(
      (row) => row.campaignKey === route.campaignKey && row.campaignTotalCount !== undefined,
    );
    if (contextRow) {
      return {
        kind: 'open',
        selection: {
          ...withRevision(input.revision),
          row: contextRow,
          target: sessionAnalysisTargetForOverviewRow(contextRow),
        },
      };
    }
    if (input.campaignLookup === undefined) {
      return { kind: 'loading', lookup: 'campaign' };
    }
    if (input.campaignLookup === null) {
      return { kind: 'missing', route };
    }
    return { kind: 'open', selection: campaignSelectionFor(input.campaignLookup, input.window, input.revision) };
  }
  const inWindow = input.window ? sessionSelectionInWindow(input.window, route.rowId) : undefined;
  if (inWindow) {
    return { kind: 'open', selection: inWindow };
  }
  const contextRow = input.contextRows.find((row) => row.rowId === route.rowId);
  if (contextRow) {
    return {
      kind: 'open',
      selection: {
        ...withRevision(input.revision),
        row: contextRow,
        target: sessionAnalysisTargetForSession(contextRow),
      },
    };
  }
  if (input.lookupRow === undefined) {
    return { kind: 'loading', lookup: 'session' };
  }
  if (input.lookupRow === null) {
    return { kind: 'missing', route };
  }
  const window = input.window;
  const campaignKey = input.lookupRow.campaignKey;
  if (window && campaignKey !== undefined && campaignKey !== route.rowId) {
    const page = window.campaignSessions.get(campaignKey) ?? window.campaignChildren.get(campaignKey);
    if (page) {
      return { kind: 'open', selection: memberSelection(window, campaignKey, page, input.lookupRow) };
    }
  }
  return {
    kind: 'open',
    selection: {
      ...withRevision(input.revision),
      row: input.lookupRow,
      target: sessionAnalysisTargetForSession(input.lookupRow),
    },
  };
};

/** A row that aggregates a campaign (it carries member counts) opens the campaign; any other row opens the session. */
export const routeForRow = (row: SessionPresentationRow): SessionRoute =>
  row.campaignKey !== undefined && (row.campaignTotalCount ?? 1) > 1
    ? { campaignKey: row.campaignKey, kind: 'campaign' }
    : { kind: 'session', rowId: row.rowId };

/**
 * The route a selection navigates to: a campaign root opens the campaign,
 * everything else the session. A neighbor row reached with j/k carries no
 * campaign target, so the loaded window decides whether it is a root.
 */
export const routeForSelection = (
  selection: SessionSelectionInput,
  window?: Pick<DetailSelectionWindow, 'items'>,
): SessionRoute => {
  if (selection.target?.kind === 'campaign-root') {
    return { campaignKey: selection.target.campaignKey, kind: 'campaign' };
  }
  const rootItem = window?.items.find((item) => item.row.rowId === selection.row.rowId);
  if (rootItem && (rootItem.row.campaignTotalCount ?? 1) > 1) {
    return { campaignKey: rootItem.campaignKey, kind: 'campaign' };
  }
  return { kind: 'session', rowId: selection.row.rowId };
};
