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
  ) => Promise<SessionQueryServerResult<SessionCampaignChildrenResult>>;
  getManifest: () => Promise<WebReportRevisionManifestResult>;
  getNeighbors: (request: SessionNeighborRequest) => Promise<SessionQueryServerResult<SessionNeighborResult>>;
  getPage: (request: SessionQueryRequest) => Promise<SessionQueryServerResult<SessionPageResult>>;
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
  return [...current, ...incoming.filter((row) => !ids.has(row.rowId))];
};

const appendUniqueItems = (current: SessionPageItem[], incoming: SessionPageItem[]): SessionPageItem[] => {
  const itemKey = (item: SessionPageItem): string =>
    item.kind === 'campaign' ? `campaign:${item.campaignKey}` : `session:${item.row.rowId}`;
  const keys = new Set(current.map(itemKey));
  return [...current, ...incoming.filter((item) => !keys.has(itemKey(item)))];
};

export interface SessionQueryCoordinator {
  canCommitPrepared: (prepared: PreparedSessionQueryState) => boolean;
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
  let loadMoreInFlight = false;
  let neighborSequence = 0;
  const childrenSequences = new Map<string, number>();

  const publish = (state: SessionQueryState | undefined): void => {
    currentState = state;
    options.onStateChange?.(state);
  };

