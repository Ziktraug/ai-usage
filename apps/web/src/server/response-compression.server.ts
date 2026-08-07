import type { Handle } from '@sveltejs/kit';

/**
 * Content types worth compressing. Everything else the app serves is already compressed (fonts,
 * images) or too small for the round trip to matter.
 */
const COMPRESSIBLE_TYPE_PREFIXES = [
  'application/javascript',
  'application/json',
  'image/svg+xml',
  'text/css',
  'text/html',
  'text/javascript',
  'text/plain',
] as const;

type ResponseEncoding = 'deflate' | 'gzip';

/**
 * Server-rendered report documents and focused Overview payloads are large, highly repetitive JSON
 * and markup — they compress by better than an order of magnitude. Neither the Bun adapter nor
 * SvelteKit compresses dynamic responses, so without this every byte of the report goes out raw.
 *
 * The body is piped through a `CompressionStream` rather than buffered, so streaming SSR keeps its
 * time-to-first-byte. Requests that advertise no encoding — notably the internal same-origin fetches
 * SvelteKit issues while running `load` on the server — are passed through untouched, which keeps
 * the serialised SSR fetch cache readable.
 */
const negotiatedEncoding = (acceptEncoding: string | null): ResponseEncoding | null => {
  if (!acceptEncoding) {
    return null;
  }
  const accepted = acceptEncoding.toLowerCase();
  if (accepted.includes('gzip')) {
    return 'gzip';
  }
  return accepted.includes('deflate') ? 'deflate' : null;
};

const isCompressible = (response: Response): boolean => {
  if (response.body === null || response.headers.has('content-encoding')) {
    return false;
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return COMPRESSIBLE_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix));
};

const withVaryOnEncoding = (headers: Headers): void => {
  const existing = headers.get('vary');
  if (!existing) {
    headers.set('vary', 'accept-encoding');
    return;
  }
  const alreadyVaries = existing.split(',').some((candidate) => candidate.trim().toLowerCase() === 'accept-encoding');
  if (!alreadyVaries) {
    headers.set('vary', `${existing}, accept-encoding`);
  }
};

export const handleResponseCompression: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  const encoding = negotiatedEncoding(event.request.headers.get('accept-encoding'));
  if (encoding === null || response.body === null || !isCompressible(response)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('content-encoding', encoding);
  // The compressed length is unknown up front and the original is now wrong.
  headers.delete('content-length');
  withVaryOnEncoding(headers);
  return new Response(response.body.pipeThrough(new CompressionStream(encoding)), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
