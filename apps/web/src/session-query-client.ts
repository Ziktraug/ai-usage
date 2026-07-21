import {
  isSessionSortField,
  MAX_SESSION_QUERY_PAGE_SIZE,
  parseSessionCampaignChildrenServerResult,
  parseSessionNeighborServerResult,
  parseSessionPageServerResult,
  parseSessionQueryRequest,
  type SessionCampaignChildrenRequest,
  type SessionCampaignChildrenResult,
  type SessionNeighborRequest,
  type SessionNeighborResult,
  type SessionPageItem,
  type SessionPageResult,
  type SessionPresentationRow,
  type SessionQueryRequest,
  type SessionQueryServerResult,
  sessionQueryFingerprint,
} from '@ai-usage/report-core/session-query';
import type { SortingState } from '@tanstack/solid-table';
import type { FieldFilters } from './dashboard-search';
import type { DateBounds } from './date-range';
import { createSessionQueryOperationOwner, type SessionQueryOperationContext } from './session-query-operation-owner';
import { reportManifestRequestFingerprint, type WebReportRevisionManifestResult } from './web-report-payload';

export const SERVED_SESSION_PAGE_SIZE = 100;

export type SessionQueryScope = Omit<SessionQueryRequest, 'cursor' | 'revision'>;

export interface DashboardSessionQueryInput {
  campaigns: boolean;
  fields: FieldFilters;
  harness: string[];
  machine: string[];
  pageSize?: number;
  query: string;
  range: DateBounds;
  sorting: SortingState;
}

export interface SessionQuerySource {
  getCampaignChildren: (
    request: SessionCampaignChildrenRequest,
    signal: AbortSignal,
  ) => Promise<SessionQueryServerResult<SessionCampaignChildrenResult>>;
  getManifest: (signal: AbortSignal) => Promise<WebReportRevisionManifestResult>;
  getNeighbors: (
    request: SessionNeighborRequest,
    signal: AbortSignal,
  ) => Promise<SessionQueryServerResult<SessionNeighborResult>>;
  getPage: (request: SessionQueryRequest, signal: AbortSignal) => Promise<SessionQueryServerResult<SessionPageResult>>;
}

export interface CampaignChildrenPageState {
  items: SessionPresentationRow[];
  loading: boolean;
  nextCursor: string | null;
  totalCount: number;
}

export interface SessionQueryState {
  campaignChildren: ReadonlyMap<string, CampaignChildrenPageState>;
  itemCount: number;
  items: SessionPageItem[];
  loadingMore: boolean;
  nextCursor: string | null;
  query: SessionQueryRequest;
  selectedRowId: string | null;
  sessionCount: number;
}

export interface PreparedSessionQueryState {
  generation: number;
  requestId: number;
  state: SessionQueryState;
}

const canonicalDate = (value: Date | null): string | null => {
  if (value === null) {
    return null;
  }
  const time = value.getTime();
  if (!Number.isFinite(time)) {
    throw new Error('Session query date bounds must be valid dates');
  }
  return new Date(time).toISOString();
};

export const buildDashboardSessionQueryScope = (input: DashboardSessionQueryInput): SessionQueryScope => {
  const sort = input.sorting.map(({ desc, id }) => {
    if (!isSessionSortField(id)) {
      throw new Error(`Unsupported session sort field: ${id}`);
    }
    return { desc, id };
  });
  const validated = parseSessionQueryRequest({
    campaigns: input.campaigns,
    cursor: null,
    filters: {
      fields: input.fields,
      harness: input.harness,
      machine: input.machine,
      query: input.query,
    },
    pageSize: input.pageSize ?? SERVED_SESSION_PAGE_SIZE,
    range: {
      from: canonicalDate(input.range.from),
      to: canonicalDate(input.range.to),
    },
    revision: 'pending-revision',
    sort: sort.length > 0 ? sort : [{ desc: true, id: 'date' }],
  });
  const { cursor: _cursor, revision: _revision, ...scope } = validated;
  return scope;
};

const revisionExpired = (result: Extract<SessionQueryServerResult<unknown>, { ok: false }>): boolean =>
  result.error.tag === 'RevisionExpired';

