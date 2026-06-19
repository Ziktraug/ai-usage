#!/usr/bin/env bun
import { ensureMachineConfig } from '@ai-usage/local-collectors';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { createLocalUsageSnapshot } from '@ai-usage/report-data';
import { startSnapshotServer } from '@ai-usage/sync/server';
import { Console, Effect } from 'effect';
import type { ServeArgs } from './cli';

const collectFreshSnapshot = (machine: { id: string; label: string }, args: ServeArgs) =>
  createLocalUsageSnapshot({
    machine,
    harness: args.harness,
    includeCursor: args.cursor,
    includeFacets: true,
  }).pipe(Effect.provide(LocalHistoryStorageLive));

const envNameForMachine = (label: string) =>
  `AI_USAGE_SYNC_${label.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'REMOTE'}_TOKEN`;

export const runServe = (args: ServeArgs) =>
  Effect.gen(function* () {
    const machine = yield* ensureMachineConfig;
    const token = args.token;
    const server = yield* startSnapshotServer({
      host: args.host,
      port: args.port,
      token,
      machine,
      collectSnapshot: () => Effect.runPromise(collectFreshSnapshot(machine, args)),
      onRequest: (event) => {
        const suffix = event.details ? ` ${event.details}` : '';
        console.log(
          `[serve] ${event.method} ${event.path} from ${event.remoteAddress} -> ${event.status}${suffix} duration=${event.durationMs}ms`,
        );
      },
    });

    yield* Console.log(`[serve] listening machine=${machine.label}`);
    for (const snapshotUrl of server.urls) {
      yield* Console.log(`[serve] snapshot=${snapshotUrl}`);
    }
    if (args.host !== 'localhost' && args.host !== '127.0.0.1' && args.host !== '::1') {
      yield* Console.log('Token auth enabled. Pass --token <secret> to merge clients.');
      const tokenEnv = envNameForMachine(machine.label);
      yield* Console.log('On another machine:');
      yield* Console.log(`  ${tokenEnv}=<secret>`);
      yield* Console.log(`  ai-usage sync add ${machine.label.replace(/\s+/g, '-').toLowerCase()} ${server.urls[0]} --token-env ${tokenEnv}`);
      yield* Console.log(`  ai-usage sync pull ${machine.label.replace(/\s+/g, '-').toLowerCase()}`);
    }
    yield* Console.log('Press Ctrl+C to stop.');
    yield* Effect.never;
  });
