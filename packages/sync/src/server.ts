import os from 'node:os';
import type { UsageMachine, UsageSnapshot } from '@ai-usage/core/snapshot';
import { Effect } from 'effect';
import { SyncServerError } from './errors';

export interface SnapshotRequestEvent {
  method: string;
  path: string;
  remoteAddress: string;
  status: number;
  durationMs: number;
  details?: string;
}

export interface SnapshotHttpHandlerInput {
  machine: UsageMachine;
  token: string | null;
  collectSnapshot: () => Promise<UsageSnapshot>;
  onRequest?: (event: SnapshotRequestEvent) => void;
}

export interface SnapshotServerInput extends SnapshotHttpHandlerInput {
  host: string;
  port: number;
}

export interface SnapshotServerHandle {
  port: number;
  urls: string[];
  stop: () => void;
}

export const lanHosts = () =>
  Object.values(os.networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);

export const displayHosts = (host: string) => {
  if (host === '0.0.0.0') return lanHosts();
  return [host];
};

const requestAddress = (req: Request) =>
  req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  req.headers.get('x-real-ip') ||
  'unknown';

const emitRequest = (
  input: SnapshotHttpHandlerInput,
  req: Request,
  url: URL,
  status: number,
  started: number,
  details?: string,
) => {
  input.onRequest?.({
    method: req.method,
    path: url.pathname,
    remoteAddress: requestAddress(req),
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
  async (req: Request): Promise<Response> => {
    const started = Date.now();
    const url = new URL(req.url);

    if (url.pathname === '/snapshot') {
      if (input.token) {
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${input.token}`) {
          emitRequest(input, req, url, 401, started, 'auth=denied');
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
          `auth=${input.token ? 'ok' : 'none'} rows=${snapshot.rows.length} warnings=${snapshot.warnings?.length ?? 0} generatedAt=${snapshot.generatedAt}`,
        );
        return jsonResponse(snapshot);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitRequest(input, req, url, 500, started, `error=${message}`);
        return jsonResponse({ error: message }, { status: 500 });
      }
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      emitRequest(input, req, url, 200, started);
      return jsonResponse({ ok: true, machine: { id: input.machine.id, label: input.machine.label } });
    }

    emitRequest(input, req, url, 404, started);
    return new Response('not found', { status: 404 });
  };

export const startSnapshotServer = (
  input: SnapshotServerInput,
): Effect.Effect<SnapshotServerHandle, SyncServerError> =>
  Effect.try({
    try: () => {
      const server = Bun.serve({
        hostname: input.host,
        port: input.port,
        fetch: createSnapshotHttpHandler(input),
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
          void server.stop();
        },
      };
    },
    catch: (cause) =>
      new SyncServerError({
        operation: 'startSnapshotServer',
        message: `startSnapshotServer ${input.host}:${input.port}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
