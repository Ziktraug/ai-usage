const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

const trustFailure = (status: number, tag: string, message: string): Response =>
  Response.json({ ok: false, error: { tag, message } }, { status });

const parseTrustedHost = (host: string): URL | null => {
  try {
    const parsedHost = new URL(`http://${host}`);
    if (
      parsedHost.username !== '' ||
      parsedHost.password !== '' ||
      parsedHost.pathname !== '/' ||
      parsedHost.search !== '' ||
      parsedHost.hash !== '' ||
      !LOOPBACK_HOSTNAMES.has(parsedHost.hostname)
    ) {
      return null;
    }
    return parsedHost;
  } catch {
    return null;
  }
};

export const validateTrustedLocalRequest = (request: Request): Response | null => {
  const host = request.headers.get('host')?.trim();
  if (!host) {
    return trustFailure(400, 'MissingHost', 'Local application requests require a Host header.');
  }
  if (!parseTrustedHost(host)) {
    return trustFailure(403, 'UntrustedHost', 'Requests are only accepted by the local application.');
  }

  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return trustFailure(403, 'CrossOriginRequest', 'Requests are only accepted from this application.');
  }

  const requestUrl = new URL(request.url);
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.trim().toLowerCase();
  if (forwardedProtocol && forwardedProtocol !== requestUrl.protocol.slice(0, -1)) {
    return trustFailure(403, 'UntrustedForwardedProtocol', 'Forwarded protocol metadata does not match the request.');
  }

  const origin = request.headers.get('origin')?.trim();
  if (!origin) {
    return null;
  }

  try {
    const parsedOrigin = new URL(origin);
    const expectedOrigin = new URL(`${requestUrl.protocol}//${host}`).origin;
    if (origin !== parsedOrigin.origin) {
      return trustFailure(400, 'InvalidOrigin', 'The request Origin header is invalid.');
    }
    if (parsedOrigin.origin !== expectedOrigin) {
      return trustFailure(403, 'CrossOriginRequest', 'Requests are only accepted from this application.');
    }
  } catch {
    return trustFailure(400, 'InvalidOrigin', 'The request Origin or Host header is invalid.');
  }

  return null;
};
