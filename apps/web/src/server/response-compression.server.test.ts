import { describe, expect, it } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { handleResponseCompression } from './response-compression.server';

const eventFor = (acceptEncoding?: string): RequestEvent =>
  ({
    request: new Request('http://127.0.0.1/', {
      headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
    }),
  }) as RequestEvent;

const run = async (acceptEncoding: string | undefined, response: Response): Promise<Response> =>
  await handleResponseCompression({
    event: eventFor(acceptEncoding),
    resolve: () => response,
  } as unknown as Parameters<typeof handleResponseCompression>[0]);

const htmlResponse = (body: string): Response =>
  new Response(body, { headers: { 'content-length': String(body.length), 'content-type': 'text/html' } });

describe('response compression', () => {
  it('compresses html for clients that accept gzip and drops the stale length', async () => {
    const body = 'a repetitive report document '.repeat(500);
    const compressed = await run('gzip, deflate, br', htmlResponse(body));

    expect(compressed.headers.get('content-encoding')).toBe('gzip');
    expect(compressed.headers.get('content-length')).toBeNull();
    expect(compressed.headers.get('vary')).toBe('accept-encoding');
    const bytes = await compressed.arrayBuffer();
    expect(bytes.byteLength).toBeLessThan(body.length / 5);
  });

  it('compresses the focused report payloads that dominate the first load', async () => {
    const payload = JSON.stringify({ rows: Array.from({ length: 400 }, (_, index) => ({ cost: index, id: index })) });
    const compressed = await run('gzip', new Response(payload, { headers: { 'content-type': 'application/json' } }));

    expect(compressed.headers.get('content-encoding')).toBe('gzip');
    expect((await compressed.arrayBuffer()).byteLength).toBeLessThan(payload.length / 2);
  });

  it('passes through requests that advertise no encoding so SSR fetch caching stays readable', async () => {
    const body = '{"ok":true}';
    const passed = await run(undefined, new Response(body, { headers: { 'content-type': 'application/json' } }));

    expect(passed.headers.get('content-encoding')).toBeNull();
    expect(await passed.text()).toBe(body);
  });

  it('leaves already-encoded and non-textual responses alone', async () => {
    const encoded = await run(
      'gzip',
      new Response('x', { headers: { 'content-encoding': 'br', 'content-type': 'text/html' } }),
    );
    expect(encoded.headers.get('content-encoding')).toBe('br');

    const binary = await run('gzip', new Response('x', { headers: { 'content-type': 'image/png' } }));
    expect(binary.headers.get('content-encoding')).toBeNull();
  });

  it('preserves an existing vary header instead of replacing it', async () => {
    const response = htmlResponse('body');
    response.headers.set('vary', 'cookie');
    const compressed = await run('gzip', response);

    expect(compressed.headers.get('vary')).toBe('cookie, accept-encoding');
  });
});
