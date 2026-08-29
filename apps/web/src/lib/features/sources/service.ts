import type { SourceControlCommand } from '@ai-usage/report-core/source-control';
import type { SourceControlClient, SourceControlClientState } from '../../../source-control-client';
import { type PublicationInvalidatedQueryKey, publicationInvalidatedKeys } from '../../query/publication';

/**
 * Not only report keys any more: a finished publication also makes the skill observations that same
 * collection cycle wrote stale. The name says what the trigger is rather than what one dependent
 * happens to be.
 */
export type PublicationQueryKey = PublicationInvalidatedQueryKey;

export interface SourceControlService {
  readonly execute: (command: SourceControlCommand) => Promise<boolean>;
  readonly getState: () => SourceControlClientState;
  readonly start: () => void;
  readonly stop: () => void;
  readonly subscribe: (listener: (state: SourceControlClientState) => void) => () => void;
}

export interface SourceControlServiceOptions {
  readonly client: SourceControlClient;
  readonly invalidatePublishedQuery: (queryKey: PublicationQueryKey) => void;
}

/**
 * What identifies one *completed publication cycle* to this browser.
 *
 * Deliberately not the revision alone. When a cycle finds the report rows unchanged the store
 * renews the current revision instead of assembling a new one, and the engine emits
 * `report-published` only when the revision changes — so a revision-keyed trigger misses exactly the
 * case skill observations need it for: a collection that wrote observations and left the report
 * identical. That is not an edge case; it is the ordinary shape of an observation-only sweep.
 *
 * The source-control snapshot does carry the cycle, and it arrives on the same stream.
 * `publishedGeneration` advances to the data generation the cycle published, and `lastPublishedAt`
 * moves on every success, renewal included. Folding both in with the revision means any completed
 * cycle is a new identity. The renewed aliases are not collateral damage either: a renewal rewrites
 * the served revision's `publishedAt` and `expiresAt`, which the report manifest carries, so those
 * queries genuinely did go stale.
 */
const publicationIdentity = (state: SourceControlClientState): string | undefined => {
  const published = state.publication;
  const revision = published ? `${published.instanceId}:${published.revision}` : undefined;
  const publication = state.snapshot?.publication;
  const cycle =
    publication?.lastOutcome === 'success' && publication.lastPublishedAt
      ? `${state.snapshot?.instanceId}:${publication.publishedGeneration}:${publication.lastPublishedAt}`
      : undefined;
  if (revision === undefined && cycle === undefined) {
    return;
  }
  return `${revision ?? ''}|${cycle ?? ''}`;
};

export const createSourceControlService = ({
  client,
  invalidatePublishedQuery,
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
      for (const queryKey of publicationInvalidatedKeys()) {
        invalidatePublishedQuery(queryKey);
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