const errorFromResult = (result: Extract<SessionQueryServerResult<unknown>, { ok: false }>): Error =>
  new Error(result.error.message);

const manifestRevision = (result: WebReportRevisionManifestResult): string => {
  if (result.requestFingerprint !== reportManifestRequestFingerprint) {
    throw new Error('Report manifest request fingerprint mismatch');
  }
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.manifest.revision;
};

const rowsForState = (state: SessionQueryState): SessionPresentationRow[] =>
  state.items.map((item) => {
    if (item.kind !== 'campaign') {
      return item.row;
    }
    const children = state.campaignChildren.get(item.campaignKey)?.items;
    return {
      ...item.row,
      campaignKey: item.campaignKey,
      ...(children === undefined ? {} : { children }),
    };
  });

export const sessionRowsForState = (state: SessionQueryState | undefined): SessionPresentationRow[] =>
  state === undefined ? [] : rowsForState(state);

const appendUniqueRows = (
  current: SessionPresentationRow[],
  incoming: SessionPresentationRow[],
): SessionPresentationRow[] => {
  const ids = new Set(current.map((row) => row.rowId));
  const combined = [...current];
  for (const row of incoming) {
    if (!ids.has(row.rowId)) {
      ids.add(row.rowId);
      combined.push(row);
    }
  }
  return combined;
};

const appendUniqueItems = (current: SessionPageItem[], incoming: SessionPageItem[]): SessionPageItem[] => {
  const itemKey = (item: SessionPageItem): string =>
    item.kind === 'campaign' ? `campaign:${item.campaignKey}` : `session:${item.row.rowId}`;
  const keys = new Set(current.map(itemKey));
  const combined = [...current];
  for (const item of incoming) {
    const key = itemKey(item);
    if (!keys.has(key)) {
      keys.add(key);
      combined.push(item);
    }
  }
  return combined;
};

export interface SessionQueryCoordinator {
  canCommitPrepared: (prepared: PreparedSessionQueryState) => boolean;
  close: () => void;
  commitPrepared: (prepared: PreparedSessionQueryState) => SessionQueryState | undefined;
  loadCampaignChildren: (campaignKey: string) => Promise<SessionQueryState | undefined>;
  loadMore: () => Promise<SessionQueryState | undefined>;
  loadNeighbors: (rowId: string) => Promise<SessionNeighborResult | undefined>;
  prepare: (scope: SessionQueryScope, revision: string) => Promise<PreparedSessionQueryState>;
  select: (rowId: string | null) => void;
  start: (scope: SessionQueryScope) => Promise<SessionQueryState | undefined>;
  state: () => SessionQueryState | undefined;
}

export class SessionRevisionExpiredError extends Error {
  constructor() {
    super('The session report revision expired');
    this.name = 'SessionRevisionExpiredError';
  }
}

const START_OPERATION = 'start';
const PREPARE_OPERATION = 'prepare';
const LOAD_MORE_OPERATION = 'load-more';
const NEIGHBOR_OPERATION = 'neighbor';
const campaignChildrenOperation = (campaignKey: string): string => `campaign:${campaignKey}`;

