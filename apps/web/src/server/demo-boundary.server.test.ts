import { describe, expect, test } from 'bun:test';
import { assertOutsideDemo, rejectProtectedDemoRequest, runOutsideDemo } from './demo-boundary.server';

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
});
