import type { SourceControlCommand } from '@ai-usage/report-core/source-control';
import type { SourceControlClient, SourceControlClientState } from '../../../source-control-client';
import { currentReportAliasKeys } from '../../query/publication';

export type ReportQueryKey = ReturnType<typeof currentReportAliasKeys>[number];

export interface SourceControlService {
  readonly execute: (command: SourceControlCommand) => Promise<boolean>;
  readonly getState: () => SourceControlClientState;
  readonly start: () => void;
  readonly stop: () => void;
  readonly subscribe: (listener: (state: SourceControlClientState) => void) => () => void;
}

export interface SourceControlServiceOptions {
  readonly client: SourceControlClient;
  readonly invalidateReportQuery: (queryKey: ReportQueryKey) => void;
}

const publicationIdentity = (state: SourceControlClientState): string | undefined => {
  const publication = state.publication;
  return publication ? `${publication.instanceId}:${publication.revision}` : undefined;
};

export const createSourceControlService = ({
  client,
  invalidateReportQuery,
}: SourceControlServiceOptions): SourceControlService => {
  const listeners = new Set<(state: SourceControlClientState) => void>();
  let state = client.getState();
  let unsubscribeClient: (() => void) | undefined;
  let observedPublication = publicationIdentity(state);

  const publish = (nextState: SourceControlClientState): void => {
    state = nextState;
    const nextPublication = publicationIdentity(nextState);
    if (nextPublication && nextPublication !== observedPublication) {
      observedPublication = nextPublication;
      for (const queryKey of currentReportAliasKeys()) {
        invalidateReportQuery(queryKey);
      }
    }
    for (const listener of listeners) {
      listener(state);
    }
  };

  const start = (): void => {
    if (unsubscribeClient) {
      return;
    }
    unsubscribeClient = client.subscribe(publish);
    client.start();
  };

  const stop = (): void => {
    if (!unsubscribeClient) {
      return;
    }
    const unsubscribe = unsubscribeClient;
    unsubscribeClient = undefined;
    unsubscribe();
    client.stop();
    state = client.getState();
    for (const listener of listeners) {
      listener(state);
    }
  };

  return {
    execute: client.execute,
    getState: () => state,
    start,
    stop,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  };
};
