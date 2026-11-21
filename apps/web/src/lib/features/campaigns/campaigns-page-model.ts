import { buildCampaignMap, type CampaignMap } from '@ai-usage/report-core/campaign-map';
import {
  parseSessionLookupRequest,
  type SessionPresentationRow,
  SessionQueryValidationError,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import { campaignMapFixtureGeneratedAt } from '../../foundation/campaign-map-fixture';
import type { DashboardSearch } from '../../foundation/dashboard/dashboard-search';
import type { CampaignExplorationAnchors, CampaignExplorationData } from './campaigns-query';

/** The Harness select value that stands for a URL selecting more than one harness. */
export const MULTIPLE_HARNESSES = 'inherited-harnesses';

/** The report revision the page explores: what it last inspected, or the latest it can acquire. */
export interface CampaignRevision {
  readonly generatedAt: string;
  readonly revision: string;
}

/** The bootstrap fields the page reads its latest revision from. */
export interface CampaignBootstrapRevision {
  readonly bootstrap: { readonly support: { readonly generatedAt: string } };
  readonly manifest: { readonly revision: string };
}

/** A loaded campaign list entry, as far as the page reads it. */
export interface CampaignListEntry {
  readonly campaignKey: string;
  readonly row: Pick<SessionPresentationRow, 'projectKey'>;
}

/** A loaded page of one campaign's members, as far as the map reads it. */
export interface CampaignMemberPage {
  readonly itemCount: number;
  readonly items: readonly SessionPresentationRow[];
}

const isKey = (key: string | undefined): key is string => Boolean(key);

/** The URL filters the page's own controls do not edit, each as one readable line. */
export const inheritedFiltersFor = (search: Pick<DashboardSearch, 'filters' | 'machine' | 'origin' | 'timeCell'>) => [
  ...Object.entries(search.filters).map(([name, value]) => `${name}: ${value}`),
  ...search.machine.map((value) => `machine: ${value}`),
  ...search.origin.map((value) => `origin: ${value}`),
  ...(search.timeCell ? [`local time: ${search.timeCell}`] : []),
];

/** The fixed revision of the synthetic campaign map; a fresh value per call. */
export const syntheticCampaignRevision = (): CampaignRevision => ({
  revision: 'synthetic-campaign-map-v1',
  generatedAt: campaignMapFixtureGeneratedAt,
});

/** The latest revision a live bootstrap announces, or none before it is acquired. */
export const bootstrapCampaignRevision = (bootstrap: CampaignBootstrapRevision | null): CampaignRevision | null =>
  bootstrap ? { revision: bootstrap.manifest.revision, generatedAt: bootstrap.bootstrap.support.generatedAt } : null;

/** The presentation context a fitted timeline axis belongs to: the answered request and period. */
export const campaignTimelineContext = (
  visible: Pick<CampaignExplorationData, 'request' | 'timelineRange'> | undefined,
): string => (visible ? JSON.stringify([sessionQueryFingerprint(visible.request), visible.timelineRange]) : '');

/** The Agent Map of the selected campaign from its canonical root and loaded member pages. */
export const campaignMapFor = (
  campaignKey: string,
  root: SessionPresentationRow,
  memberPages: readonly CampaignMemberPage[],
): CampaignMap =>
  buildCampaignMap({
    campaignKey,
    children: memberPages.flatMap((entry) => entry.items),
    root,
    totalCount: (memberPages[0]?.itemCount ?? 0) + 1,
  });

/** Rows keyed by `rowId`: `extra` replaces a `primary` row with the same id, first-seen order kept. */
export const mergeRowsById = <Row extends { readonly rowId: string }>(
  primary: readonly Row[],
  extra: readonly Row[],
): Row[] => {
  const known = new Map(primary.map((row) => [row.rowId, row]));
  for (const row of extra) {
    known.set(row.rowId, row);
  }
  return [...known.values()];
};

/**
 * A directly looked-up session has no acquired neighbors yet. Do not make
 * j/k jump from an absent index to the first loaded campaign member.
 */
export const detailNavigationRowsFor = <Row extends { readonly rowId: string }>(
  selection: { readonly row: Row } | null,
  compatible: readonly Row[],
): readonly Row[] =>
  selection && !compatible.some((row) => row.rowId === selection.row.rowId) ? [selection.row] : compatible;

/** The lookup request for a session link, or none when the link's row id is not a valid one. */
export const optionalSessionLookupRequest = (
  revision: string,
  rowId: string,
): ReturnType<typeof parseSessionLookupRequest> | undefined => {
  try {
    return parseSessionLookupRequest({ revision, rowId });
  } catch (cause) {
    if (cause instanceof SessionQueryValidationError) {
      return;
    }
    throw cause;
  }
};

/** The matching-session depth and positions a refresh restores, keeping only rows still matched. */
export const matchingRestorationFor = (
  campaignKey: string,
  depth: number,
  candidates: readonly (string | undefined)[],
  matchedRows: readonly { readonly rowId: string }[],
) => ({
  campaignKey,
  depth,
  rowIds: candidates.filter((key): key is string => Boolean(key) && matchedRows.some((row) => row.rowId === key)),
});

/** The campaign a Project timeline anchor belongs to, when the loaded rows can tell. */
export const timelineCampaignAnchorFor = (
  timelineAnchor: string | undefined,
  items: readonly CampaignListEntry[],
  rows: readonly { readonly rowId: string }[],
  selectedKey: string,
): string | undefined => {
  if (timelineAnchor?.startsWith('campaign:')) {
    return timelineAnchor.slice('campaign:'.length);
  }
  if (timelineAnchor?.startsWith('project-continuation:')) {
    return timelineAnchor.slice('project-continuation:'.length);
  }
  if (timelineAnchor?.startsWith('project:')) {
    return items.find((item) => item.row.projectKey === timelineAnchor.slice('project:'.length))?.campaignKey;
  }
  if (timelineAnchor && rows.some((row) => row.rowId === timelineAnchor)) {
    return selectedKey;
  }
};

/** The campaign and member positions a refresh asks the next exploration to keep in view. */
export const refreshAnchorsFor = (input: {
  readonly campaignAnchor: string | undefined;
  readonly items: readonly CampaignListEntry[];
  readonly memberAnchor: string | undefined;
  readonly rows: readonly { readonly rowId: string }[];
  readonly selectedKey: string;
  readonly timelineAnchor: string | undefined;
}): CampaignExplorationAnchors => {
  const { campaignAnchor, items, memberAnchor, rows, selectedKey, timelineAnchor } = input;
  const timelineCampaignAnchor = timelineCampaignAnchorFor(timelineAnchor, items, rows, selectedKey);
  return {
    campaignKeys: [...new Set([campaignAnchor, timelineCampaignAnchor].filter(isKey))],
    memberRowIds: selectedKey
      ? { [selectedKey]: [rows.some((row) => row.rowId === memberAnchor) ? memberAnchor : undefined].filter(isKey) }
      : {},
  };
};

/** The search the filter form submits: its query, period and harness over the current search. */
export const filteredSearchFrom = (search: DashboardSearch, form: FormData): DashboardSearch => {
  const range = form.get('range');
  const harness = String(form.get('harness') ?? '');
  let nextHarness = harness ? [harness] : [];
  if (harness === MULTIPLE_HARNESSES) {
    nextHarness = search.harness;
  }
  return {
    ...search,
    q: String(form.get('q') ?? ''),
    harness: nextHarness,
    range:
      range === 'custom'
        ? search.range
        : { mode: range === '7d' || range === '90d' || range === 'all' || range === 'today' ? range : '30d' },
  };
};

/** A campaign's last recorded activity as a UTC date and clock. */
export const recordedAt = (row: Pick<SessionPresentationRow, 'activeDate' | 'date' | 'endDate'>): string => {
  const value = row.activeDate ?? row.endDate ?? row.date;
  const date = new Date(value ?? '');
  if (!Number.isFinite(date.getTime())) {
    return 'Time not recorded';
  }
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    date.getUTCMonth()
  ];
  const clock = date.toISOString().slice(11, 16);
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}, ${clock} UTC`;
};

/** A campaign's session count, naming the filtered share when the list filters hide some. */
export const sessionCount = (row: Pick<SessionPresentationRow, 'campaignTotalCount' | 'campaignVisibleCount'>) => {
  const total = row.campaignTotalCount ?? 1;
  const visibleCount = row.campaignVisibleCount ?? total;
  if (visibleCount !== total) {
    return `${visibleCount} of ${total} sessions`;
  }
  return `${total} ${total === 1 ? 'session' : 'sessions'}`;
};