  const readPage = async (request: SessionQueryRequest): Promise<SessionPageResult | 'expired'> => {
    const result = parseSessionPageServerResult(await options.source.getPage(request), request);
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
    targetGeneration: number,
    retries: number,
  ): Promise<SessionQueryState | undefined> => {
    const revision = options.revision?.() ?? manifestRevision(await options.source.getManifest());
    const request = parseSessionQueryRequest({ ...scope, cursor: null, revision });
    const page = await readPage(request);
    if (page === 'expired') {
      if (retries <= 0) {
        throw new Error('Report revision expired while restarting the session query');
      }
      await options.onRevisionExpired?.();
      if (generation !== targetGeneration) {
        return currentState;
      }
      return await startGeneration(scope, targetGeneration, retries - 1);
    }
    if (generation !== targetGeneration) {
      return;
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
    targetGeneration: number,
  ): Promise<SessionQueryState | undefined> => {
    await options.onRevisionExpired?.();
    if (generation !== targetGeneration) {
      return currentState;
    }
    return await startGeneration(scope, targetGeneration, 1);
  };

  const start = async (scope: SessionQueryScope): Promise<SessionQueryState | undefined> => {
    const revision = options.revision?.();
    if (
      revision !== undefined &&
      currentState?.query.revision === revision &&
      sessionQueryFingerprint(currentState.query) ===
        sessionQueryFingerprint(parseSessionQueryRequest({ ...scope, cursor: null, revision }))
    ) {
      return currentState;
    }
    generation += 1;
    const targetGeneration = generation;
    loadMoreInFlight = false;
    neighborSequence += 1;
    childrenSequences.clear();
    return await startGeneration(scope, targetGeneration, 1);
  };

  const prepare = async (scope: SessionQueryScope, revision: string): Promise<PreparedSessionQueryState> => {
    const preparedGeneration = generation;
    const request = parseSessionQueryRequest({ ...scope, cursor: null, revision });
    const page = await readPage(request);
    if (page === 'expired') {
      throw new SessionRevisionExpiredError();
    }
    return {
      generation: preparedGeneration,
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
  };

  const canCommitPrepared = (prepared: PreparedSessionQueryState): boolean => prepared.generation === generation;

  const commitPrepared = (prepared: PreparedSessionQueryState): SessionQueryState | undefined => {
    if (!canCommitPrepared(prepared)) {
      return;
    }
    generation += 1;
    loadMoreInFlight = false;
    neighborSequence += 1;
    childrenSequences.clear();
    publish(prepared.state);
    return prepared.state;
  };

  const loadMore = async (): Promise<SessionQueryState | undefined> => {
    const state = currentState;
    if (!(state?.nextCursor && !loadMoreInFlight)) {
      return state;
    }
    const targetGeneration = generation;
    const scope: SessionQueryScope = (({ cursor: _cursor, revision: _revision, ...value }) => value)(state.query);
    loadMoreInFlight = true;
    publish({ ...state, loadingMore: true });
    let nextState: SessionQueryState | undefined;
    try {
      const request = parseSessionQueryRequest({ ...state.query, cursor: state.nextCursor });
      const page = await readPage(request);
      if (page === 'expired') {
        loadMoreInFlight = false;
        return await restartCurrentGeneration(scope, targetGeneration);
      }
      if (generation !== targetGeneration || currentState?.query.revision !== request.revision) {
        return currentState;
      }
      nextState = {
        ...currentState,
        itemCount: page.itemCount,
        items: appendUniqueItems(currentState.items, page.items),
        loadingMore: false,
        nextCursor: page.nextCursor,
        selectedRowId,
        sessionCount: page.sessionCount,
      };
    } finally {
      loadMoreInFlight = false;
      if (!nextState && currentState?.loadingMore) {
        publish({ ...currentState, loadingMore: false });
      }
    }
    publish(nextState);
    return nextState;
  };

  const loadCampaignChildren = async (campaignKey: string): Promise<SessionQueryState | undefined> => {
    const state = currentState;
    if (!state) {
      return;
    }
    const existing = state.campaignChildren.get(campaignKey);
    if (existing?.loading || (existing !== undefined && existing.nextCursor === null)) {
      return state;
    }
    const targetGeneration = generation;
    const sequence = (childrenSequences.get(campaignKey) ?? 0) + 1;
    childrenSequences.set(campaignKey, sequence);
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
    const clearLoading = (): void => {
      if (generation !== targetGeneration || childrenSequences.get(campaignKey) !== sequence || !currentState) {
        return;
      }
      const campaignChildren = new Map(currentState.campaignChildren);
      const currentChildren = campaignChildren.get(campaignKey);
      if (currentChildren) {
        campaignChildren.set(campaignKey, { ...currentChildren, loading: false });
        publish({ ...currentState, campaignChildren });
      }
    };
    let result: Awaited<ReturnType<SessionQuerySource['getCampaignChildren']>>;
    try {
      result = parseSessionCampaignChildrenServerResult(await options.source.getCampaignChildren(request), request);
    } catch (error) {
      clearLoading();
      throw error;
    }
    if (!result.ok) {
      if (revisionExpired(result)) {
        const { cursor: _cursor, revision: _revision, ...scope } = state.query;
        return await restartCurrentGeneration(scope, targetGeneration);
      }
      clearLoading();
      throw errorFromResult(result);
    }
    const page = result.data;
    if (generation !== targetGeneration || childrenSequences.get(campaignKey) !== sequence || !currentState) {
      return currentState;
    }
    const campaignChildren = new Map(currentState.campaignChildren);
    campaignChildren.set(campaignKey, {
      items: appendUniqueRows(existing?.items ?? [], page.items),
      loading: false,
      nextCursor: page.nextCursor,
      totalCount: page.itemCount,
    });
    const nextState = { ...currentState, campaignChildren };
    publish(nextState);
    return nextState;
  };

  const loadNeighborsWithRetry = async (
    rowId: string,
    targetGeneration: number,
    sequence: number,
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
    const result = parseSessionNeighborServerResult(await options.source.getNeighbors(request), request);
    if (!result.ok) {
      if (revisionExpired(result) && retryExpired) {
        const { cursor: _cursor, revision: _revision, ...scope } = state.query;
        const restarted = await restartCurrentGeneration(scope, targetGeneration);
        if (restarted && generation === targetGeneration && neighborSequence === sequence) {
          return await loadNeighborsWithRetry(rowId, targetGeneration, sequence, false);
        }
        return;
      }
      throw errorFromResult(result);
    }
    const neighbors = result.data;
    if (generation !== targetGeneration || neighborSequence !== sequence) {
      return;
    }
    return neighbors;
  };

  const loadNeighbors = async (rowId: string): Promise<SessionNeighborResult | undefined> => {
    neighborSequence += 1;
    return await loadNeighborsWithRetry(rowId, generation, neighborSequence, true);
  };

  const select = (rowId: string | null): void => {
    selectedRowId = rowId;
    if (currentState) {
      publish({ ...currentState, selectedRowId });
    }
  };

  return {
    canCommitPrepared,
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
  return {
    getCampaignChildren: async (request) => {
      const { getReportSessionCampaignChildren } = await serverApi();
      return await getReportSessionCampaignChildren({ data: request });
    },
    getManifest: async () => {
      const { getReportRevisionManifest } = await serverApi();
      return await getReportRevisionManifest();
    },
    getNeighbors: async (request) => {
      const { getReportSessionNeighbors } = await serverApi();
      return await getReportSessionNeighbors({ data: request });
    },
    getPage: async (request) => {
      const { getReportSessionPage } = await serverApi();
      return await getReportSessionPage({ data: request });
    },
  };
};

export const isValidSessionPageSize = (pageSize: number): boolean =>
  Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_SESSION_QUERY_PAGE_SIZE;
