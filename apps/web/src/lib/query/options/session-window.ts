import {
  parseSessionCampaignChildrenRequest,
  parseSessionQueryRequest,
  type SessionCampaignChildrenRequest,
  type SessionPageItem,
  type SessionPresentationRow,
  type SessionQueryRequest,
  sessionCampaignChildrenFingerprint,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import {
  type CreateInfiniteQueryOptions,
  type InfiniteData,
  InfiniteQueryObserver,
  infiniteQueryOptions,
  type QueryClient,
  type QueryKey,
} from '@tanstack/svelte-query';
import type { SessionClientAdapter } from '../../rpc/session-client';
import { immutableRevisionKey } from '../keys';
import { webQueryPolicies } from '../policies';

type SessionPageData = Extract<Awaited<ReturnType<SessionClientAdapter['page']>>, { readonly ok: true }>['data'];
type SessionCampaignData = Extract<
  Awaited<ReturnType<SessionClientAdapter['campaignChildren']>>,
  { readonly ok: true }
>['data'];
type SessionCursor = string | null;

export type SessionQueryScope = Omit<SessionQueryRequest, 'cursor' | 'revision'>;

export interface SessionWindowIntent {
  readonly campaignChildrenDepth: Readonly<Record<string, number>>;
  readonly campaignSessionsDepth: Readonly<Record<string, number>>;
  readonly topLevelDepth: number;
}

export interface SessionCampaignWindow {
  readonly campaignKey: string;
  readonly data: InfiniteData<SessionCampaignData, SessionCursor>;
}

export interface SessionWindowQueryData {
  readonly campaignChildren: readonly SessionCampaignWindow[];
  readonly campaignSessions: readonly SessionCampaignWindow[];
  readonly query: SessionQueryRequest;
  readonly topLevel: InfiniteData<SessionPageData, SessionCursor>;
}

export interface SessionCampaignPage {
  readonly items: readonly SessionPresentationRow[];
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly root: SessionPresentationRow | null;
  readonly sessionCount: number;
  readonly totalCount: number;
}

export interface SessionWindowView {
  readonly campaignChildren: ReadonlyMap<string, SessionCampaignPage>;
  readonly campaignSessions: ReadonlyMap<string, SessionCampaignPage>;
  readonly itemCount: number;
  readonly items: readonly SessionPageItem[];
  readonly loadingMore: boolean;
  readonly nextCursor: string | null;
  readonly query: SessionQueryRequest;
  readonly sessionCount: number;
}

export class SessionRevisionExpiredError extends Error {
  constructor() {
    super('The exact session report revision expired');
    this.name = 'SessionRevisionExpiredError';
  }
}

export const initialSessionWindowIntent = (): SessionWindowIntent => ({
  campaignChildrenDepth: {},
  campaignSessionsDepth: {},
  topLevelDepth: 1,
});

const normalizedDepthEntries = (depths: Readonly<Record<string, number>>): readonly (readonly [string, number])[] =>
  Object.entries(depths)
    .filter(([, depth]) => Number.isInteger(depth) && depth > 0)
    .sort(([left], [right]) => left.localeCompare(right));

export const sessionWindowIntentFingerprint = (intent: SessionWindowIntent): string =>
  JSON.stringify({
    campaignChildrenDepth: normalizedDepthEntries(intent.campaignChildrenDepth),
    campaignSessionsDepth: normalizedDepthEntries(intent.campaignSessionsDepth),
    topLevelDepth: Math.max(1, intent.topLevelDepth),
  });

export const increaseSessionWindowDepth = (
  intent: SessionWindowIntent,
  family: 'campaign-children' | 'campaign-sessions' | 'top-level',
  campaignKey?: string,
): SessionWindowIntent => {
  if (family === 'top-level') {
    return { ...intent, topLevelDepth: intent.topLevelDepth + 1 };
  }
  if (campaignKey === undefined) {
    return intent;
  }
  const current = family === 'campaign-children' ? intent.campaignChildrenDepth : intent.campaignSessionsDepth;
  const next = { ...current, [campaignKey]: (current[campaignKey] ?? 0) + 1 };
  return family === 'campaign-children'
    ? { ...intent, campaignChildrenDepth: next }
    : { ...intent, campaignSessionsDepth: next };
};

const errorFromResult = (result: { readonly error: { readonly message: string; readonly tag: string } }): Error =>
  result.error.tag === 'RevisionExpired' ? new SessionRevisionExpiredError() : new Error(result.error.message);

const requireSessionPage = (
  result: Awaited<ReturnType<SessionClientAdapter['page']>>,
  request: SessionQueryRequest,
): SessionPageData => {
  if (!result.ok) {
    throw errorFromResult(result);
  }
  const fingerprint = sessionQueryFingerprint(request);
  if (
    result.revision !== request.revision ||
    result.requestFingerprint !== fingerprint ||
    result.data.revision !== request.revision ||
    result.data.requestFingerprint !== fingerprint
  ) {
    throw new Error('The Session page result does not match its exact request');
  }
  return result.data;
};

const requireCampaignPage = (
  result: Awaited<ReturnType<SessionClientAdapter['campaignChildren']>>,
  request: SessionCampaignChildrenRequest,
): SessionCampaignData => {
  if (!result.ok) {
    throw errorFromResult(result);
  }
  const fingerprint = sessionCampaignChildrenFingerprint(request);
  if (
    result.revision !== request.query.revision ||
    result.requestFingerprint !== fingerprint ||
    result.data.revision !== request.query.revision ||
    result.data.requestFingerprint !== fingerprint
  ) {
    throw new Error('The Session campaign page result does not match its exact request');
  }
  return result.data;
};

const sessionPagesKey = (request: SessionQueryRequest): QueryKey =>
  immutableRevisionKey('session-pages', request.revision, sessionQueryFingerprint(request), 'infinite');

const sessionCampaignPagesKey = (
  request: SessionCampaignChildrenRequest,
  family: 'campaign-children' | 'campaign-sessions',
): QueryKey =>
  immutableRevisionKey(
    'session-campaign-pages',
    request.query.revision,
    sessionCampaignChildrenFingerprint(request),
    family,
  );

export const sessionPagesInfiniteOptions = (
  client: SessionClientAdapter,
  scope: SessionQueryScope,
  revision: string,
) => {
  const initialRequest = parseSessionQueryRequest({ ...scope, cursor: null, revision });
  return infiniteQueryOptions<
    SessionPageData,
    Error,
    InfiniteData<SessionPageData, SessionCursor>,
    QueryKey,
    SessionCursor
  >({
    ...webQueryPolicies.immutableRevision,
    getNextPageParam: (lastPage: SessionPageData) => lastPage.nextCursor,
    initialPageParam: null as SessionCursor,
    queryFn: async ({ pageParam, signal }) => {
      const request = parseSessionQueryRequest({ ...initialRequest, cursor: pageParam });
      return requireSessionPage(await client.page(request, signal), request);
    },
    queryKey: sessionPagesKey(initialRequest),
  });
};

const unfilteredCampaignQuery = (query: SessionQueryRequest, cursor: SessionCursor): SessionQueryRequest =>
  parseSessionQueryRequest({
    ...query,
    cursor,
    filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
    range: { from: null, to: null },
  });

export const sessionCampaignInfiniteOptions = (
  client: SessionClientAdapter,
  query: SessionQueryRequest,
  campaignKey: string,
  family: 'campaign-children' | 'campaign-sessions',
) => {
  const queryForCursor = (cursor: SessionCursor): SessionQueryRequest =>
    family === 'campaign-sessions'
      ? unfilteredCampaignQuery(query, cursor)
      : parseSessionQueryRequest({ ...query, cursor });
  const initialRequest = parseSessionCampaignChildrenRequest({
    campaignKey,
    query: queryForCursor(null),
  });
  return infiniteQueryOptions<
    SessionCampaignData,
    Error,
    InfiniteData<SessionCampaignData, SessionCursor>,
    QueryKey,
    SessionCursor
  >({
    ...webQueryPolicies.immutableRevision,
    getNextPageParam: (lastPage: SessionCampaignData) => lastPage.nextCursor,
    initialPageParam: null as SessionCursor,
    queryFn: async ({ pageParam, signal }) => {
      const request = parseSessionCampaignChildrenRequest({
        campaignKey,
        query: queryForCursor(pageParam),
      });
      return requireCampaignPage(await client.campaignChildren(request, signal), request);
    },
    queryKey: sessionCampaignPagesKey(initialRequest, family),
  });
};

const linkAbort = (signal: AbortSignal, queryClient: QueryClient, queryKey: QueryKey): (() => void) => {
  const cancel = (): void => {
    queryClient.cancelQueries({ exact: true, queryKey }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  return () => signal.removeEventListener('abort', cancel);
};

const ensureInfiniteDepth = async <Page extends { readonly nextCursor: SessionCursor }>(
  queryClient: QueryClient,
  options: CreateInfiniteQueryOptions<Page, Error, InfiniteData<Page, SessionCursor>, QueryKey, SessionCursor>,
  requestedDepth: number,
  signal: AbortSignal,
): Promise<InfiniteData<Page, SessionCursor>> => {
  const depth = Math.max(1, requestedDepth);
  const unlink = linkAbort(signal, queryClient, options.queryKey);
  const observer = new InfiniteQueryObserver(queryClient, options);
  try {
    let data = queryClient.getQueryData<InfiniteData<Page, SessionCursor>>(options.queryKey);
    if (data === undefined) {
      data = await queryClient.fetchInfiniteQuery({ ...options, pages: 1 });
    }
    while (data.pages.length < depth && data.pages.at(-1)?.nextCursor !== null) {
      signal.throwIfAborted();
      const result = await observer.fetchNextPage({ cancelRefetch: false, throwOnError: true });
      if (result.data === undefined) {
        throw result.error ?? new Error('Infinite Session query returned no data');
      }
      data = result.data;
    }
    signal.throwIfAborted();
    return data;
  } finally {
    observer.destroy();
    unlink();
  }
};

const ensureCampaignWindows = async (
  client: SessionClientAdapter,
  queryClient: QueryClient,
  query: SessionQueryRequest,
  family: 'campaign-children' | 'campaign-sessions',
  requestedDepths: Readonly<Record<string, number>>,
  availableCampaigns: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<readonly SessionCampaignWindow[]> =>
  await Promise.all(
    normalizedDepthEntries(requestedDepths)
      .filter(([campaignKey]) => availableCampaigns.has(campaignKey))
      .map(async ([campaignKey, depth]) => ({
        campaignKey,
        data: await ensureInfiniteDepth<SessionCampaignData>(
          queryClient,
          sessionCampaignInfiniteOptions(client, query, campaignKey, family),
          depth,
          signal,
        ),
      })),
  );

export const ensureSessionWindow = async (options: {
  readonly client: SessionClientAdapter;
  readonly intent: SessionWindowIntent;
  readonly queryClient: QueryClient;
  readonly revision: string;
  readonly scope: SessionQueryScope;
  readonly signal: AbortSignal;
}): Promise<SessionWindowQueryData> => {
  const query = parseSessionQueryRequest({ ...options.scope, cursor: null, revision: options.revision });
  const topLevel = await ensureInfiniteDepth<SessionPageData>(
    options.queryClient,
    sessionPagesInfiniteOptions(options.client, options.scope, options.revision),
    options.intent.topLevelDepth,
    options.signal,
  );
  const availableCampaigns = new Set(topLevel.pages.flatMap((page) => page.items.map((item) => item.campaignKey)));
  const [campaignChildren, campaignSessions] = await Promise.all([
    ensureCampaignWindows(
      options.client,
      options.queryClient,
      query,
      'campaign-children',
      options.intent.campaignChildrenDepth,
      availableCampaigns,
      options.signal,
    ),
    ensureCampaignWindows(
      options.client,
      options.queryClient,
      query,
      'campaign-sessions',
      options.intent.campaignSessionsDepth,
      availableCampaigns,
      options.signal,
    ),
  ]);
  return { campaignChildren, campaignSessions, query, topLevel };
};

const infiniteDepthSatisfied = <Page extends { readonly nextCursor: SessionCursor }>(
  data: InfiniteData<Page, SessionCursor>,
  requestedDepth: number,
): boolean => data.pages.length >= Math.max(1, requestedDepth) || data.pages.at(-1)?.nextCursor === null;

const campaignDepthsSatisfied = (
  windows: readonly SessionCampaignWindow[],
  requestedDepths: Readonly<Record<string, number>>,
): boolean => {
  const windowsByCampaign = new Map(windows.map((window) => [window.campaignKey, window]));
  for (const [campaignKey, requestedDepth] of normalizedDepthEntries(requestedDepths)) {
    const window = windowsByCampaign.get(campaignKey);
    if (!(window && infiniteDepthSatisfied(window.data, requestedDepth))) {
      return false;
    }
  }
  return true;
};

export const sessionWindowSatisfiesIntent = (data: SessionWindowQueryData, intent: SessionWindowIntent): boolean =>
  infiniteDepthSatisfied(data.topLevel, intent.topLevelDepth) &&
  campaignDepthsSatisfied(data.campaignChildren, intent.campaignChildrenDepth) &&
  campaignDepthsSatisfied(data.campaignSessions, intent.campaignSessionsDepth);

const uniqueBy = <Value>(values: readonly Value[], keyFor: (value: Value) => string): readonly Value[] => {
  const seen = new Set<string>();
  const unique: Value[] = [];
  for (const value of values) {
    const key = keyFor(value);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(value);
    }
  }
  return unique;
};

const campaignPageFor = (
  window: SessionCampaignWindow,
  requestedDepth: number,
  fetching: boolean,
): SessionCampaignPage => {
  const last = window.data.pages.at(-1);
  const roots = window.data.pages.map((page) => page.root).filter((root) => root !== null);
  if (new Set(roots.map((root) => root.rowId)).size > 1) {
    throw new Error('Campaign root changed while paging one exact revision');
  }
  return {
    items: uniqueBy(
      window.data.pages.flatMap((page) => page.items),
      (row) => row.rowId,
    ),
    loading: fetching && requestedDepth > window.data.pages.length,
    nextCursor: last?.nextCursor ?? null,
    root: roots[0] ?? null,
    sessionCount: last?.sessionCount ?? 0,
    totalCount: last?.itemCount ?? 0,
  };
};

const campaignMapFor = (
  windows: readonly SessionCampaignWindow[],
  requestedDepths: Readonly<Record<string, number>>,
  fetching: boolean,
): ReadonlyMap<string, SessionCampaignPage> => {
  const byCampaign = new Map(windows.map((window) => [window.campaignKey, window]));
  const result = new Map<string, SessionCampaignPage>();
  for (const [campaignKey, requestedDepth] of normalizedDepthEntries(requestedDepths)) {
    const window = byCampaign.get(campaignKey);
    if (window) {
      result.set(campaignKey, campaignPageFor(window, requestedDepth, fetching));
    } else if (fetching) {
      result.set(campaignKey, {
        items: [],
        loading: true,
        nextCursor: null,
        root: null,
        sessionCount: 0,
        totalCount: 0,
      });
    }
  }
  return result;
};

export const sessionWindowView = (
  data: SessionWindowQueryData,
  requestedIntent: SessionWindowIntent,
  fetching: boolean,
): SessionWindowView => {
  const last = data.topLevel.pages.at(-1);
  return {
    campaignChildren: campaignMapFor(data.campaignChildren, requestedIntent.campaignChildrenDepth, fetching),
    campaignSessions: campaignMapFor(data.campaignSessions, requestedIntent.campaignSessionsDepth, fetching),
    itemCount: last?.itemCount ?? 0,
    items: uniqueBy(
      data.topLevel.pages.flatMap((page) => page.items),
      (item) => item.campaignKey,
    ),
    loadingMore: fetching && requestedIntent.topLevelDepth > data.topLevel.pages.length,
    nextCursor: last?.nextCursor ?? null,
    query: data.query,
    sessionCount: last?.sessionCount ?? 0,
  };
};
