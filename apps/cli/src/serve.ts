#!/usr/bin/env bun
import { createUsageSnapshot } from '@ai-usage/core/snapshot';
import {
  collectHarnessFacets,
  collectSelectedHarnessRows,
  ensureMachineConfig,
  readMergedAiUsageConfig,
} from '@ai-usage/local-collectors';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { Console, Effect } from 'effect';
import type { ServeArgs } from './cli';

const collectFreshSnapshot = (machine: { id: string; label: string }, args: ServeArgs) =>
  Effect.gen(function* () {
    const config = yield* readMergedAiUsageConfig;
    const rows = yield* collectSelectedHarnessRows({
      harness: args.harness,
      includeCursor: args.cursor,
      keepSource: true,
      ...(config.cursor ? { cursorCsv: config.cursor } : {}),
    });
    const facets = yield* collectHarnessFacets({
      includeCursor: args.cursor && (!args.harness || args.harness === 'cursor'),
    });
    return createUsageSnapshot({ machine, rows, facets });
  }).pipe(Effect.provide(LocalHistoryStorageLive));

export const runServe = (args: ServeArgs) =>
  Effect.gen(function* () {
    const machine = yield* ensureMachineConfig;
    const token = args.token;

    const server = Bun.serve({
      hostname: args.host,
      port: args.port,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/snapshot') {
          if (token) {
            const auth = req.headers.get('authorization');
            if (auth !== `Bearer ${token}`) {
              return new Response('unauthorized', { status: 401 });
            }
          }
          try {
            const snapshot = await Effect.runPromise(collectFreshSnapshot(machine, args));
            return new Response(JSON.stringify(snapshot), {
              headers: { 'content-type': 'application/json; charset=utf-8' },
            });
          } catch (err) {
            return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            });
          }
        }

        if (url.pathname === '/' || url.pathname === '/health') {
          return new Response(JSON.stringify({ ok: true, machine: { id: machine.id, label: machine.label } }), {
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response('not found', { status: 404 });
      },
    });

    const display = args.host === 'localhost' ? 'localhost' : args.host;
    yield* Console.log(`Serving snapshot at http://${display}:${server.port}/snapshot`);
    if (args.host !== 'localhost' && args.host !== '127.0.0.1' && args.host !== '::1') {
      yield* Console.log('Token auth enabled. Pass --token <secret> to merge clients.');
    }
    yield* Console.log('Press Ctrl+C to stop.');
    yield* Effect.never;
  });
