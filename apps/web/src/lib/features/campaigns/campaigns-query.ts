import {
  parseSessionQueryRequest,
  type SessionQueryRequest,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import {
  type CreateInfiniteQueryOptions,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  queryOptions,
} from '@tanstack/svelte-query';
import type { DashboardSearch } from '../../../dashboard-search';
import { immutableRevisionKey } from '../../query/keys';
import { withCampaignPageProgress } from '../../query/options/campaigns';
import {
  ensureInfiniteDepth,
  type SessionCampaignWindow,
  type SessionWindowIntent,
  sessionCampaignInfiniteOptions,
  sessionPagesInfiniteOptions,
  sessionWindowIntentFingerprint,
} from '../../query/options/session-window';
import { webQueryPolicies } from '../../query/policies';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { INITIAL_REPORT_TIMELINE } from '../report/composition/report-destination';
import { reportDestinationForSearch } from '../report/composition/report-search';

export const CAMPAIGN_PAGE_SIZE = 40;
export const CAMPAIGN_MEMBER_PAGE_SIZE = 100;
export const CAMPAIGN_RESTORATION_EXTRA_PAGES = 4;
export const CAMPAIGN_RESTORATION_PAGE_BUDGET = 32;

export const campaignsRequest = (search: DashboardSearch, generatedAt: string, revision: string): SessionQueryRequest =>
  parseSessionQueryRequest({
    ...reportDestinationForSearch({ ...search, tab: 'sessions' }, generatedAt, INITIAL_REPORT_TIMELINE).sessions,
    cursor: null,
    pageSize: CAMPAIGN_PAGE_SIZE,
    revision,
    sort: [{ desc: true, id: 'date' }],
  });

export const campaignsListOptions = (client: SessionClientAdapter, request: SessionQueryRequest) => {
  const { cursor: _cursor, revision, ...scope } = request;
  return withCampaignPageProgress(sessionPagesInfiniteOptions(client, scope, revision), (item) => item.campaignKey);
};

export const campaignMembersOptions = (client: SessionClientAdapter, revision: string, campaignKey: string) =>
  withCampaignPageProgress(
    sessionCampaignInfiniteOptions(
      client,
      parseSessionQueryRequest({
        cursor: null,
        filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
        pageSize: CAMPAIGN_MEMBER_PAGE_SIZE,
        range: { from: null, to: null },
        revision,
        sort: [{ desc: false, id: 'date' }],
      }),
      campaignKey,
      'campaign-sessions',
    ),
    (row) => row.rowId,
  );

/** Filtered discovery remains separate from the complete hierarchy used for inspection. */
export const campaignMatchingMembersOptions = (
  client: SessionClientAdapter,
  request: SessionQueryRequest,
  campaignKey: string,
) =>
  withCampaignPageProgress(
    sessionCampaignInfiniteOptions(
      client,
      { ...request, pageSize: CAMPAIGN_MEMBER_PAGE_SIZE },
      campaignKey,
      'campaign-children',
    ),
    (row) => row.rowId,
  );

type CampaignListPage = Extract<Awaited<ReturnType<SessionClientAdapter['page']>>, { readonly ok: true }>['data'];

export interface CampaignExplorationAnchors {
  readonly campaignKeys?: readonly string[];
  readonly memberRowIds?: Readonly<Record<string, readonly string[]>>;
}

export interface CampaignExplorationData {
  readonly list: InfiniteData<CampaignListPage, string | null>;
  readonly members: readonly SessionCampaignWindow[];
  /** Only identities proved absent by reaching the real end, never a bounded-search guess. */
  readonly missingAnchors: readonly string[];
  readonly request: SessionQueryRequest;
}

interface CampaignExplorationOptions {
  readonly anchors?: CampaignExplorationAnchors;
  readonly client: SessionClientAdapter;
  readonly intent: SessionWindowIntent;
  readonly matching?: {
    readonly campaignKey: string;
    readonly depth: number;
    readonly rowIds: readonly string[];
  };
  readonly queryClient: QueryClient;
  readonly request: SessionQueryRequest;
}

export class CampaignRestorationLimitError extends Error {
  constructor() {
    super(
      'The previous position moved beyond the bounded refresh window. Your current view has been kept. Return to the top or narrow the search before applying new data.',
    );
    this.name = 'CampaignRestorationLimitError';
  }
}

const missingIdentities = (wanted: readonly string[], present: Iterable<string>): string[] => {
  const identities = new Set(present);
  return wanted.filter((identity) => !identities.has(identity));
};

const normalizedMemberDepths = (intent: SessionWindowIntent) =>
  Object.entries(intent.campaignSessionsDepth)
    .filter(([, depth]) => Number.isInteger(depth) && depth > 0)
    .sort(([left], [right]) => left.localeCompare(right));

const ensureWithinBudget = async <Page extends { readonly nextCursor: string | null }>(
  queryClient: QueryClient,
  options: CreateInfiniteQueryOptions<Page, Error, InfiniteData<Page, string | null>, QueryKey, string | null>,
  requestedDepth: number,
  signal: AbortSignal,
  budget: { remaining: number },
): Promise<InfiniteData<Page, string | null>> => {
  const cached = queryClient.getQueryData<InfiniteData<Page, string | null>>(options.queryKey);
  const loadedDepth = cached?.pages.length ?? 0;
  const allowedDepth = Math.min(Math.max(1, requestedDepth), loadedDepth + budget.remaining);
  if (allowedDepth === 0) {
    throw new CampaignRestorationLimitError();
  }
  const data = await ensureInfiniteDepth(queryClient, options, allowedDepth, signal);
  budget.remaining -= Math.max(0, data.pages.length - loadedDepth);
  if (data.pages.length < requestedDepth && data.pages.at(-1)?.nextCursor !== null) {
    throw new CampaignRestorationLimitError();
  }
  return data;
};

const restoreCollectedInfiniteEntries = (options: CampaignExplorationOptions): void => {
  const { client, queryClient, request } = options;
  const fingerprint = sessionQueryFingerprint(request);
  const retained = queryClient.getQueriesData<CampaignExplorationData>({
    queryKey: ['web', 'immutable-revision', 'campaign-exploration', request.revision],
  });
  let list: CampaignExplorationData['list'] | undefined;
  const members = new Map<string, SessionCampaignWindow['data']>();
  for (const [, data] of retained) {
    if (!data || data.request.revision !== request.revision || sessionQueryFingerprint(data.request) !== fingerprint) {
      continue;
    }
    if (!list || data.list.pages.length > list.pages.length) {
      list = data.list;
    }
    for (const window of data.members) {
      if (window.data.pages.length > (members.get(window.campaignKey)?.pages.length ?? 0)) {
        members.set(window.campaignKey, window.data);
      }
    }
  }
  const seedMissing = <Data>(key: QueryKey, data: Data | undefined): void => {
    if (
      data !== undefined &&
      queryClient.getQueryData(key) === undefined &&
      queryClient.getQueryState(key)?.fetchStatus !== 'fetching'
    ) {
      queryClient.setQueryData(key, data);
    }
  };
  // The active composite already owns these exact immutable page objects. Reuse their references
  // if inactive infinite entries were collected during a long read, without retaining a new store.
  seedMissing(campaignsListOptions(client, request).queryKey, list);
  for (const [campaignKey, data] of members) {
    seedMissing(campaignMembersOptions(client, request.revision, campaignKey).queryKey, data);
  }
};

/** Replays intent with this revision's cursors and publishes only one complete coherent window. */
export const ensureCampaignExploration = async (
  options: CampaignExplorationOptions & { readonly signal: AbortSignal },
): Promise<CampaignExplorationData> => {
  const { client, intent, queryClient, request, signal } = options;
  signal.throwIfAborted();
  restoreCollectedInfiniteEntries(options);
  const budget = { remaining: CAMPAIGN_RESTORATION_PAGE_BUDGET };
  const listOptions = campaignsListOptions(client, request);
  let list = await ensureWithinBudget(queryClient, listOptions, intent.topLevelDepth, signal, budget);
  const listAnchors = options.anchors?.campaignKeys ?? [];
  let missingCampaigns = missingIdentities(
    listAnchors,
    list.pages.flatMap((entry) => entry.items.map((item) => item.campaignKey)),
  );
  const listLimit = Math.max(1, intent.topLevelDepth) + CAMPAIGN_RESTORATION_EXTRA_PAGES;
  while (missingCampaigns.length > 0 && list.pages.at(-1)?.nextCursor !== null) {
    if (list.pages.length >= listLimit) {
      throw new CampaignRestorationLimitError();
    }
    list = await ensureWithinBudget(queryClient, listOptions, list.pages.length + 1, signal, budget);
    missingCampaigns = missingIdentities(
      listAnchors,
      list.pages.flatMap((entry) => entry.items.map((item) => item.campaignKey)),
    );
  }
  const restoredMembers: SessionCampaignWindow[] = [];
  const missingAnchors = [...missingCampaigns];
  // A bounded sequential replay avoids a burst across every campaign expanded during a long visit.
  for (const [campaignKey, depth] of normalizedMemberDepths(intent)) {
    const memberOptions = campaignMembersOptions(client, request.revision, campaignKey);
    let data = await ensureWithinBudget(queryClient, memberOptions, depth, signal, budget);
    const wanted = options.anchors?.memberRowIds?.[campaignKey] ?? [];
    const present = () =>
      data.pages.flatMap((entry) => [
        ...(entry.root ? [entry.root.rowId] : []),
        ...entry.items.map((row) => row.rowId),
      ]);
    let missing = missingIdentities(wanted, present());
    const limit = Math.max(1, depth) + CAMPAIGN_RESTORATION_EXTRA_PAGES;
    while (missing.length > 0 && data.pages.at(-1)?.nextCursor !== null) {
      if (data.pages.length >= limit) {
        throw new CampaignRestorationLimitError();
      }
      data = await ensureWithinBudget(queryClient, memberOptions, data.pages.length + 1, signal, budget);
      missing = missingIdentities(wanted, present());
    }
    restoredMembers.push({ campaignKey, data });
    missingAnchors.push(...missing);
  }
  if (options.matching) {
    const { campaignKey, depth, rowIds } = options.matching;
    const matchingOptions = campaignMatchingMembersOptions(client, request, campaignKey);
    let data = await ensureWithinBudget(queryClient, matchingOptions, depth, signal, budget);
    const missingRows = () =>
      missingIdentities(
        rowIds,
        data.pages.flatMap((entry) => entry.items.map((row) => row.rowId)),
      );
    let missing = missingRows();
    while (missing.length > 0 && data.pages.at(-1)?.nextCursor !== null) {
      if (data.pages.length >= Math.max(1, depth) + CAMPAIGN_RESTORATION_EXTRA_PAGES) {
        throw new CampaignRestorationLimitError();
      }
      data = await ensureWithinBudget(queryClient, matchingOptions, data.pages.length + 1, signal, budget);
      missing = missingRows();
    }
    missingAnchors.push(...missing);
  }
  signal.throwIfAborted();
  return { list, members: restoredMembers, missingAnchors, request };
};

const anchorsFingerprint = (anchors: CampaignExplorationAnchors | undefined): string =>
  JSON.stringify({
    campaignKeys: [...(anchors?.campaignKeys ?? [])].sort(),
    memberRowIds: Object.entries(anchors?.memberRowIds ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, ids]) => [key, [...ids].sort()]),
  });

export const campaignsExplorationOptions = (options: CampaignExplorationOptions) =>
  queryOptions({
    ...webQueryPolicies.immutableRevision,
    queryFn: ({ signal }) => ensureCampaignExploration({ ...options, signal }),
    queryKey: immutableRevisionKey(
      'campaign-exploration',
      options.request.revision,
      sessionQueryFingerprint(options.request),
      `${sessionWindowIntentFingerprint(options.intent)}\0${anchorsFingerprint(options.anchors)}\0${JSON.stringify(options.matching ?? null)}`,
    ),
  });
