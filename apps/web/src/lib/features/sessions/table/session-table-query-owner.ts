import {
  parseSessionCampaignChildrenRequest,
  parseSessionQueryRequest,
  type SessionCampaignChildrenRequest,
  type SessionPageItem,
  type SessionPresentationRow,
  type SessionQueryRequest,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import type { QueryClient } from '@tanstack/svelte-query';
import type { ServedReportSessionAdapter, ServedRevisionDescriptor } from '../../../../served-report-session';
import {
  createSessionQueryOperationOwner,
  type SessionQueryOperationContext,
  type SessionQueryPreparedTicket,
} from '../../../../session-query-operation-owner';
import { sessionCampaignChildrenQueryOptions, sessionPageQueryOptions } from '../../../query/options/session';
import { webQueryPolicies } from '../../../query/policies';
import type { SessionClientAdapter } from '../../../rpc/session-client';

export type SessionTableQueryScope = Omit<SessionQueryRequest, 'cursor' | 'revision'>;

export interface SessionCampaignPage {
  readonly items: readonly SessionPresentationRow[];
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface SessionTableQueryState {
  readonly campaignChildren: ReadonlyMap<string, SessionCampaignPage>;
  readonly itemCount: number;
  readonly items: readonly SessionPageItem[];
  readonly loadingMore: boolean;
  readonly nextCursor: string | null;
  readonly query: SessionQueryRequest;
  readonly sessionCount: number;
}

export interface PreparedSessionTableQuery {
  readonly state: SessionTableQueryState;
  readonly ticket: SessionQueryPreparedTicket;
}

export interface SessionTableQueryOwner {
  close(): void;
  commit(prepared: PreparedSessionTableQuery): boolean;
  loadCampaignChildren(campaignKey: string): Promise<SessionTableQueryState | undefined>;
  loadMore(): Promise<SessionTableQueryState | undefined>;
  prepare(scope: SessionTableQueryScope, revision: string, signal?: AbortSignal): Promise<PreparedSessionTableQuery>;
  readonly snapshot: SessionTableQueryState | undefined;
}

export interface SessionTableDestination {
  readonly scope: SessionTableQueryScope;
}

export class SessionTableRevisionExpiredError extends Error {
  constructor() {
    super('The exact session report revision expired');
    this.name = 'SessionTableRevisionExpiredError';
  }
}

const PREPARE_OPERATION = 'prepare';
const LOAD_MORE_OPERATION = 'load-more';
const campaignOperation = (campaignKey: string): string => `campaign:${campaignKey}`;
const pageItemKey = (item: SessionPageItem): string => item.campaignKey;
const rowKey = (row: SessionPresentationRow): string => row.rowId;

const appendUnique = <Value>(
  current: readonly Value[],
  incoming: readonly Value[],
  keyFor: (value: Value) => string,
): Value[] => {
  const keys = new Set(current.map(keyFor));
  const combined = [...current];
  for (const value of incoming) {
    const key = keyFor(value);
    if (!keys.has(key)) {
      keys.add(key);
      combined.push(value);
    }
  }
  return combined;
};

const errorFromResult = (result: { readonly error: { readonly message: string; readonly tag: string } }): Error => {
  if (result.error.tag === 'RevisionExpired') {
    return new SessionTableRevisionExpiredError();
  }
  return new Error(result.error.message);
};

const linkOperationAbort = (
  operation: SessionQueryOperationContext,
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): (() => void) => {
  const cancel = (): Promise<void> => queryClient.cancelQueries({ exact: true, queryKey });
  operation.signal.addEventListener('abort', cancel, { once: true });
  return () => operation.signal.removeEventListener('abort', cancel);
};

export const sessionRowsForTableState = (
  state: SessionTableQueryState | undefined,
): readonly SessionPresentationRow[] =>
  state?.items.map((item) => {
    const children = state.campaignChildren.get(item.campaignKey)?.items;
    return { ...item.row, ...(children === undefined ? {} : { children: [...children] }) };
  }) ?? [];

export const createSessionTableQueryOwner = (options: {
  readonly client: SessionClientAdapter;
  readonly onStateChange?: (state: SessionTableQueryState | undefined) => void;
  readonly queryClient: QueryClient;
}): SessionTableQueryOwner => {
  const operationOwner = createSessionQueryOperationOwner();
  let state: SessionTableQueryState | undefined;

  const publish = (nextState: SessionTableQueryState): SessionTableQueryState => {
    if (!operationOwner.isClosed()) {
      state = nextState;
      options.onStateChange?.(nextState);
    }
    return nextState;
  };

  const readPage = async (request: SessionQueryRequest, operation: SessionQueryOperationContext) => {
    const query = sessionPageQueryOptions(options.client, request, { browser: true });
    const unlink = linkOperationAbort(operation, options.queryClient, query.queryKey);
    try {
      const result = await options.queryClient.fetchQuery({
        ...webQueryPolicies.immutableRevision,
        queryFn: async ({ signal }) => await options.client.page(request, signal),
        queryKey: query.queryKey,
      });
      if (!result.ok) {
        throw errorFromResult(result);
      }
      return result.data;
    } finally {
      unlink();
    }
  };

  const prepare = (
    scope: SessionTableQueryScope,
    revision: string,
    signal?: AbortSignal,
  ): Promise<PreparedSessionTableQuery> => {
    const generation = operationOwner.beginGeneration();
    const ticket = operationOwner.prepareTicket();
    const request = parseSessionQueryRequest({ ...scope, cursor: null, revision });
    return operationOwner.run(
      PREPARE_OPERATION,
      async (operation) => {
        const page = await readPage(request, operation);
        if (!operation.isCurrent()) {
          throw operation.signal.reason;
        }
        return {
          state: {
            campaignChildren: new Map(),
            itemCount: page.itemCount,
            items: page.items,
            loadingMore: false,
            nextCursor: page.nextCursor,
            query: request,
            sessionCount: page.sessionCount,
          },
          ticket,
        };
      },
      { generation, ...(signal === undefined ? {} : { signal }) },
    );
  };

  const commit = (prepared: PreparedSessionTableQuery): boolean => {
    if (!operationOwner.canCommit(prepared.ticket)) {
      return false;
    }
    publish(prepared.state);
    return true;
  };

  const loadMore = (): Promise<SessionTableQueryState | undefined> => {
    const current = state;
    if (!(current?.nextCursor && !operationOwner.isClosed())) {
      return Promise.resolve(current);
    }
    return operationOwner.run(
      LOAD_MORE_OPERATION,
      async (operation) => {
        publish({ ...current, loadingMore: true });
        try {
          const request = parseSessionQueryRequest({ ...current.query, cursor: current.nextCursor });
          const page = await readPage(request, operation);
          if (!(operation.owns() && state?.query.revision === request.revision)) {
            return state;
          }
          return publish({
            ...state,
            itemCount: page.itemCount,
            items: appendUnique(state.items, page.items, pageItemKey),
            loadingMore: false,
            nextCursor: page.nextCursor,
            sessionCount: page.sessionCount,
          });
        } finally {
          if (operation.owns() && state?.loadingMore) {
            publish({ ...state, loadingMore: false });
          }
        }
      },
      { policy: 'coalesce' },
    );
  };

  const loadCampaignChildren = (campaignKey: string): Promise<SessionTableQueryState | undefined> => {
    const current = state;
    if (!(current && !operationOwner.isClosed())) {
      return Promise.resolve(current);
    }
    return operationOwner.run(
      campaignOperation(campaignKey),
      async (operation) => {
        const existing = state?.campaignChildren.get(campaignKey);
        if (existing && existing.nextCursor === null && !existing.loading) {
          return state;
        }
        const loadingChildren = new Map(state?.campaignChildren ?? current.campaignChildren);
        loadingChildren.set(campaignKey, {
          items: existing?.items ?? [],
          loading: true,
          nextCursor: existing?.nextCursor ?? null,
          totalCount: existing?.totalCount ?? 0,
        });
        publish({ ...(state ?? current), campaignChildren: loadingChildren });

        const request = parseSessionCampaignChildrenRequest({
          campaignKey,
          query: parseSessionQueryRequest({
            ...(state ?? current).query,
            cursor: existing?.nextCursor ?? null,
          }),
        } satisfies SessionCampaignChildrenRequest);
        const query = sessionCampaignChildrenQueryOptions(options.client, request, { browser: true });
        const unlink = linkOperationAbort(operation, options.queryClient, query.queryKey);
        try {
          const result = await options.queryClient.fetchQuery({
            ...webQueryPolicies.immutableRevision,
            queryFn: async ({ signal }) => await options.client.campaignChildren(request, signal),
            queryKey: query.queryKey,
          });
          if (!result.ok) {
            throw errorFromResult(result);
          }
          if (!(operation.owns() && state)) {
            return state;
          }
          const children = new Map(state.campaignChildren);
          children.set(campaignKey, {
            items: appendUnique(existing?.items ?? [], result.data.items, rowKey),
            loading: false,
            nextCursor: result.data.nextCursor,
            totalCount: result.data.itemCount,
          });
          return publish({ ...state, campaignChildren: children });
        } finally {
          unlink();
          if (operation.owns() && state?.campaignChildren.get(campaignKey)?.loading) {
            const children = new Map(state.campaignChildren);
            if (existing) {
              children.set(campaignKey, { ...existing, loading: false });
            } else {
              children.delete(campaignKey);
            }
            publish({ ...state, campaignChildren: children });
          }
        }
      },
      { policy: 'coalesce' },
    );
  };

  return {
    close: () => operationOwner.close(),
    commit,
    loadCampaignChildren,
    loadMore,
    prepare,
    get snapshot() {
      return state;
    },
  };
};

export const createSessionTableServedAdapter = <Descriptor extends ServedRevisionDescriptor>(options: {
  readonly acquire: (signal: AbortSignal) => Promise<Descriptor>;
  readonly owner: SessionTableQueryOwner;
}): ServedReportSessionAdapter<SessionTableDestination, PreparedSessionTableQuery, Descriptor> => {
  const adapter: ServedReportSessionAdapter<SessionTableDestination, PreparedSessionTableQuery, Descriptor> = {
    acquire: options.acquire,
    commit: (prepared) => {
      if (!options.owner.commit(prepared)) {
        throw new Error('The prepared session table destination was superseded before commit');
      }
    },
    destinationFingerprint: ({ scope }) =>
      sessionQueryFingerprint(parseSessionQueryRequest({ ...scope, cursor: null, revision: 'destination' })),
    isRevisionExpired: (error) => error instanceof SessionTableRevisionExpiredError,
    load: async ({ scope }, descriptor, signal) => await options.owner.prepare(scope, descriptor.revision, signal),
  };
  return adapter;
};
