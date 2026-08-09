import { describe, expect, test } from 'bun:test';
import { handleSourceControlEndpoint } from './endpoint.server';

const trustedHeaders = {
  host: 'localhost:3000',
  origin: 'http://localhost:3000',
  'sec-fetch-site': 'same-origin',
};

describe('SvelteKit source-control endpoint boundary', () => {
  test('enforces demo and local-trust policy before loading the engine handler', async () => {
    let loads = 0;
    const loadHandler = () => {
      loads += 1;
      return Promise.resolve(() => Promise.resolve(new Response('unexpected')));
    };
    const demo = await handleSourceControlEndpoint({
      loadHandler,
      pathname: '/api/source-control',
      request: new Request('http://localhost:3000/api/source-control', { headers: trustedHeaders }),
      runtimeMode: 'demo',
    });
    const hostile = await handleSourceControlEndpoint({
      loadHandler,
      pathname: '/api/source-control',
      request: new Request('http://localhost:3000/api/source-control', {
        headers: { host: 'attacker.example', origin: 'http://attacker.example' },
      }),
      runtimeMode: 'live',
    });

    expect(demo.status).toBe(404);
    expect(hostile.status).toBe(403);
    expect(loads).toBe(0);
  });

  test('rejects wrong methods and oversized commands before acquisition', async () => {
    let loads = 0;
    const loadHandler = () => {
      loads += 1;
      return Promise.resolve(() => Promise.resolve(new Response('unexpected')));
    };
    const wrongMethod = await handleSourceControlEndpoint({
      loadHandler,
      pathname: '/api/source-control',
      request: new Request('http://localhost:3000/api/source-control', {
        headers: trustedHeaders,
        method: 'POST',
      }),
      runtimeMode: 'live',
    });
    const oversized = await handleSourceControlEndpoint({
      loadHandler,
      pathname: '/api/source-control/command',
      request: new Request('http://localhost:3000/api/source-control/command', {
        body: '{}',
        headers: { ...trustedHeaders, 'content-length': '4097' },
        method: 'POST',
      }),
      runtimeMode: 'live',
    });

    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
    expect(oversized.status).toBe(413);
    expect(loads).toBe(0);
  });

  test('delegates accepted GET and POST requests without changing their bodies', async () => {
    const observed: Array<{ body: string; method: string }> = [];
    const getResponse = await handleSourceControlEndpoint({
      loadHandler: () =>
        Promise.resolve((request) => {
          observed.push({ body: '', method: request.method });
          return Promise.resolve(new Response('stream', { status: 200 }));
        }),
      pathname: '/api/source-control',
      request: new Request('http://localhost:3000/api/source-control', { headers: trustedHeaders }),
      runtimeMode: 'live',
    });
    const postResponse = await handleSourceControlEndpoint({
      loadHandler: () =>
        Promise.resolve(async (request) => {
          observed.push({ body: await request.text(), method: request.method });
          return Response.json({ ok: true });
        }),
      pathname: '/api/source-control/command',
      request: new Request('http://localhost:3000/api/source-control/command', {
        body: '{"command":"run-all"}',
        headers: { ...trustedHeaders, 'content-type': 'application/json' },
        method: 'POST',
      }),
      runtimeMode: 'live',
    });

    expect(getResponse.status).toBe(200);
    expect(postResponse.status).toBe(200);
    expect(observed).toEqual([
      { body: '', method: 'GET' },
      { body: '{"command":"run-all"}', method: 'POST' },
    ]);
  });
});