export const createSessionQueryCoordinator = (options: {
  onStateChange?: (state: SessionQueryState | undefined) => void;
  onRevisionExpired?: () => Promise<void>;
  revision?: () => string;
  source: SessionQuerySource;
}): SessionQueryCoordinator => {
  let currentState: SessionQueryState | undefined;
  let selectedRowId: string | null = null;
  const operationOwner = createSessionQueryOperationOwner();

  const publish = (state: SessionQueryState | undefined): void => {
    if (operationOwner.isClosed()) {
      return;
    }
    currentState = state;
    options.onStateChange?.(state);
  };

  const readPage = async (
    request: SessionQueryRequest,
    signal: AbortSignal,
  ): Promise<SessionPageResult | 'aborted' | 'expired'> => {
    let sourceResult: Awaited<ReturnType<SessionQuerySource['getPage']>>;
    try {
      sourceResult = await options.source.getPage(request, signal);
    } catch (error) {
      if (signal.aborted) {
        return 'aborted';
      }
      throw error;
    }
    if (signal.aborted) {
      return 'aborted';
    }
    const result = parseSessionPageServerResult(sourceResult, request);
    if (!result.ok) {
      if (revisionExpired(result)) {
        return 'expired';
      }
      throw errorFromResult(result);
    }
    return result.data;
  };

  const startGeneration = async (
    scope: SessionQueryScope,
    operation: SessionQueryOperationContext,
    retries: number,
    beforePublish?: () => void,
  ): Promise<SessionQueryState | undefined> => {
    if (!operation.isCurrent()) {
      return currentState;
    }
    let revision = options.revision?.();
    if (revision === undefined) {
      let manifestResult: WebReportRevisionManifestResult;
      try {
        manifestResult = await options.source.getManifest(operation.signal);
      } catch (error) {
        if (!operation.isCurrent()) {
          return currentState;
        }
        throw error;
      }
      if (!operation.isCurrent()) {
        return currentState;
      }
      revision = manifestRevision(manifestResult);
    }
    const request = parseSessionQueryRequest({ ...scope, cursor: null, revision });
    const page = await readPage(request, operation.signal);
    if (page === 'aborted') {
      return currentState;
    }
    if (page === 'expired') {
      if (retries <= 0) {
        throw new Error('Report revision expired while restarting the session query');
      }
      await options.onRevisionExpired?.();
      if (!operation.isCurrent()) {
        return currentState;
      }
      return await startGeneration(scope, operation, retries - 1, beforePublish);
    }
    if (!operation.isCurrent()) {
      return currentState;
    }
    const state: SessionQueryState = {
      campaignChildren: new Map(),
      itemCount: page.itemCount,
      items: page.items,
      loadingMore: false,
      nextCursor: page.nextCursor,
      query: request,
      selectedRowId,
      sessionCount: page.sessionCount,
    };
    beforePublish?.();
    publish(state);
    return state;
  };

  const restartCurrentGeneration = async (
    scope: SessionQueryScope,
    operation: SessionQueryOperationContext,
    beforePublish?: () => void,
  ): Promise<SessionQueryState | undefined> => {
    await options.onRevisionExpired?.();
    if (!operation.isCurrent()) {
      return currentState;
    }
    return await startGeneration(scope, operation, 1, beforePublish);
  };

  const start = (scope: SessionQueryScope): Promise<SessionQueryState | undefined> => {
    if (operationOwner.isClosed()) {
      return Promise.resolve(currentState);
    }
    const revision = options.revision?.();
    if (
      revision !== undefined &&
      currentState?.query.revision === revision &&
      sessionQueryFingerprint(currentState.query) ===
        sessionQueryFingerprint(parseSessionQueryRequest({ ...scope, cursor: null, revision }))
    ) {
      return Promise.resolve(currentState);
    }
    const generation = operationOwner.beginGeneration();
    return operationOwner.run(
      START_OPERATION,
      async (operation) => {
        try {
          return await startGeneration(scope, operation, 1);
        } catch (error) {
          if (!operation.isCurrent()) {
            return currentState;
          }
          throw error;
        }
      },
      { generation },
    );
  };

  const prepare = async (scope: SessionQueryScope, revision: string): Promise<PreparedSessionQueryState> => {
    if (operationOwner.isClosed()) {
      throw new DOMException('The session query coordinator is closed', 'AbortError');
    }
    const ticket = operationOwner.prepareTicket();
    const request = parseSessionQueryRequest({ ...scope, cursor: null, revision });
    return await operationOwner.run(
      PREPARE_OPERATION,
      async (operation) => {
        const page = await readPage(request, operation.signal);
        if (page === 'aborted') {
          throw operation.signal.reason;
        }
        if (page === 'expired') {
          throw new SessionRevisionExpiredError();
        }
        return {
          generation: ticket.generation,
          requestId: ticket.requestId,
          state: {
            campaignChildren: new Map(),
            itemCount: page.itemCount,
            items: page.items,
            loadingMore: false,
            nextCursor: page.nextCursor,
            query: request,
            selectedRowId,
            sessionCount: page.sessionCount,
          },
        };
      },
      { generation: ticket.generation },
    );
  };

  const canCommitPrepared = (prepared: PreparedSessionQueryState): boolean => operationOwner.canCommit(prepared);

  const commitPrepared = (prepared: PreparedSessionQueryState): SessionQueryState | undefined => {
    if (!canCommitPrepared(prepared)) {
      return;
    }
    operationOwner.beginGeneration();
    publish(prepared.state);
    return prepared.state;
  };

  const runLoadMore = async (
    operation: SessionQueryOperationContext,
    state: SessionQueryState,
  ): Promise<SessionQueryState | undefined> => {
    const scope: SessionQueryScope = (({ cursor: _cursor, revision: _revision, ...value }) => value)(state.query);
    publish({ ...state, loadingMore: true });
    try {
      const request = parseSessionQueryRequest({ ...state.query, cursor: state.nextCursor });
      const page = await readPage(request, operation.signal);
      if (page === 'aborted' || !operation.isCurrent()) {
        return currentState;
      }
      if (page === 'expired') {
        return await restartCurrentGeneration(scope, operation, operation.release);
      }
      if (currentState?.query.revision !== request.revision) {
        return currentState;
      }
      const nextState: SessionQueryState = {
        ...currentState,
        itemCount: page.itemCount,
        items: appendUniqueItems(currentState.items, page.items),
        loadingMore: false,
        nextCursor: page.nextCursor,
        selectedRowId,
        sessionCount: page.sessionCount,
      };
      operation.release();
      publish(nextState);
      return nextState;
    } catch (error) {
      if (!operation.isCurrent()) {
        return currentState;
      }
      throw error;
    } finally {
      const loadingState = currentState;
      if (loadingState?.loadingMore && operation.release()) {
        publish({ ...loadingState, loadingMore: false });
      }
    }
  };

  const loadMore = (): Promise<SessionQueryState | undefined> => {
    if (operationOwner.isClosed()) {
      return Promise.resolve(currentState);
    }
    const state = currentState;
    if (!state?.nextCursor) {
      return Promise.resolve(state);
    }
    return operationOwner.run(LOAD_MORE_OPERATION, (operation) => runLoadMore(operation, state), {
      policy: 'coalesce',
    });
  };

  const runLoadCampaignChildren = async (
    campaignKey: string,
    operation: SessionQueryOperationContext,
    state: SessionQueryState,
    existing: CampaignChildrenPageState | undefined,
  ): Promise<SessionQueryState | undefined> => {
    const loadingChildren = new Map(state.campaignChildren);
    loadingChildren.set(campaignKey, {
      items: existing?.items ?? [],
      loading: true,
      nextCursor: existing?.nextCursor ?? null,
      totalCount: existing?.totalCount ?? 0,
    });
    publish({ ...state, campaignChildren: loadingChildren });
    const request: SessionCampaignChildrenRequest = {
      campaignKey,
      query: parseSessionQueryRequest({ ...state.query, cursor: existing?.nextCursor ?? null }),
    };
    try {
      const sourceResult = await options.source.getCampaignChildren(request, operation.signal);
      if (!operation.owns()) {
        return currentState;
      }
      const result = parseSessionCampaignChildrenServerResult(sourceResult, request);
      if (!result.ok) {
        if (revisionExpired(result)) {
          const { cursor: _cursor, revision: _revision, ...scope } = state.query;
          return await restartCurrentGeneration(scope, operation, operation.release);
        }
        throw errorFromResult(result);
      }
      if (!currentState) {
        return;
      }
      const campaignChildren = new Map(currentState.campaignChildren);
      campaignChildren.set(campaignKey, {
        items: appendUniqueRows(existing?.items ?? [], result.data.items),
        loading: false,
        nextCursor: result.data.nextCursor,
        totalCount: result.data.itemCount,
      });
      const nextState = { ...currentState, campaignChildren };
      operation.release();
      publish(nextState);
      return nextState;
    } catch (error) {
      if (!operation.owns()) {
        return currentState;
      }
      throw error;
    } finally {
      const activeState = currentState;
      if (activeState) {
        const campaignChildren = new Map(activeState.campaignChildren);
        const currentChildren = campaignChildren.get(campaignKey);
        if (currentChildren?.loading && operation.release()) {
          if (existing) {
            campaignChildren.set(campaignKey, { ...existing, loading: false });
          } else {
            campaignChildren.delete(campaignKey);
          }
          publish({ ...activeState, campaignChildren });
        }
      }
    }
  };

  const loadCampaignChildren = (campaignKey: string): Promise<SessionQueryState | undefined> => {
    if (operationOwner.isClosed()) {
      return Promise.resolve(currentState);
    }
    const operationKey = campaignChildrenOperation(campaignKey);
    const state = currentState;
    if (!state) {
      return Promise.resolve(undefined);
    }
    return operationOwner.run(
      operationKey,
      async (operation) => {
        const activeState = currentState ?? state;
        const existing = activeState.campaignChildren.get(campaignKey);
        if (existing !== undefined && existing.nextCursor === null && !existing.loading) {
          return activeState;
        }
        return await runLoadCampaignChildren(campaignKey, operation, activeState, existing);
      },
      { policy: 'coalesce' },
    );
  };

  const loadNeighborsWithRetry = async (
    rowId: string,
    operation: SessionQueryOperationContext,
    retryExpired: boolean,
  ): Promise<SessionNeighborResult | undefined> => {
    const state = currentState;
    if (!state) {
      return;
    }
    const request: SessionNeighborRequest = {
      query: parseSessionQueryRequest({ ...state.query, cursor: null }),
      rowId,
    };
    let sourceResult: Awaited<ReturnType<SessionQuerySource['getNeighbors']>>;
    try {
      sourceResult = await options.source.getNeighbors(request, operation.signal);
    } catch (error) {
      if (!operation.owns()) {
        return;
      }
      throw error;
    }
    if (!operation.owns()) {
      return;
    }
    const result = parseSessionNeighborServerResult(sourceResult, request);
    if (!result.ok) {
      if (revisionExpired(result) && retryExpired) {
        const { cursor: _cursor, revision: _revision, ...scope } = state.query;
        const restarted = await restartCurrentGeneration(scope, operation);
        if (restarted && operation.owns()) {
          return await loadNeighborsWithRetry(rowId, operation, false);
        }
        return;
      }
      throw errorFromResult(result);
    }
    const neighbors = result.data;
    if (!operation.owns()) {
      return;
    }
    return neighbors;
  };

  const loadNeighbors = (rowId: string): Promise<SessionNeighborResult | undefined> => {
    if (operationOwner.isClosed()) {
      return Promise.resolve(undefined);
    }
    return operationOwner.run(NEIGHBOR_OPERATION, (operation) => loadNeighborsWithRetry(rowId, operation, true));
  };

  const select = (rowId: string | null): void => {
    if (operationOwner.isClosed()) {
      return;
    }
    selectedRowId = rowId;
    if (currentState) {
      publish({ ...currentState, selectedRowId });
    }
  };

  const close = (): void => {
    operationOwner.close();
  };

  return {
    canCommitPrepared,
    close,
    commitPrepared,
    loadCampaignChildren,
    loadMore,
    loadNeighbors,
    prepare,
    select,
    start,
    state: () => currentState,
  };
};

export const createServedSessionQuerySource = (): SessionQuerySource => {
  const serverApi = () => import('./server/report-payload');
  const requestHeaders = { 'x-ai-usage-request-owner': 'session-query' };
  return {
    getCampaignChildren: async (request, signal) => {
      const { getReportSessionCampaignChildren } = await serverApi();
      return await getReportSessionCampaignChildren({ data: request, headers: requestHeaders, signal });
    },
    getManifest: async (signal) => {
      const { getReportRevisionManifest } = await serverApi();
      return await getReportRevisionManifest({ headers: requestHeaders, signal });
    },
    getNeighbors: async (request, signal) => {
      const { getReportSessionNeighbors } = await serverApi();
      return await getReportSessionNeighbors({ data: request, headers: requestHeaders, signal });
    },
    getPage: async (request, signal) => {
      const { getReportSessionPage } = await serverApi();
      return await getReportSessionPage({ data: request, headers: requestHeaders, signal });
    },
  };
};

export const isValidSessionPageSize = (pageSize: number): boolean =>
  Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_SESSION_QUERY_PAGE_SIZE;
