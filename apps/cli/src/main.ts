#!/usr/bin/env bun
import { collectSelectedHarnessRows } from '@ai-usage/local-collectors';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { Console, Effect, Layer } from 'effect';
import { helpText, parseCommand } from './cli';
import { formatAppError } from './errors';
import { renderQuota } from './quota';
import { setColor } from './render/colors';
import { renderUsageReport } from './report';
import { CliRuntime, CliRuntimeLive } from './runtime';

export const app = Effect.gen(function* () {
  const runtime = yield* CliRuntime;
  const command = yield* parseCommand(runtime.argv);

  if (command._tag === 'Help') {
    yield* Console.log(helpText);
    return;
  }

  if (command._tag === 'Quota') {
    yield* Effect.sync(() => setColor(command.color === null ? runtime.stdoutIsTTY : command.color));
    yield* Console.log(yield* renderQuota);
    return;
  }

  yield* Effect.sync(() => setColor(command.args.color === null ? runtime.stdoutIsTTY : command.args.color));
  const rows = yield* collectSelectedHarnessRows({
    harness: command.args.harness,
    includeCursor: command.args.cursor,
  });
  yield* writeStdout(`${renderUsageReport(rows, command.args)}\n`);
});

// Multi-megabyte outputs (e.g. --payload-json) get truncated when stdout is a
// pipe and the runtime exits before the async stream drains, so completion is
// gated on the write callback for the actual payload chunk before the explicit
// process.exit below. (Bun.write(Bun.stdout, …) busy-spins on a backed-up pipe
// once process.stdout has been touched, so the node stream is used throughout.)
const writeStdout = (text: string) =>
  Effect.async<void>((resume) => {
    process.stdout.write(text, () => resume(Effect.void));
  });

const formatDefect = (defect: unknown) => (defect instanceof Error ? defect.message : String(defect));

const runnable = app.pipe(
  Effect.as(0),
  Effect.catchAll((error) => Console.error(`Error: ${formatAppError(error)}`).pipe(Effect.as(1))),
  Effect.catchAllDefect((defect) => Console.error(`Error: ${formatDefect(defect)}`).pipe(Effect.as(1))),
  Effect.provide(Layer.mergeAll(LocalHistoryStorageLive, CliRuntimeLive)),
);

Effect.runPromise(runnable).then((code) => {
  process.exit(code);
});
