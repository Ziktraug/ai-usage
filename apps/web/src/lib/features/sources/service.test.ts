import { describe, expect, test } from 'bun:test';
import type { ReportPublishedEvent, SourceControlCommand } from '@ai-usage/report-core/source-control';
import type { SourceControlClient, SourceControlClientState } from '../../../source-control-client';
import { currentReportAliasKeys } from '../../query/publication';
import { createSourceControlService, type ReportQueryKey } from './service';

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
    const service = createSourceControlService({ client, invalidateReportQuery: () => undefined });
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

  test('deduplicates publications and invalidates only current Report aliases', () => {
    const client = new FakeClient();
    const invalidated: ReportQueryKey[] = [];
    const service = createSourceControlService({
      client,
      invalidateReportQuery: (queryKey) => invalidated.push(queryKey),
    });
    service.start();

    client.emit({ ...client.state, publication: publication('revision-a') });
    client.emit({ ...client.state, publication: publication('revision-a') });
    expect(invalidated).toEqual([...currentReportAliasKeys()]);

    client.emit({ ...client.state, publication: publication('revision-b') });
    expect(invalidated).toEqual([...currentReportAliasKeys(), ...currentReportAliasKeys()]);
    expect(invalidated.some((queryKey) => String(queryKey).includes('skill'))).toBe(false);
  });
});
