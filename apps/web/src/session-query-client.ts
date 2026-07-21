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

export const createSessionQueryCoordinator = (options: {
  onStateChange?: (state: SessionQueryState | undefined) => void;
  onRevisionExpired?: () => Promise<void>;
  revision?: () => string;
  source: SessionQuerySource;
}): SessionQueryCoordinator => {
  let currentState: SessionQueryState | undefined;
  let generation = 0;
  let selectedRowId: string | null = null;
  let closed = false;
  let operationId = 0;
  let preparedRequestId = 0;

  interface Operation {
    controller: AbortController;
    generation: number;
    id: number;
  }

  interface LoadMoreOperation extends Operation {
    promise: Promise<SessionQueryState | undefined>;
  }

  interface CampaignChildrenOperation extends Operation {
    promise: Promise<SessionQueryState | undefined>;
  }

  let startOperation: Operation | undefined;
  let prepareOperation: Operation | undefined;
  let loadMoreOperation: LoadMoreOperation | undefined;
  let neighborOperation: Operation | undefined;
  const campaignChildrenOperations = new Map<string, CampaignChildrenOperation>();

  const createOperation = (targetGeneration = generation): Operation => ({
    controller: new AbortController(),
    generation: targetGeneration,
    id: ++operationId,
  });

  const abortOperation = (operation: Operation | undefined): void => {
    operation?.controller.abort();
  };

  const cancelOperations = (): void => {
    abortOperation(startOperation);
    abortOperation(prepareOperation);
    abortOperation(loadMoreOperation);
    abortOperation(neighborOperation);
    for (const operation of campaignChildrenOperations.values()) {
      abortOperation(operation);
    }
    startOperation = undefined;
    prepareOperation = undefined;
    loadMoreOperation = undefined;
    neighborOperation = undefined;
    campaignChildrenOperations.clear();
  };

  const beginGeneration = (): number => {
    generation += 1;
    preparedRequestId += 1;
    cancelOperations();
    return generation;
  };

  const operationIsCurrent = (operation: Operation): boolean =>
    !(closed || operation.controller.signal.aborted) && operation.generation === generation;

  const publish = (state: SessionQueryState | undefined): void => {
    if (closed) {
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
    operation: Operation,
    retries: number,
  ): Promise<SessionQueryState | undefined> => {
    if (!operationIsCurrent(operation)) {
      return currentState;
    }
    let revision = options.revision?.();
    if (revision === undefined) {
      let manifestResult: WebReportRevisionManifestResult;
      try {
        manifestResult = await options.source.getManifest(operation.controller.signal);
      } catch (error) {
        if (!operationIsCurrent(operation)) {
          return currentState;
        }
        throw error;
      }
      if (!operationIsCurrent(operation)) {
        return currentState;
      }
      revision = manifestRevision(manifestResult);
    }
    const request = parseSessionQueryRequest({ ...scope, cursor: null, revision });
    const page = await readPage(request, operation.controller.signal);
    if (page === 'aborted') {
      return currentState;
    }
    if (page === 'expired') {
      if (retries <= 0) {
        throw new Error('Report revision expired while restarting the session query');
      }
      await options.onRevisionExpired?.();
      if (!operationIsCurrent(operation)) {
        return currentState;
      }
      return await startGeneration(scope, operation, retries - 1);
    }
    if (!operationIsCurrent(operation)) {
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
    publish(state);
    return state;
  };

  const restartCurrentGeneration = async (
    scope: SessionQueryScope,
    operation: Operation,
  ): Promise<SessionQueryState | undefined> => {
    await options.onRevisionExpired?.();
    if (!operationIsCurrent(operation)) {
      return currentState;
    }
    return await startGeneration(scope, operation, 1);
  };

  const start = (scope: SessionQueryScope): Promise<SessionQueryState | undefined> => {
    if (closed) {
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
    const operation = createOperation(beginGeneration());
    startOperation = operation;
    const promise = startGeneration(scope, operation, 1).catch((error: unknown) => {
      if (!operationIsCurrent(operation)) {
        return currentState;
      }
      throw error;
    });
    return promise.finally(() => {
      if (startOperation?.id === operation.id) {
        startOperation = undefined;
      }
    });
  };

  const prepare = async (scope: SessionQueryScope, revision: string): Promise<PreparedSessionQueryState> => {
    if (closed) {
      throw new DOMException('The session query coordinator is closed', 'AbortError');
    }
    abortOperation(prepareOperation);
    const preparedGeneration = generation;
    preparedRequestId += 1;
    const requestId = preparedRequestId;
    const operation = createOperation(preparedGeneration);
    prepareOperation = operation;
    const request = parseSessionQueryRequest({ ...scope, cursor: null, revision });
    try {
      const page = await readPage(request, operation.controller.signal);
      if (page === 'aborted') {
        throw operation.controller.signal.reason;
      }
      if (page === 'expired') {
        throw new SessionRevisionExpiredError();
      }
      return {
        generation: preparedGeneration,
        requestId,
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
    } finally {
      if (prepareOperation?.id === operation.id) {
        prepareOperation = undefined;
      }
    }
  };

  const canCommitPrepared = (prepared: PreparedSessionQueryState): boolean =>
    !closed && prepared.generation === generation && prepared.requestId === preparedRequestId;

  const commitPrepared = (prepared: PreparedSessionQueryState): SessionQueryState | undefined => {
    if (!canCommitPrepared(prepared)) {
      return;
    }
    beginGeneration();
    publish(prepared.state);
    return prepared.state;
  };

  const runLoadMore = async (
    operation: LoadMoreOperation,
    state: SessionQueryState,
  ): Promise<SessionQueryState | undefined> => {
    const scope: SessionQueryScope = (({ cursor: _cursor, revision: _revision, ...value }) => value)(state.query);
    publish({ ...state, loadingMore: true });
    try {
      const request = parseSessionQueryRequest({ ...state.query, cursor: state.nextCursor });
      const page = await readPage(request, operation.controller.signal);
      if (page === 'aborted' || !operationIsCurrent(operation)) {
        return currentState;
      }
      if (page === 'expired') {
        if (loadMoreOperation?.id === operation.id) {
          loadMoreOperation = undefined;
        }
        return await restartCurrentGeneration(scope, operation);
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
      if (loadMoreOperation?.id === operation.id) {
        loadMoreOperation = undefined;
      }
      publish(nextState);
      return nextState;
    } catch (error) {
      if (!operationIsCurrent(operation)) {
        return currentState;
      }
      throw error;
    } finally {
      if (loadMoreOperation?.id === operation.id) {
        loadMoreOperation = undefined;
        if (currentState?.loadingMore) {
          publish({ ...currentState, loadingMore: false });
        }
      }
    }
  };

  const loadMore = (): Promise<SessionQueryState | undefined> => {
    if (closed) {
      return Promise.resolve(currentState);
    }
    if (loadMoreOperation && operationIsCurrent(loadMoreOperation)) {
      return loadMoreOperation.promise;
    }
    const state = currentState;
    if (!state?.nextCursor) {
      return Promise.resolve(state);
    }
    const baseOperation = createOperation();
    const operation = baseOperation as LoadMoreOperation;
    operation.promise = runLoadMore(operation, state);
    loadMoreOperation = operation;
    return operation.promise;
  };

  const runLoadCampaignChildren = async (
    campaignKey: string,
    operation: CampaignChildrenOperation,
    state: SessionQueryState,
    existing: CampaignChildrenPageState | undefined,
  ): Promise<SessionQueryState | undefined> => {
    const request: SessionCampaignChildrenRequest = {
      campaignKey,
      query: parseSessionQueryRequest({ ...state.query, cursor: existing?.nextCursor ?? null }),
    };
    try {
      const sourceResult = await options.source.getCampaignChildren(request, operation.controller.signal);
      if (!operationIsCurrent(operation) || campaignChildrenOperations.get(campaignKey)?.id !== operation.id) {
        return currentState;
      }
      const result = parseSessionCampaignChildrenServerResult(sourceResult, request);
      if (!result.ok) {
        if (revisionExpired(result)) {
          campaignChildrenOperations.delete(campaignKey);
          const { cursor: _cursor, revision: _revision, ...scope } = state.query;
          return await restartCurrentGeneration(scope, operation);
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
      campaignChildrenOperations.delete(campaignKey);
      const nextState = { ...currentState, campaignChildren };
      publish(nextState);
      return nextState;
    } catch (error) {
      if (!operationIsCurrent(operation) || campaignChildrenOperations.get(campaignKey)?.id !== operation.id) {
        return currentState;
      }
      throw error;
    } finally {
      if (campaignChildrenOperations.get(campaignKey)?.id === operation.id) {
        campaignChildrenOperations.delete(campaignKey);
        if (currentState) {
          const campaignChildren = new Map(currentState.campaignChildren);
          const currentChildren = campaignChildren.get(campaignKey);
          if (currentChildren?.loading) {
            campaignChildren.set(campaignKey, { ...currentChildren, loading: false });
            publish({ ...currentState, campaignChildren });
          }
        }
      }
    }
  };

  const loadCampaignChildren = (campaignKey: string): Promise<SessionQueryState | undefined> => {
    if (closed) {
      return Promise.resolve(currentState);
    }
    const activeOperation = campaignChildrenOperations.get(campaignKey);
    if (activeOperation && operationIsCurrent(activeOperation)) {
      return activeOperation.promise;
    }
    const state = currentState;
    if (!state) {
      return Promise.resolve(undefined);
    }
    const existing = state.campaignChildren.get(campaignKey);
    if (existing !== undefined && existing.nextCursor === null) {
      return Promise.resolve(state);
    }
    const loadingChildren = new Map(state.campaignChildren);
    loadingChildren.set(campaignKey, {
      items: existing?.items ?? [],
      loading: true,
      nextCursor: existing?.nextCursor ?? null,
      totalCount: existing?.totalCount ?? 0,
    });
    publish({ ...state, campaignChildren: loadingChildren });
    const baseOperation = createOperation();
    const operation = baseOperation as CampaignChildrenOperation;
    operation.promise = runLoadCampaignChildren(campaignKey, operation, state, existing);
    campaignChildrenOperations.set(campaignKey, operation);
    return operation.promise;
  };

  const loadNeighborsWithRetry = async (
    rowId: string,
    operation: Operation,
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
      sourceResult = await options.source.getNeighbors(request, operation.controller.signal);
    } catch (error) {
      if (!operationIsCurrent(operation) || neighborOperation?.id !== operation.id) {
        return;
      }
      throw error;
    }
    if (!operationIsCurrent(operation) || neighborOperation?.id !== operation.id) {
      return;
    }
    const result = parseSessionNeighborServerResult(sourceResult, request);
    if (!result.ok) {
      if (revisionExpired(result) && retryExpired) {
        const { cursor: _cursor, revision: _revision, ...scope } = state.query;
        const restarted = await restartCurrentGeneration(scope, operation);
        if (restarted && operationIsCurrent(operation) && neighborOperation?.id === operation.id) {
          return await loadNeighborsWithRetry(rowId, operation, false);
        }
        return;
      }
      throw errorFromResult(result);
    }
    const neighbors = result.data;
    if (!operationIsCurrent(operation) || neighborOperation?.id !== operation.id) {
      return;
    }
    return neighbors;
  };

  const loadNeighbors = (rowId: string): Promise<SessionNeighborResult | undefined> => {
    if (closed) {
      return Promise.resolve(undefined);
    }
    abortOperation(neighborOperation);
    const operation = createOperation();
    neighborOperation = operation;
    const promise = loadNeighborsWithRetry(rowId, operation, true);
    return promise.finally(() => {
      if (neighborOperation?.id === operation.id) {
        neighborOperation = undefined;
      }
    });
  };

  const select = (rowId: string | null): void => {
    if (closed) {
      return;
    }
    selectedRowId = rowId;
    if (currentState) {
      publish({ ...currentState, selectedRowId });
    }
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    generation += 1;
    preparedRequestId += 1;
    cancelOperations();
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
