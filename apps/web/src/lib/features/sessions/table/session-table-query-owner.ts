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
import type { ServedReportRefreshOutcome, ServedRevisionDescriptor } from '../../../../served-report-session';
import {
  createSessionQueryOperationOwner,
  type SessionQueryOperationContext,
  type SessionQueryPreparedTicket,
} from '../../../../session-query-operation-owner';
import {
  sessionCampaignChildrenQueryOptions,
  sessionPageKey,
  sessionPageQueryOptions,
} from '../../../query/options/session';
import { webQueryPolicies } from '../../../query/policies';
import type { SessionClientAdapter } from '../../../rpc/session-client';

export type SessionTableQueryScope = Omit<SessionQueryRequest, 'cursor' | 'revision'>;

export interface SessionCampaignPage {
  readonly items: readonly SessionPresentationRow[];
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly root: SessionPresentationRow | null;
  readonly sessionCount: number;
  readonly totalCount: number;
}

export interface SessionTableQueryState {
  readonly campaignChildren: ReadonlyMap<string, SessionCampaignPage>;
  readonly campaignSessions: ReadonlyMap<string, SessionCampaignPage>;
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

export type SessionTableCombinedCommitOutcome = 'published' | 'staged' | 'superseded';

export interface SessionTableQueryOwner {
  canCommit(prepared: PreparedSessionTableQuery): boolean;
  close(): void;
  commit(prepared: PreparedSessionTableQuery): boolean;
  commitWithVisible(prepared: PreparedSessionTableQuery, publishVisible: () => void): SessionTableCombinedCommitOutcome;
  loadCampaignChildren(campaignKey: string): Promise<SessionTableQueryState | undefined>;
  loadCampaignSessions(campaignKey: string): Promise<SessionTableQueryState | undefined>;
  loadMore(): Promise<SessionTableQueryState | undefined>;
  prepare(scope: SessionTableQueryScope, revision: string, signal?: AbortSignal): Promise<PreparedSessionTableQuery>;
  setRevisionRefresh(refresh: SessionTableRevisionRefresh | undefined): void;
  readonly snapshot: SessionTableQueryState | undefined;
}

export type SessionTableRevisionRefresh = (
  scope: SessionTableQueryScope,
) => Promise<ServedReportRefreshOutcome<ServedRevisionDescriptor>>;

export class SessionTableRevisionExpiredError extends Error {
  constructor() {
    super('The exact session report revision expired');
    this.name = 'SessionTableRevisionExpiredError';
  }
}

const PREPARE_OPERATION = 'prepare';
const LOAD_MORE_OPERATION = 'load-more';
const REVISION_REPLAY_OPERATION = 'revision-replay';
const SESSION_RECOVERY_TOKEN = Symbol('session-recovery-token');
interface RecoveryTaggedSessionScope extends SessionTableQueryScope {
  readonly [SESSION_RECOVERY_TOKEN]?: object;
}
interface SessionRecoveryTransaction {
  readonly campaignDepth: ReadonlyMap<string, number>;
  readonly campaignSessionDepth: ReadonlyMap<string, number>;
  readonly cleanup: () => void;
  readonly pageDepth: number;
  readonly previousState: SessionTableQueryState;
  readonly token: object;
}
const recoveryTokenForScope = (scope: SessionTableQueryScope): object | undefined =>
  (scope as RecoveryTaggedSessionScope)[SESSION_RECOVERY_TOKEN];
const scopeForRecovery = (scope: SessionTableQueryScope, token: object): RecoveryTaggedSessionScope => ({
  ...scope,
  [SESSION_RECOVERY_TOKEN]: token,
});
const campaignOperation = (campaignKey: string): string => `campaign:${campaignKey}`;
const campaignSessionsOperation = (campaignKey: string): string => `campaign-sessions:${campaignKey}`;
const pageItemKey = (item: SessionPageItem): string => item.campaignKey;
const rowKey = (row: SessionPresentationRow): string => row.rowId;
const scopeFromQuery = (query: SessionQueryRequest): SessionTableQueryScope => {
  const { cursor: _cursor, revision: _revision, ...scope } = query;
  return scope;
};
export const unfilteredCampaignQuery = (query: SessionQueryRequest, cursor: string | null): SessionQueryRequest =>
  parseSessionQueryRequest({
    ...query,
    cursor,
    filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
    range: { from: null, to: null },
  });

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
    return {
      ...item.row,
      campaignKey: item.campaignKey,
      ...(children === undefined ? {} : { children: [...children] }),
    };
  }) ?? [];

