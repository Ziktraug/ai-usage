import { describe, expect, test } from 'bun:test';
import { assertOutsideDemo, rejectProtectedDemoRequest, runOutsideDemo } from './demo-boundary.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';
import { resolveUsageReadModelForServer } from './usage-read-model-resolver.server';

describe('demo server boundary', () => {
  test('returns one non-disclosing response for local reads and mutations', () => {
    const requests = [
      new Request('http://127.0.0.1/_serverFn/report'),
      new Request('http://127.0.0.1/api/source-control'),
      new Request('http://127.0.0.1/api/source-control/command', { method: 'POST' }),
      new Request('http://127.0.0.1/sync', { method: 'POST' }),
    ];

    for (const request of requests) {
      const response = rejectProtectedDemoRequest(request, 'demo');
      expect(response?.status).toBe(404);
      expect(response?.headers.get('cache-control')).toBe('no-store');
    }
    expect(rejectProtectedDemoRequest(new Request('http://127.0.0.1/'), 'demo')).toBeNull();
  });

  test('does not construct a live handler in demo mode', async () => {
    let handlerConstructions = 0;
    const response = await runOutsideDemo(() => {
      handlerConstructions += 1;
      return new Response('live');
    }, 'demo');

    expect(handlerConstructions).toBe(0);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(404);
  });

  test('throws the same boundary response before a server-function adapter can load', () => {
    try {
      assertOutsideDemo('demo');
      throw new Error('Expected the demo boundary to reject the operation.');
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(404);
    }
  });

  test('does not load the live SQLite reader or engine client in demo mode', async () => {
    let liveControlLoads = 0;
    let liveReaderLoads = 0;
    const control = resolveUsageEngineControlClientForServer('demo', () => {
      liveControlLoads += 1;
      return Promise.reject(new Error('The live engine client loader must remain unreachable.'));
    });
    const reader = resolveUsageReadModelForServer('demo', () => {
      liveReaderLoads += 1;
      return Promise.reject(new Error('The live SQLite reader loader must remain unreachable.'));
    });

    const [controlResult, readerResult] = await Promise.allSettled([control, reader]);
    expect(controlResult.status).toBe('rejected');
    expect(readerResult.status).toBe('rejected');
    if (controlResult.status === 'rejected') {
      expect(controlResult.reason).toBeInstanceOf(Response);
      expect((controlResult.reason as Response).status).toBe(404);
    }
    if (readerResult.status === 'rejected') {
      expect(readerResult.reason).toBeInstanceOf(Response);
      expect((readerResult.reason as Response).status).toBe(404);
    }
    expect({ liveControlLoads, liveReaderLoads }).toEqual({ liveControlLoads: 0, liveReaderLoads: 0 });
  });
});
