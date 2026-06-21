import http from 'node:http';
import os from 'node:os';
import { safeTokenEqual } from '@ai-usage/report-core/auth';
import type { UsageMachine, UsageSnapshot } from '@ai-usage/report-core/snapshot';
import { Effect } from 'effect';
import { SyncServerError } from './errors';

export interface SnapshotRequestEvent {
  details?: string;
  durationMs: number;
  method: string;
  path: string;
  remoteAddress: string;
  status: number;
}

export interface SnapshotHttpHandlerInput {
  collectSnapshot: () => Promise<UsageSnapshot>;
  machine: UsageMachine;
  onRequest?: (event: SnapshotRequestEvent) => void;
  token: string | null;
}

export interface SnapshotServerInput extends SnapshotHttpHandlerInput {
  host: string;
  port: number;
}

export interface SnapshotServerHandle {
  port: number;
  stop: () => void | Promise<void>;
  urls: string[];
}

export const lanHosts = () =>
  Object.values(os.networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);

export const displayHosts = (host: string) => {
  if (host === '0.0.0.0') {
    return lanHosts();
  }
  return [host];
};

const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const isLoopbackHost = (host: string) => loopbackHosts.has(host);

const requestAddress = (req: Request, clientAddress?: string) =>
  clientAddress ||
  req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  req.headers.get('x-real-ip') ||
  'unknown';

const emitRequest = (
  input: SnapshotHttpHandlerInput,
  req: Request,
  url: URL,
  status: number,
  started: number,
  clientAddress?: string,
  details?: string,
) => {
  input.onRequest?.({
    method: req.method,
    path: url.pathname,
    remoteAddress: requestAddress(req, clientAddress),
    status,
    durationMs: Date.now() - started,
    ...(details ? { details } : {}),
  });
};

const jsonResponse = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
  });

export const createSnapshotHttpHandler =
  (input: SnapshotHttpHandlerInput) =>
  async (req: Request, clientAddress?: string): Promise<Response> => {
    const started = Date.now();
    const url = new URL(req.url);

    if (url.pathname === '/snapshot') {
      if (input.token) {
        const auth = req.headers.get('authorization') ?? '';
        if (!safeTokenEqual(auth, `Bearer ${input.token}`)) {
          emitRequest(input, req, url, 401, started, clientAddress, 'auth=denied');
          return new Response('unauthorized', { status: 401 });
        }
      }

      try {
        const snapshot = await input.collectSnapshot();
        emitRequest(
          input,
          req,
          url,
          200,
          started,
          clientAddress,
          `auth=${input.token ? 'ok' : 'none'} rows=${snapshot.rows.length} warnings=${snapshot.warnings?.length ?? 0} generatedAt=${snapshot.generatedAt}`,
        );
        return jsonResponse(snapshot);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitRequest(input, req, url, 500, started, clientAddress, `error=${message}`);
        return jsonResponse({ error: message }, { status: 500 });
      }
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      emitRequest(input, req, url, 200, started, clientAddress);
      return jsonResponse({ ok: true, machine: { id: input.machine.id, label: input.machine.label } });
    }

    emitRequest(input, req, url, 404, started, clientAddress);
    return new Response('not found', { status: 404 });
  };

const ensureTokenForHost = (input: SnapshotServerInput): Effect.Effect<void, SyncServerError> =>
  input.token || isLoopbackHost(input.host)
    ? Effect.void
    : Effect.fail(
        new SyncServerError({
          operation: 'startSnapshotServer',
          message: `Refusing to bind ${input.host}:${input.port} without a token: a snapshot server reachable beyond localhost must require authentication.`,
        }),
      );

export const startSnapshotServer = (input: SnapshotServerInput): Effect.Effect<SnapshotServerHandle, SyncServerError> =>
  ensureTokenForHost(input).pipe(
    Effect.flatMap(() =>
      Effect.try({
        try: () => {
          const handler = createSnapshotHttpHandler(input);
          const server = Bun.serve({
            hostname: input.host,
            port: input.port,
            fetch: (req, srv) => handler(req, srv.requestIP(req)?.address),
          });
          const port = server.port ?? input.port;
          const hosts = displayHosts(input.host);
          const urls = hosts.length
            ? hosts.map((host) => `http://${host}:${port}/snapshot`)
            : [`http://${input.host}:${port}/snapshot`];

          return {
            port,
            urls,
            stop: () => {
              server.stop();
            },
          };
        },
        catch: (cause) =>
          new SyncServerError({
            operation: 'startSnapshotServer',
            message: `startSnapshotServer ${input.host}:${input.port}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      }),
    ),
  );

const requestFromIncomingMessage = (req: http.IncomingMessage) => {
  const host = req.headers.host ?? 'localhost';
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request(`http://${host}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
  });
};

const writeWebResponse = async (webResponse: Response, res: http.ServerResponse) => {
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(Buffer.from(await webResponse.arrayBuffer()));
};

export const startNodeSnapshotServer = (
  input: SnapshotServerInput,
): Effect.Effect<SnapshotServerHandle, SyncServerError> =>
  ensureTokenForHost(input).pipe(
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () =>
          new Promise<SnapshotServerHandle>((resolve, reject) => {
            const handler = createSnapshotHttpHandler(input);
            const server = http.createServer((req, res) => {
              handler(requestFromIncomingMessage(req), req.socket.remoteAddress ?? undefined)
                .then((response) => writeWebResponse(response, res))
                .catch((cause: unknown) => {
                  const message = cause instanceof Error ? cause.message : String(cause);
                  if (!res.headersSent) {
                    res.statusCode = 500;
                  }
                  res.end(JSON.stringify({ error: message }));
                });
            });

            const onError = (cause: Error) => {
              server.removeListener('listening', onListening);
              reject(cause);
            };
            const onListening = () => {
              server.removeListener('error', onError);
              const address = server.address();
              const port = typeof address === 'object' && address ? address.port : input.port;
              const hosts = displayHosts(input.host);
              const urls = hosts.length
                ? hosts.map((host) => `http://${host}:${port}/snapshot`)
                : [`http://${input.host}:${port}/snapshot`];
              resolve({
                port,
                urls,
                stop: () =>
                  new Promise<void>((stopResolve, stopReject) => {
                    server.close((error) => (error ? stopReject(error) : stopResolve()));
                  }),
              });
            };

            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(input.port, input.host);
          }),
        catch: (cause) =>
          new SyncServerError({
            operation: 'startNodeSnapshotServer',
            message: `startNodeSnapshotServer ${input.host}:${input.port}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      }),
    ),
  );
