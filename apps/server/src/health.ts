const jsonHeaders = Object.freeze({ 'content-type': 'application/json; charset=utf-8' });

const jsonResponse = (
  body: Readonly<Record<string, string>>,
  status: number,
  additionalHeaders?: HeadersInit,
): Response =>
  Response.json(body, {
    headers: { ...jsonHeaders, ...additionalHeaders },
    status,
  });

export interface PlatformHealthProbe {
  readonly checkReadiness: () => Promise<void>;
}

export const createPlatformHealthHandler =
  (probe: PlatformHealthProbe) =>
  async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (pathname !== '/health/live' && pathname !== '/health/ready') {
      return jsonResponse({ status: 'not-found' }, 404);
    }
    if (request.method !== 'GET') {
      return jsonResponse({ status: 'method-not-allowed' }, 405, { allow: 'GET' });
    }
    if (pathname === '/health/live') {
      return jsonResponse({ status: 'live' }, 200);
    }

    try {
      await probe.checkReadiness();
      return jsonResponse({ status: 'ready' }, 200);
    } catch {
      return jsonResponse({ status: 'not-ready' }, 503);
    }
  };
