import { describe, expect, test } from 'bun:test';
import type { ReportPublishedEvent, SourceControlCommand } from '@ai-usage/report-core/source-control';
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

  test('gives skill observations their only freshness path, since their policy revalidates on nothing', () => {
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
});
