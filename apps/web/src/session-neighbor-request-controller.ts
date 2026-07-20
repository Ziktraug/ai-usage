import type { SessionNeighborResult } from '@ai-usage/report-core/session-query';

export interface SessionNeighborLoadRequest {
  requestKey: string;
  rowId: string;
}

export interface SessionNeighborRequestController {
  close: () => void;
  load: (request: SessionNeighborLoadRequest) => Promise<void>;
}

export interface SessionNeighborRequestControllerOptions {
  loadNeighbors: (rowId: string) => Promise<SessionNeighborResult | undefined>;
  onError: (error: unknown) => void;
  onLoadingChange: (loading: boolean) => void;
  onNeighbors: (neighbors: SessionNeighborResult | undefined) => void;
}

export const createSessionNeighborRequestController = (
  options: SessionNeighborRequestControllerOptions,
): SessionNeighborRequestController => {
  let pending: { completion: Promise<void>; requestKey: string } | undefined;
  let requestSequence = 0;

  return {
    close: () => {
      requestSequence += 1;
      pending = undefined;
      options.onNeighbors(undefined);
      options.onLoadingChange(false);
    },
    load: (request) => {
      if (pending?.requestKey === request.requestKey) {
        return pending.completion;
      }
      requestSequence += 1;
      const sequence = requestSequence;
      options.onNeighbors(undefined);
      options.onLoadingChange(true);
      const completion = options
        .loadNeighbors(request.rowId)
        .then((neighbors) => {
          if (sequence === requestSequence) {
            options.onNeighbors(neighbors);
          }
        })
        .catch((error: unknown) => {
          if (sequence === requestSequence) {
            options.onError(error);
          }
        })
        .finally(() => {
          if (sequence === requestSequence) {
            pending = undefined;
            options.onLoadingChange(false);
          }
        });
      pending = { completion, requestKey: request.requestKey };
      return completion;
    },
  };
};
