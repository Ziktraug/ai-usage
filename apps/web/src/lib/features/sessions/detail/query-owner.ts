import type { SessionDetailResponse } from '@ai-usage/report-core/session-detail';
import type { SessionNeighborRequest, SessionNeighborResult } from '@ai-usage/report-core/session-query';
import type { SessionVcsResolveRequest, SessionVcsResolveResponse } from '@ai-usage/report-core/session-vcs';
import type { QueryClient, QueryKey } from '@tanstack/svelte-query';
import {
  sessionDetailQueryOptions,
  sessionNeighborsQueryOptions,
  sessionVcsQueryOptions,
} from '../../../query/options/session';
import type { SessionClientAdapter } from '../../../rpc/session-client';

type Operation = 'detail' | 'neighbors' | 'vcs';

export interface SessionDetailQueryOwner {
  readonly close: () => void;
  readonly loadDetail: (request: {
    readonly revision: string;
    readonly rowId: string;
  }) => Promise<SessionDetailResponse | undefined>;
  readonly loadNeighbors: (request: SessionNeighborRequest) => Promise<SessionNeighborResult | undefined>;
  readonly loadVcs: (request: SessionVcsResolveRequest) => Promise<SessionVcsResolveResponse | undefined>;
  readonly resetDetail: () => void;
  readonly resetVcs: () => void;
}

interface ActiveOperation {
  readonly generation: number;
  readonly queryKey: QueryKey;
}

const errorFromNeighbors = (result: Awaited<ReturnType<SessionClientAdapter['neighbors']>>): SessionNeighborResult => {
  if (result.ok) {
    return result.data;
  }
  throw new Error(result.error.message);
};

export const createSessionDetailQueryOwner = (options: {
  readonly client: SessionClientAdapter;
  readonly queryClient: QueryClient;
}): SessionDetailQueryOwner => {
  const active = new Map<Operation, ActiveOperation>();
  let closed = false;
  let generation = 0;

  const cancel = (operation: Operation): void => {
    const current = active.get(operation);
    active.delete(operation);
    if (current) {
      options.queryClient.cancelQueries({ exact: true, queryKey: current.queryKey }).catch(() => undefined);
    }
  };

  const run = async <Value>(
    operation: Operation,
    queryKey: QueryKey,
    load: () => Promise<Value>,
  ): Promise<Value | undefined> => {
    cancel(operation);
    const ticket = { generation: ++generation, queryKey };
    active.set(operation, ticket);
    try {
      const value = await load();
      return !closed && active.get(operation)?.generation === ticket.generation ? value : undefined;
    } finally {
      if (active.get(operation)?.generation === ticket.generation) {
        active.delete(operation);
      }
    }
  };

  const loadNeighbors = (request: SessionNeighborRequest): Promise<SessionNeighborResult | undefined> => {
    const query = sessionNeighborsQueryOptions(options.client, request, { browser: true });
    return run('neighbors', query.queryKey, async () =>
      errorFromNeighbors(await options.queryClient.fetchQuery(query)),
    );
  };

  const loadDetail = (request: {
    readonly revision: string;
    readonly rowId: string;
  }): Promise<SessionDetailResponse | undefined> => {
    const query = sessionDetailQueryOptions(options.client, request, { browser: true });
    return run('detail', query.queryKey, async () => await options.queryClient.fetchQuery(query));
  };

  const loadVcs = (request: SessionVcsResolveRequest): Promise<SessionVcsResolveResponse | undefined> => {
    const query = sessionVcsQueryOptions(options.client, request, { browser: true });
    return run('vcs', query.queryKey, async () => await options.queryClient.fetchQuery(query));
  };

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      cancel('neighbors');
      cancel('detail');
      cancel('vcs');
    },
    loadDetail,
    loadNeighbors,
    loadVcs,
    resetDetail: () => cancel('detail'),
    resetVcs: () => cancel('vcs'),
  };
};
