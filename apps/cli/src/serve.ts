#!/usr/bin/env bun
import os from 'node:os';
import { ensureMachineConfig } from '@ai-usage/local-collectors';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { createLocalUsageSnapshot } from '@ai-usage/reporting';
import { Console, Effect } from 'effect';
import type { ServeArgs } from './cli';

const collectFreshSnapshot = (machine: { id: string; label: string }, args: ServeArgs) =>
  createLocalUsageSnapshot({
    machine,
    harness: args.harness,
    includeCursor: args.cursor,
    includeFacets: true,
  }).pipe(Effect.provide(LocalHistoryStorageLive));

const lanHosts = () =>
  Object.values(os.networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);

const displayHosts = (host: string) => {
  if (host === '0.0.0.0') return lanHosts();
  return [host];
};

const envNameForMachine = (label: string) =>
  `AI_USAGE_SYNC_${label.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'REMOTE'}_TOKEN`;

const requestAddress = (req: Request) =>
  req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  req.headers.get('x-real-ip') ||
  'unknown';

const logRequest = (req: Request, url: URL, status: number, started: number, details = '') => {
  const suffix = details ? ` ${details}` : '';
  console.log(`[serve] ${req.method} ${url.pathname} from ${requestAddress(req)} -> ${status}${suffix} duration=${Date.now() - started}ms`);
};

export const runServe = (args: ServeArgs) =>
  Effect.gen(function* () {
    const machine = yield* ensureMachineConfig;
    const token = args.token;

    const server = Bun.serve({
      hostname: args.host,
      port: args.port,
      async fetch(req) {
        const started = Date.now();
        const url = new URL(req.url);

        if (url.pathname === '/snapshot') {
          if (token) {
            const auth = req.headers.get('authorization');
            if (auth !== `Bearer ${token}`) {
              logRequest(req, url, 401, started, 'auth=denied');
              return new Response('unauthorized', { status: 401 });
            }
          }
          try {
            const snapshot = await Effect.runPromise(collectFreshSnapshot(machine, args));
            logRequest(
              req,
              url,
              200,
              started,
              `auth=${token ? 'ok' : 'none'} rows=${snapshot.rows.length} warnings=${snapshot.warnings?.length ?? 0} generatedAt=${snapshot.generatedAt}`,
            );
            return new Response(JSON.stringify(snapshot), {
              headers: { 'content-type': 'application/json; charset=utf-8' },
            });
          } catch (err) {
            logRequest(req, url, 500, started, `error=${err instanceof Error ? err.message : String(err)}`);
            return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            });
          }
        }

        if (url.pathname === '/' || url.pathname === '/health') {
          logRequest(req, url, 200, started);
          return new Response(JSON.stringify({ ok: true, machine: { id: machine.id, label: machine.label } }), {
            headers: { 'content-type': 'application/json' },
          });
        }

        logRequest(req, url, 404, started);
        return new Response('not found', { status: 404 });
      },
    });

    const hosts = displayHosts(args.host);
    const urls = hosts.length ? hosts.map((host) => `http://${host}:${server.port}/snapshot`) : [`http://${args.host}:${server.port}/snapshot`];
    yield* Console.log(`[serve] listening machine=${machine.label}`);
    for (const snapshotUrl of urls) {
      yield* Console.log(`[serve] snapshot=${snapshotUrl}`);
    }
    if (args.host !== 'localhost' && args.host !== '127.0.0.1' && args.host !== '::1') {
      yield* Console.log('Token auth enabled. Pass --token <secret> to merge clients.');
      const tokenEnv = envNameForMachine(machine.label);
      yield* Console.log('On another machine:');
      yield* Console.log(`  ${tokenEnv}=<secret>`);
      yield* Console.log(`  ai-usage sync add ${machine.label.replace(/\s+/g, '-').toLowerCase()} ${urls[0]} --token-env ${tokenEnv}`);
      yield* Console.log(`  ai-usage sync pull ${machine.label.replace(/\s+/g, '-').toLowerCase()}`);
    }
    yield* Console.log('Press Ctrl+C to stop.');
    yield* Effect.never;
  });
