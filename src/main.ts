#!/usr/bin/env bun
import { Console, Effect, Layer } from 'effect';
import { helpText, parseCommand } from './cli';
import { collectSelectedHarnessRows } from './collectors';
import { formatAppError } from './errors';
import { LocalHistoryStorageLive } from './local-history';
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
  yield* Console.log(renderUsageReport(rows, command.args));
});

const formatDefect = (defect: unknown) => (defect instanceof Error ? defect.message : String(defect));

const runnable = app.pipe(
  Effect.as(0),
  Effect.catchAll((error) => Console.error(`Error: ${formatAppError(error)}`).pipe(Effect.as(1))),
  Effect.catchAllDefect((defect) => Console.error(`Error: ${formatDefect(defect)}`).pipe(Effect.as(1))),
  Effect.provide(Layer.mergeAll(LocalHistoryStorageLive, CliRuntimeLive)),
);

Effect.runPromise(runnable).then((code) => {
  if (code !== 0) process.exit(code);
});
