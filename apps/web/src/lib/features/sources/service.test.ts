import { describe, expect, test } from 'bun:test';
import type {
  ReportPublishedEvent,
  SourceControlCommand,
  SourceControlView,
} from '@ai-usage/report-core/source-control';
import type { SourceControlClient, SourceControlClientState } from '../../../source-control-client';
import { skillObservationsKey } from '../../query/identities/skills';
import { currentReportAliasKeys, publicationInvalidatedKeys } from '../../query/publication';
import { createSourceControlService, type PublicationQueryKey } from './service';

const initialState: SourceControlClientState = {
  commandError: null,
  connection: 'stopped',
  pendingCommand: null,
  publication: null,
  snapshot: null,
};

const publication = (revision: string, instanceId = 'engine-a'): ReportPublishedEvent => ({
  instanceId,
  publishedAt: '2026-07-16T10:00:00.000Z',
  revision,
  sourceControlGeneration: 2,
});

/**
 * A source-control snapshot for one finished publication cycle. `revision` is a parameter rather
 * than a constant because the case that matters is two cycles that share one.
 */
const finishedCycle = (input: {
  readonly lastPublishedAt: string;
  readonly publishedGeneration: number;
  readonly revision: string;
}): SourceControlView => ({
  generatedAt: input.lastPublishedAt,
  generation: input.publishedGeneration,
  instanceId: 'engine-a',
  publication: {
    acknowledgedRequestGeneration: input.publishedGeneration,
    dirty: false,
    dirtyGeneration: input.publishedGeneration,
    lastOutcome: 'success',
    lastPublishedAt: input.lastPublishedAt,
    pendingDemand: false,
    publishedGeneration: input.publishedGeneration,
    queued: false,
    requestedGeneration: input.publishedGeneration,
    revision: input.revision,
    rtkCompletedGeneration: input.publishedGeneration,
    rtkRequiredGeneration: input.publishedGeneration,
    running: false,
  },
  queueDepth: 0,
  runningCount: 0,
  sources: [],
});

class FakeClient implements SourceControlClient {
  startCalls = 0;
  stopCalls = 0;
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  state = initialState;
  private readonly listeners = new Set<(state: SourceControlClientState) => void>();

  readonly execute = (_command: SourceControlCommand): Promise<boolean> => Promise.resolve(true);

  readonly getState = (): SourceControlClientState => this.state;

  readonly start = (): void => {
    this.startCalls += 1;
    this.emit({ ...this.state, connection: 'connecting' });
  };

  readonly stop = (): void => {
    this.stopCalls += 1;
    this.state = { ...this.state, connection: 'stopped' };
  };

  readonly subscribe = (listener: (state: SourceControlClientState) => void): (() => void) => {
    this.subscribeCalls += 1;
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.unsubscribeCalls += 1;
      this.listeners.delete(listener);
    };
  };

  emit(state: SourceControlClientState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

describe('Svelte source-control service', () => {
  test('owns one idempotent client subscription and disposes it exactly once', () => {
    const client = new FakeClient();
    const service = createSourceControlService({ client, invalidatePublishedQuery: () => undefined });
    const observed: SourceControlClientState[] = [];
    const unsubscribe = service.subscribe((state) => observed.push(state));

    service.start();
    service.start();
    expect(client.startCalls).toBe(1);
    expect(client.subscribeCalls).toBe(1);
    expect(service.getState().connection).toBe('connecting');

    unsubscribe();
    service.stop();
    service.stop();
    expect(client.unsubscribeCalls).toBe(1);
    expect(client.stopCalls).toBe(1);
    expect(observed.at(-1)?.connection).toBe('connecting');
  });

  test('deduplicates publications and refreshes everything the finished cycle wrote', () => {
    const client = new FakeClient();
    const invalidated: PublicationQueryKey[] = [];
    const service = createSourceControlService({
      client,
      invalidatePublishedQuery: (queryKey) => invalidated.push(queryKey),
    });
    service.start();

    client.emit({ ...client.state, publication: publication('revision-a') });
    client.emit({ ...client.state, publication: publication('revision-a') });
    expect(invalidated).toEqual([...publicationInvalidatedKeys()]);

    client.emit({ ...client.state, publication: publication('revision-b') });
    expect(invalidated).toEqual([...publicationInvalidatedKeys(), ...publicationInvalidatedKeys()]);
  });

  test('gives skill observations their prompt producer-driven freshness path', () => {
    const client = new FakeClient();
    const invalidated: PublicationQueryKey[] = [];
    const service = createSourceControlService({
      client,
      invalidatePublishedQuery: (queryKey) => invalidated.push(queryKey),
    });
    service.start();

    expect(invalidated).toEqual([]);
    client.emit({ ...client.state, publication: publication('revision-a') });

    // The collection cycle that produced this publication is the same one that wrote the
    // observations, so a completed publication is exactly when an open tab's copy goes stale.
    expect(invalidated).toContainEqual(skillObservationsKey());
    expect(publicationInvalidatedKeys()).toEqual([...currentReportAliasKeys(), skillObservationsKey()]);
  });

  test('an observation-only cycle that renews the revision still reaches the browser', () => {
    const client = new FakeClient();
    const invalidated: PublicationQueryKey[] = [];
    const service = createSourceControlService({
      client,
      invalidatePublishedQuery: (queryKey) => invalidated.push(queryKey),
    });
    service.start();

    const revision = 'e2e-revision-7';
    client.emit({
      ...client.state,
      publication: { ...publication(revision), publishedAt: '2026-07-16T10:00:00.000Z' },
      snapshot: finishedCycle({
        lastPublishedAt: '2026-07-16T10:00:00.000Z',
        publishedGeneration: 4,
        revision,
      }),
    });
    expect(invalidated).toEqual([...publicationInvalidatedKeys()]);
    invalidated.length = 0;

    // The next cycle imported skill observations and nothing else. With the report rows unchanged
    // the store renews the current revision rather than assembling a new one, so no
    // `report-published` event is emitted and `publication` here does not move — the snapshot is the
    // only place the finished cycle shows up. Keying on the revision would strand exactly the case
    // this signal exists for.
    client.emit({
      ...client.state,
      snapshot: finishedCycle({
        lastPublishedAt: '2026-07-16T10:05:00.000Z',
        publishedGeneration: 5,
        revision,
      }),
    });

    expect(invalidated).toEqual([...publicationInvalidatedKeys()]);
    expect(invalidated).toContainEqual(skillObservationsKey());

    // Still deduplicated: a snapshot that reports no new cycle re-invalidates nothing.
    invalidated.length = 0;
    client.emit({ ...client.state, connection: 'live' });
    expect(invalidated).toEqual([]);
  });
});
