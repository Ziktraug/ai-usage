import { describe, expect, test } from 'bun:test';
import { createPlatformHealthHandler } from './health';

describe('platform health endpoints', () => {
  test('keeps liveness independent from database readiness', async () => {
    const handler = createPlatformHealthHandler({
      checkReadiness: () => Promise.reject(new Error('postgresql://private-host/secret')),
    });

    const live = await handler(new Request('http://platform.test/health/live'));
    const ready = await handler(new Request('http://platform.test/health/ready'));

    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'live' });
    expect(ready.status).toBe(503);
    expect(await ready.text()).toBe('{"status":"not-ready"}');
  });

  test('reports readiness only after the injected probe passes', async () => {
    let checks = 0;
    const handler = createPlatformHealthHandler({
      checkReadiness: () => {
        checks += 1;
        return Promise.resolve();
      },
    });

    const response = await handler(new Request('http://platform.test/health/ready'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
    expect(checks).toBe(1);
  });

  test('bounds unsupported paths and methods', async () => {
    const handler = createPlatformHealthHandler({ checkReadiness: () => Promise.resolve() });
    const missing = await handler(new Request('http://platform.test/private?database=secret'));
    const method = await handler(new Request('http://platform.test/health/ready', { method: 'POST' }));

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ status: 'not-found' });
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET');
    expect(await method.json()).toEqual({ status: 'method-not-allowed' });
  });
});
