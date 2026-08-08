import {
  parseSessionQueryRequest,
  type SessionQueryRequest,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type QueryClient,
  QueryClient as TanStackQueryClient,
} from '@tanstack/svelte-query';
import { webQueryClientDefaultOptions } from './policies';

export interface WebQueryHydrationState {
  readonly dehydratedState: DehydratedState;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SESSION_PAGES_SEED = 'session-pages' as const;

const sessionQueryIdentity = (revision: string, fingerprint: string): string => `${revision}\0${fingerprint}`;

interface SessionPagesSeedMarker {
  readonly campaignChildren: readonly [];
  readonly campaignSessions: readonly [];
  readonly query: SessionQueryRequest;
  readonly seed: typeof SESSION_PAGES_SEED;
  readonly topLevel: { readonly pageParams: readonly []; readonly pages: readonly [] };
}

const isSessionPagesSeed = (value: unknown): value is SessionPagesSeedMarker =>
  isRecord(value) && value.seed === SESSION_PAGES_SEED && isRecord(value.query);

const queryKeyFamily = (queryKey: readonly unknown[]): string => (typeof queryKey[2] === 'string' ? queryKey[2] : '');

const isSessionPagesQueryKey = (queryKey: readonly unknown[]): boolean =>
  queryKeyFamily(queryKey) === 'session-pages' && queryKey.at(-1) === 'infinite';

const isReportDestinationQueryKey = (queryKey: readonly unknown[]): boolean =>
  queryKeyFamily(queryKey) === 'report-destination';

const sessionPageItemCount = (pages: unknown): number => {
  if (!Array.isArray(pages)) {
    return 0;
  }
  let count = 0;
  for (const page of pages) {
    if (isRecord(page) && Array.isArray(page.items)) {
      count += page.items.length;
    }
  }
  return count;
};

const destinationSessionItemCount = (data: unknown): number => {
  if (!(isRecord(data) && isRecord(data.sessions) && isRecord(data.sessions.topLevel))) {
    return 0;
  }
  return sessionPageItemCount(data.sessions.topLevel.pages);
};

const sessionPagesItemCount = (data: unknown): number => {
  if (!isRecord(data)) {
    return 0;
  }
  return sessionPageItemCount(data.pages);
};

/**
 * Counts dehydrated queries that carry a full Session page-item payload. Production hydration must
 * keep this at most one for a Sessions deep link (canonical session-pages).
 */
export const countDehydratedSessionPagePayloads = (state: WebQueryHydrationState): number => {
  let count = 0;
  for (const query of state.dehydratedState.queries) {
    const key = query.queryKey;
    if (isSessionPagesQueryKey(key) && sessionPagesItemCount(query.state.data) > 0) {
      count += 1;
      continue;
    }
    if (isReportDestinationQueryKey(key) && destinationSessionItemCount(query.state.data) > 0) {
      count += 1;
    }
  }
  return count;
};

const destinationSessionsQuery = (data: unknown): SessionQueryRequest | undefined => {
  if (!(isRecord(data) && isRecord(data.sessions) && isRecord(data.sessions.query))) {
    return;
  }
  try {
    return parseSessionQueryRequest(data.sessions.query);
  } catch {
    return;
  }
};

const stripDestinationSessionPayload = (data: unknown, query: SessionQueryRequest): unknown => {
  if (!isRecord(data)) {
    return data;
  }
  const seeded: SessionPagesSeedMarker = {
    campaignChildren: [],
    campaignSessions: [],
    query,
    seed: SESSION_PAGES_SEED,
    topLevel: { pageParams: [], pages: [] },
  };
  return { ...data, sessions: seeded };
};

const destinationCarriesSessionWindow = (data: unknown): boolean =>
  isRecord(data) && isRecord(data.sessions) && isRecord(data.sessions.topLevel) && !isSessionPagesSeed(data.sessions);

/**
 * Keep Session row payloads only on the canonical session-pages infinite query. Destination aliases
 * dehydrate a seed marker and are restored synchronously on hydrate (no browser refetch).
 */
export const canonicalizeReportSessionHydration = (state: WebQueryHydrationState): WebQueryHydrationState => {
  const canonicalIdentities = new Set<string>();
  for (const query of state.dehydratedState.queries) {
    const key = query.queryKey;
    if (!isSessionPagesQueryKey(key)) {
      continue;
    }
    const revision = typeof key[3] === 'string' ? key[3] : '';
    const fingerprint = typeof key[4] === 'string' ? key[4] : '';
    if (revision && fingerprint) {
      canonicalIdentities.add(sessionQueryIdentity(revision, fingerprint));
    }
  }
  if (canonicalIdentities.size === 0) {
    return state;
  }
  return {
    dehydratedState: {
      ...state.dehydratedState,
      queries: state.dehydratedState.queries.map((query) => {
        const key = query.queryKey;
        if (!(isReportDestinationQueryKey(key) && destinationCarriesSessionWindow(query.state.data))) {
          return query;
        }
        const sessionsQuery = destinationSessionsQuery(query.state.data);
        if (!sessionsQuery) {
          return query;
        }
        const identity = sessionQueryIdentity(sessionsQuery.revision, sessionQueryFingerprint(sessionsQuery));
        if (!canonicalIdentities.has(identity)) {
          return query;
        }
        return {
          ...query,
          state: {
            ...query.state,
            data: stripDestinationSessionPayload(query.state.data, sessionsQuery),
          },
        };
      }),
    },
  };
};

const seedDestinationSessionsFromSessionPages = (client: QueryClient): void => {
  const cache = client.getQueryCache().getAll();
  const sessionPagesByIdentity = new Map<string, unknown>();
  for (const query of cache) {
    const key = query.queryKey;
    if (!isSessionPagesQueryKey(key) || query.state.data === undefined) {
      continue;
    }
    const revision = typeof key[3] === 'string' ? key[3] : '';
    const fingerprint = typeof key[4] === 'string' ? key[4] : '';
    if (revision && fingerprint) {
      sessionPagesByIdentity.set(sessionQueryIdentity(revision, fingerprint), query.state.data);
    }
  }
  for (const query of cache) {
    const key = query.queryKey;
    if (!isReportDestinationQueryKey(key)) {
      continue;
    }
    const data = query.state.data;
    if (!(isRecord(data) && isSessionPagesSeed(data.sessions))) {
      continue;
    }
    const sessionsQuery = parseSessionQueryRequest(data.sessions.query);
    const topLevel = sessionPagesByIdentity.get(
      sessionQueryIdentity(sessionsQuery.revision, sessionQueryFingerprint(sessionsQuery)),
    );
    if (topLevel === undefined) {
      continue;
    }
    client.setQueryData(query.queryKey, {
      ...data,
      sessions: {
        campaignChildren: [],
        campaignSessions: [],
        query: sessionsQuery,
        topLevel,
      },
    });
  }
};

export const createWebQueryClient = (): QueryClient =>
  new TanStackQueryClient({
    defaultOptions: webQueryClientDefaultOptions,
  });

export const dehydrateWebQueryClient = (client: QueryClient): WebQueryHydrationState =>
  canonicalizeReportSessionHydration({
    dehydratedState: dehydrate(client, {
      shouldDehydrateMutation: () => false,
      shouldDehydrateQuery: (query) => query.state.status === 'success',
    }),
  });

export const mergeWebQueryHydrationStates = (
  ...states: readonly (WebQueryHydrationState | undefined)[]
): WebQueryHydrationState => {
  const queries = new Map<string, DehydratedState['queries'][number]>();
  const mutations: DehydratedState['mutations'] = [];
  for (const state of states) {
    if (!state) {
      continue;
    }
    for (const query of state.dehydratedState.queries) {
      const current = queries.get(query.queryHash);
      if (!current || query.state.dataUpdatedAt >= current.state.dataUpdatedAt) {
        queries.set(query.queryHash, query);
      }
    }
  }
  return { dehydratedState: { mutations, queries: [...queries.values()] } };
};

export const hydrateWebQueryClient = (client: QueryClient, state: WebQueryHydrationState): QueryClient => {
  hydrate(client, state.dehydratedState);
  seedDestinationSessionsFromSessionPages(client);
  return client;
};

export const createHydratedWebQueryClient = (state: WebQueryHydrationState): QueryClient =>
  hydrateWebQueryClient(createWebQueryClient(), state);