/** Rebuilds the first Sessions table state from the exact page dehydrated by the route. */
export const seedSessionTableQueryState = (options: {
  readonly queryClient: QueryClient;
  readonly revision: string;
  readonly scope: SessionTableQueryScope;
}): SessionTableQueryState | undefined => {
  const request = parseSessionQueryRequest({ ...options.scope, cursor: null, revision: options.revision });
  const result = options.queryClient.getQueryData<Awaited<ReturnType<SessionClientAdapter['page']>>>(
    sessionPageKey(request),
  );
  if (
    !result?.ok ||
    result.revision !== request.revision ||
    result.requestFingerprint !== sessionQueryFingerprint(request) ||
    result.data.revision !== request.revision ||
    result.data.requestFingerprint !== sessionQueryFingerprint(request)
  ) {
    return;
  }
  return {
    campaignChildren: new Map(),
    campaignSessions: new Map(),
    itemCount: result.data.itemCount,
    items: result.data.items,
    loadingMore: false,
    nextCursor: result.data.nextCursor,
    query: request,
    sessionCount: result.data.sessionCount,
  };
};

export const createSessionTableQueryOwner = (options: {
  readonly client: SessionClientAdapter;
  readonly onStateChange?: (state: SessionTableQueryState | undefined) => void;
  readonly queryClient: QueryClient;
}): SessionTableQueryOwner => {
  const operationOwner = createSessionQueryOperationOwner();
  let campaignPageDepth = new Map<string, number>();
  let campaignSessionPageDepth = new Map<string, number>();
  let loadedPageDepth = 0;
  let revisionRefresh: SessionTableRevisionRefresh | undefined;
  let recoveryTransaction: SessionRecoveryTransaction | undefined;
  let state: SessionTableQueryState | undefined;
  let suppressStateChange = false;
  let stagedVisibleCommit: (() => void) | undefined;

  const takeStagedVisibleCommit = (): (() => void) | undefined => {
    const visibleCommit = stagedVisibleCommit;
    stagedVisibleCommit = undefined;
    return visibleCommit;
  };

  const abandonRecovery = (transaction: SessionRecoveryTransaction): boolean => {
    if (recoveryTransaction !== transaction) {
      return false;
    }
    recoveryTransaction = undefined;
    state = transaction.previousState;
    campaignPageDepth = new Map(transaction.campaignDepth);
    campaignSessionPageDepth = new Map(transaction.campaignSessionDepth);
    loadedPageDepth = transaction.pageDepth;
    stagedVisibleCommit = undefined;
    suppressStateChange = false;
    transaction.cleanup();
    return true;
  };

  const publish = (nextState: SessionTableQueryState): SessionTableQueryState => {
    if (!operationOwner.isClosed()) {
      state = nextState;
      if (!suppressStateChange) {
        options.onStateChange?.(nextState);
      }
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

  const readCampaignPage = async (request: SessionCampaignChildrenRequest, operation: SessionQueryOperationContext) => {
    const query = sessionCampaignChildrenQueryOptions(options.client, request, { browser: true });
    const unlink = linkOperationAbort(operation, options.queryClient, query.queryKey);
    try {
      const result = await options.queryClient.fetchQuery(query);
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
    const activeRecovery = recoveryTransaction;
    if (activeRecovery && recoveryTokenForScope(scope) !== activeRecovery.token) {
      abandonRecovery(activeRecovery);
    }
    stagedVisibleCommit = undefined;
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
            campaignSessions: new Map(),
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

  const canCommit = (prepared: PreparedSessionTableQuery): boolean => operationOwner.canCommit(prepared.ticket);
  const applyPrepared = (prepared: PreparedSessionTableQuery): void => {
    loadedPageDepth = 1;
    campaignPageDepth = new Map();
    campaignSessionPageDepth = new Map();
    publish(prepared.state);
  };

  const commit = (prepared: PreparedSessionTableQuery): boolean => {
    if (!canCommit(prepared)) {
      return false;
    }
    applyPrepared(prepared);
    return true;
  };
  const commitWithVisible = (
    prepared: PreparedSessionTableQuery,
    publishVisible: () => void,
  ): SessionTableCombinedCommitOutcome => {
    if (!canCommit(prepared)) {
      return 'superseded';
    }
    applyPrepared(prepared);
    if (suppressStateChange) {
      stagedVisibleCommit = publishVisible;
      return 'staged';
    }
    publishVisible();
    return 'published';
  };

  const replayLoadedDepth = async (
    topLevelDepth: number,
    campaignDepth: ReadonlyMap<string, number>,
    campaignSessionDepth: ReadonlyMap<string, number>,
  ): Promise<void> => {
    await operationOwner.run(REVISION_REPLAY_OPERATION, async (operation) => {
      for (let pageIndex = 1; pageIndex < topLevelDepth; pageIndex += 1) {
        const current = state;
        if (!(current?.nextCursor && operation.owns())) {
          break;
        }
        const request = parseSessionQueryRequest({ ...current.query, cursor: current.nextCursor });
        const page = await readPage(request, operation);
        if (!(operation.owns() && state?.query.revision === request.revision)) {
          return;
        }
        loadedPageDepth += 1;
        publish({
          ...state,
          itemCount: page.itemCount,
          items: appendUnique(state.items, page.items, pageItemKey),
          loadingMore: false,
          nextCursor: page.nextCursor,
          sessionCount: page.sessionCount,
        });
      }

      for (const [campaignKey, depth] of campaignDepth) {
        if (!(operation.owns() && state?.items.some((item) => item.campaignKey === campaignKey))) {
          continue;
        }
        let items: readonly SessionPresentationRow[] = [];
        let nextCursor: string | null = null;
        let totalCount = 0;
        let root: SessionPresentationRow | null = null;
        let sessionCount = 0;
        let replayedPages = 0;
        for (let pageIndex = 0; pageIndex < depth; pageIndex += 1) {
          if (!(operation.owns() && state)) {
            return;
          }
          const request = parseSessionCampaignChildrenRequest({
            campaignKey,
            query: parseSessionQueryRequest({ ...state.query, cursor: nextCursor }),
          });
          const page = await readCampaignPage(request, operation);
          items = appendUnique(items, page.items, rowKey);
          nextCursor = page.nextCursor;
          totalCount = page.itemCount;
          root = page.root;
          sessionCount = page.sessionCount;
          replayedPages += 1;
          if (nextCursor === null) {
            break;
          }
        }
        if (!(operation.owns() && state)) {
          return;
        }
        const children = new Map(state.campaignChildren);
        children.set(campaignKey, {
          items,
          loading: false,
          nextCursor,
          root,
          sessionCount,
          totalCount,
        });
        campaignPageDepth.set(campaignKey, replayedPages);
        publish({ ...state, campaignChildren: children });
      }

      for (const [campaignKey, depth] of campaignSessionDepth) {
        if (!(operation.owns() && state?.items.some((item) => item.campaignKey === campaignKey))) {
          continue;
        }
        let items: readonly SessionPresentationRow[] = [];
        let nextCursor: string | null = null;
        let root: SessionPresentationRow | null = null;
        let sessionCount = 0;
        let totalCount = 0;
        let replayedPages = 0;
        for (let pageIndex = 0; pageIndex < depth; pageIndex += 1) {
          if (!(operation.owns() && state)) {
            return;
          }
          const request = parseSessionCampaignChildrenRequest({
            campaignKey,
            query: unfilteredCampaignQuery(state.query, nextCursor),
          });
          const page = await readCampaignPage(request, operation);
          items = appendUnique(items, page.items, rowKey);
          nextCursor = page.nextCursor;
          root = page.root;
          sessionCount = page.sessionCount;
          totalCount = page.itemCount;
          replayedPages += 1;
          if (nextCursor === null) {
            break;
          }
        }
        if (!(operation.owns() && state)) {
          return;
        }
        const sessions = new Map(state.campaignSessions);
        sessions.set(campaignKey, {
          items,
          loading: false,
          nextCursor,
          root,
          sessionCount,
          totalCount,
        });
        campaignSessionPageDepth.set(campaignKey, replayedPages);
        publish({ ...state, campaignSessions: sessions });
      }
    });
  };

  const recoverExpiredRevision = async (cleanup: () => void): Promise<boolean> => {
    const current = state;
    if (!(current && revisionRefresh)) {
      cleanup();
      return false;
    }
    const transaction: SessionRecoveryTransaction = {
      campaignDepth: new Map(campaignPageDepth),
      campaignSessionDepth: new Map(campaignSessionPageDepth),
      cleanup,
      pageDepth: loadedPageDepth,
      previousState: current,
      token: {},
    };
    recoveryTransaction = transaction;
    suppressStateChange = true;
    stagedVisibleCommit = undefined;
    let outcome: ServedReportRefreshOutcome<ServedRevisionDescriptor>;
    try {
      outcome = await revisionRefresh(scopeForRecovery(scopeFromQuery(current.query), transaction.token));
    } catch (error) {
      if (!abandonRecovery(transaction)) {
        return false;
      }
      throw error;
    }
    if (recoveryTransaction !== transaction) {
      return false;
    }
    if (outcome.status === 'failed-preserving-previous') {
      abandonRecovery(transaction);
      throw outcome.error;
    }
    if (outcome.status === 'superseded') {
      abandonRecovery(transaction);
      return false;
    }
    try {
      await replayLoadedDepth(transaction.pageDepth, transaction.campaignDepth, transaction.campaignSessionDepth);
    } catch (error) {
      if (!abandonRecovery(transaction)) {
        return false;
      }
      throw error;
    }
    if (recoveryTransaction !== transaction) {
      return false;
    }
    recoveryTransaction = undefined;
    suppressStateChange = false;
    if (state) {
      options.onStateChange?.(state);
    }
    takeStagedVisibleCommit()?.();
    return true;
  };

  const loadMoreAttempt = (recoveredRevision: boolean): Promise<SessionTableQueryState | undefined> => {
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
          let page: Awaited<ReturnType<typeof readPage>>;
          try {
            page = await readPage(request, operation);
          } catch (error) {
            if (!(error instanceof SessionTableRevisionExpiredError && !recoveredRevision)) {
              throw error;
            }
            const recovered = await recoverExpiredRevision(() => {
              if (state?.query.revision === request.revision && state.loadingMore) {
                publish({ ...state, loadingMore: false });
              }
            });
            if (!recovered) {
              return state;
            }
            return await loadMoreAttempt(true);
          }
          if (!(operation.owns() && state?.query.revision === request.revision)) {
            return state;
          }
          operation.release();
          loadedPageDepth += 1;
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

  const loadMore = (): Promise<SessionTableQueryState | undefined> => loadMoreAttempt(false);

  const loadCampaignChildrenAttempt = (
    campaignKey: string,
    recoveredRevision: boolean,
  ): Promise<SessionTableQueryState | undefined> => {
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
          root: existing?.root ?? null,
          sessionCount: existing?.sessionCount ?? 0,
        });
        publish({ ...(state ?? current), campaignChildren: loadingChildren });

        const request = parseSessionCampaignChildrenRequest({
          campaignKey,
          query: parseSessionQueryRequest({
            ...(state ?? current).query,
            cursor: existing?.nextCursor ?? null,
          }),
        } satisfies SessionCampaignChildrenRequest);
        try {
          const page = await readCampaignPage(request, operation);
          if (!(operation.owns() && state)) {
            return state;
          }
          operation.release();
          const children = new Map(state.campaignChildren);
          children.set(campaignKey, {
            items: appendUnique(existing?.items ?? [], page.items, rowKey),
            loading: false,
            nextCursor: page.nextCursor,
            totalCount: page.itemCount,
            root: page.root,
            sessionCount: page.sessionCount,
          });
          campaignPageDepth.set(campaignKey, (campaignPageDepth.get(campaignKey) ?? 0) + 1);
          return publish({ ...state, campaignChildren: children });
        } catch (error) {
          if (!(error instanceof SessionTableRevisionExpiredError && !recoveredRevision)) {
            throw error;
          }
          const recovered = await recoverExpiredRevision(() => {
            if (state?.query.revision !== request.query.revision) {
              return;
            }
            const currentCampaign = state.campaignChildren.get(campaignKey);
            if (!currentCampaign?.loading) {
              return;
            }
            const children = new Map(state.campaignChildren);
            if (existing) {
              children.set(campaignKey, { ...existing, loading: false });
            } else {
              children.delete(campaignKey);
            }
            publish({ ...state, campaignChildren: children });
          });
          if (!recovered) {
            return state;
          }
          return await loadCampaignChildrenAttempt(campaignKey, true);
        } finally {
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

  const loadCampaignChildren = (campaignKey: string): Promise<SessionTableQueryState | undefined> =>
    loadCampaignChildrenAttempt(campaignKey, false);

  const loadCampaignSessionsAttempt = (
    campaignKey: string,
    recoveredRevision: boolean,
  ): Promise<SessionTableQueryState | undefined> => {
    const current = state;
    if (!(current && !operationOwner.isClosed())) {
      return Promise.resolve(current);
    }
    return operationOwner.run(
      campaignSessionsOperation(campaignKey),
      async (operation) => {
        const existing = state?.campaignSessions.get(campaignKey);
        if (existing && existing.nextCursor === null && !existing.loading) {
          return state;
        }
        const loadingSessions = new Map(state?.campaignSessions ?? current.campaignSessions);
        loadingSessions.set(campaignKey, {
          items: existing?.items ?? [],
          loading: true,
          nextCursor: existing?.nextCursor ?? null,
          root: existing?.root ?? null,
          sessionCount: existing?.sessionCount ?? 0,
          totalCount: existing?.totalCount ?? 0,
        });
        publish({ ...(state ?? current), campaignSessions: loadingSessions });

        const request = parseSessionCampaignChildrenRequest({
          campaignKey,
          query: unfilteredCampaignQuery((state ?? current).query, existing?.nextCursor ?? null),
        } satisfies SessionCampaignChildrenRequest);
        try {
          const page = await readCampaignPage(request, operation);
          if (!(operation.owns() && state)) {
            return state;
          }
          if (existing?.root && page.root && existing.root.rowId !== page.root.rowId) {
            throw new Error('Campaign root changed while paging one exact revision');
          }
          operation.release();
          const sessions = new Map(state.campaignSessions);
          sessions.set(campaignKey, {
            items: appendUnique(existing?.items ?? [], page.items, rowKey),
            loading: false,
            nextCursor: page.nextCursor,
            root: existing?.root ?? page.root,
            sessionCount: page.sessionCount,
            totalCount: page.itemCount,
          });
          campaignSessionPageDepth.set(campaignKey, (campaignSessionPageDepth.get(campaignKey) ?? 0) + 1);
          return publish({ ...state, campaignSessions: sessions });
        } catch (error) {
          if (!(error instanceof SessionTableRevisionExpiredError && !recoveredRevision)) {
            throw error;
          }
          const recovered = await recoverExpiredRevision(() => {
            if (state?.query.revision !== request.query.revision) {
              return;
            }
            const currentCampaign = state.campaignSessions.get(campaignKey);
            if (!currentCampaign?.loading) {
              return;
            }
            const sessions = new Map(state.campaignSessions);
            if (existing) {
              sessions.set(campaignKey, { ...existing, loading: false });
            } else {
              sessions.delete(campaignKey);
            }
            publish({ ...state, campaignSessions: sessions });
          });
          if (!recovered) {
            return state;
          }
          return await loadCampaignSessionsAttempt(campaignKey, true);
        } finally {
          if (operation.owns() && state?.campaignSessions.get(campaignKey)?.loading) {
            const sessions = new Map(state.campaignSessions);
            if (existing) {
              sessions.set(campaignKey, { ...existing, loading: false });
            } else {
              sessions.delete(campaignKey);
            }
            publish({ ...state, campaignSessions: sessions });
          }
        }
      },
      { policy: 'coalesce' },
    );
  };

  const loadCampaignSessions = async (campaignKey: string): Promise<SessionTableQueryState | undefined> => {
    const targetDepth = (campaignSessionPageDepth.get(campaignKey) ?? 0) + 1;
    while ((campaignPageDepth.get(campaignKey) ?? 0) < targetDepth) {
      const filteredPage = state?.campaignChildren.get(campaignKey);
      if (filteredPage && filteredPage.nextCursor === null && !filteredPage.loading) {
        break;
      }
      const previousDepth = campaignPageDepth.get(campaignKey) ?? 0;
      await loadCampaignChildrenAttempt(campaignKey, false);
      if ((campaignPageDepth.get(campaignKey) ?? 0) === previousDepth) {
        break;
      }
    }
    return await loadCampaignSessionsAttempt(campaignKey, false);
  };

  return {
    canCommit,
    close: () => {
      recoveryTransaction = undefined;
      stagedVisibleCommit = undefined;
      suppressStateChange = false;
      operationOwner.close();
    },
    commit,
    commitWithVisible,
    loadCampaignChildren,
    loadCampaignSessions,
    loadMore,
    prepare,
    setRevisionRefresh: (refresh) => {
      revisionRefresh = refresh;
    },
    get snapshot() {
      return state;
    },
  };
};
