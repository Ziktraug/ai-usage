import { describe, expect, test } from 'bun:test';
import type { SessionNeighborResult } from '@ai-usage/report-core/session-query';
import { createSessionNeighborRequestController } from './session-neighbor-request-controller';

const neighborResult: SessionNeighborResult = {
  found: true,
  next: null,
  previous: null,
  requestFingerprint: 'session-neighbor-v1:0000000000000000',
  revision: 'revision-a',
};

describe('session neighbor request orchestration', () => {
  test('coalesces duplicate loads for the same report selection', async () => {
    const pending = Promise.withResolvers<SessionNeighborResult | undefined>();
    let loadCount = 0;
    const requests = createSessionNeighborRequestController({
      loadNeighbors: () => {
        loadCount += 1;
        return pending.promise;
      },
      onError: () => undefined,
      onLoadingChange: () => undefined,
      onNeighbors: () => undefined,
    });

    const firstLoad = requests.load({ requestKey: 'revision-a:row-a', rowId: 'row-a' });
    const duplicateLoad = requests.load({ requestKey: 'revision-a:row-a', rowId: 'row-a' });

    expect(loadCount).toBe(1);
    pending.resolve(undefined);
    await Promise.all([firstLoad, duplicateLoad]);
  });

  test('keeps neighbors cleared when a pending success resolves after close', async () => {
    const pending = Promise.withResolvers<SessionNeighborResult | undefined>();
    const events: string[] = [];
    const requests = createSessionNeighborRequestController({
      loadNeighbors: () => pending.promise,
      onError: () => events.push('error'),
      onLoadingChange: (loading) => events.push(`loading:${loading}`),
      onNeighbors: (neighbors) => events.push(neighbors ? 'neighbors' : 'clear'),
    });

    const load = requests.load({ requestKey: 'revision-a:row-a', rowId: 'row-a' });
    requests.close();
    pending.resolve(neighborResult);
    await load;

    expect(events).toEqual(['clear', 'loading:true', 'clear', 'loading:false']);
  });

  test('does not publish a pending error after close', async () => {
    const pending = Promise.withResolvers<SessionNeighborResult | undefined>();
    const events: string[] = [];
    const requests = createSessionNeighborRequestController({
      loadNeighbors: () => pending.promise,
      onError: () => events.push('error'),
      onLoadingChange: (loading) => events.push(`loading:${loading}`),
      onNeighbors: (neighbors) => events.push(neighbors ? 'neighbors' : 'clear'),
    });

    const load = requests.load({ requestKey: 'revision-a:row-a', rowId: 'row-a' });
    requests.close();
    pending.reject(new Error('late failure'));
    await load;

    expect(events).toEqual(['clear', 'loading:true', 'clear', 'loading:false']);
  });

  test('does not let a superseded success replace the current selection or stop its loading state', async () => {
    const pendingA = Promise.withResolvers<SessionNeighborResult | undefined>();
    const pendingB = Promise.withResolvers<SessionNeighborResult | undefined>();
    const events: string[] = [];
    const requests = createSessionNeighborRequestController({
      loadNeighbors: (rowId) => (rowId === 'row-a' ? pendingA.promise : pendingB.promise),
      onError: () => events.push('error'),
      onLoadingChange: (loading) => events.push(`loading:${loading}`),
      onNeighbors: (neighbors) => events.push(neighbors ? `neighbors:${neighbors.revision}` : 'clear'),
    });

    const loadA = requests.load({ requestKey: 'revision-a:row-a', rowId: 'row-a' });
    const loadB = requests.load({ requestKey: 'revision-b:row-b', rowId: 'row-b' });
    pendingA.resolve({ ...neighborResult, revision: 'revision-a' });
    await loadA;

    expect(events).toEqual(['clear', 'loading:true', 'clear', 'loading:true']);

    pendingB.resolve({ ...neighborResult, revision: 'revision-b' });
    await loadB;
    expect(events).toEqual(['clear', 'loading:true', 'clear', 'loading:true', 'neighbors:revision-b', 'loading:false']);
  });

  test('does not publish a superseded failure while the current selection is loading', async () => {
    const pendingA = Promise.withResolvers<SessionNeighborResult | undefined>();
    const pendingB = Promise.withResolvers<SessionNeighborResult | undefined>();
    const events: string[] = [];
    const requests = createSessionNeighborRequestController({
      loadNeighbors: (rowId) => (rowId === 'row-a' ? pendingA.promise : pendingB.promise),
      onError: () => events.push('error'),
      onLoadingChange: (loading) => events.push(`loading:${loading}`),
      onNeighbors: (neighbors) => events.push(neighbors ? 'neighbors' : 'clear'),
    });

    const loadA = requests.load({ requestKey: 'revision-a:row-a', rowId: 'row-a' });
    const loadB = requests.load({ requestKey: 'revision-b:row-b', rowId: 'row-b' });
    pendingA.reject(new Error('stale failure'));
    await loadA;

    expect(events).toEqual(['clear', 'loading:true', 'clear', 'loading:true']);

    pendingB.resolve(neighborResult);
    await loadB;
    expect(events).toEqual(['clear', 'loading:true', 'clear', 'loading:true', 'neighbors', 'loading:false']);
  });
});
