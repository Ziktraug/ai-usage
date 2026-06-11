#!/usr/bin/env bun
import { Console, Effect, Layer } from 'effect';
import { type Args, helpText, parseCommand } from './cli';
import { collectClaude, collectCodex, collectCursor, collectOpenCode } from './collectors';
import { CliArgumentError, formatAppError, type LocalHistoryError } from './errors';
import { LocalHistoryStorageLive, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';
import { renderQuota } from './quota';
import { renderAnalytics } from './render/analytics';
import { clr, setColor } from './render/colors';
import { renderCSV } from './render/csv';
import { renderTable } from './render/table';
import { CliRuntime, CliRuntimeLive } from './runtime';
import type { Row } from './types';

const compareRows = (sort: 'date' | 'tokens' | 'cost') =>
  ({
    date: (a: Row, b: Row) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0),
    tokens: (a: Row, b: Row) => b.tokIn + b.tokOut + b.tokCr + b.tokCw - (a.tokIn + a.tokOut + a.tokCr + a.tokCw),
    cost: (a: Row, b: Row) => b.costApprox - a.costApprox,
  })[sort];

const parseCommandEffect = (argv: string[]) =>
  Effect.try({
    try: () => parseCommand(argv),
    catch: (cause) =>
      cause instanceof CliArgumentError
        ? cause
        : new CliArgumentError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

const collectRows = (args: Args) =>
  Effect.gen(function* () {
    const collectorEffects: Array<Effect.Effect<Row[], LocalHistoryError, LocalHistoryStorageService>> = [];
    const want = (h: string) => !args.harness || args.harness === h;
    if (want('claude')) collectorEffects.push(collectClaude);
    if (want('codex')) collectorEffects.push(collectCodex);
    if (want('opencode')) collectorEffects.push(collectOpenCode);
    if (want('cursor') && args.cursor) collectorEffects.push(collectCursor);
    return (yield* Effect.all(collectorEffects, { concurrency: 'unbounded' })).flat();
  });

const renderReport = (args: Args) =>
  Effect.gen(function* () {
    const rows = (yield* collectRows(args))
      .filter((row) => {
        const total = row.tokIn + row.tokOut + row.tokCr + row.tokCw;
        const activeAt = row.endDate ?? row.date;
        if (total < args.minTokens) return false;
        if (args.since && (!activeAt || activeAt < args.since)) return false;
        if (args.project && !row.project.toLowerCase().includes(args.project)) return false;
        return true;
      })
      .sort(compareRows(args.sort));

    if (args.json) return JSON.stringify(rows, null, 2);
    if (args.csv) return renderCSV(rows);

    const tableRows = args.limit ? rows.slice(0, args.limit) : rows;
    const output = [renderTable(tableRows, args.wide)];
    if (args.limit && rows.length > tableRows.length) {
      output.push(
        clr.dim(`  … ${rows.length - tableRows.length} more rows (analytics below cover all ${rows.length})`),
      );
    }
    output.push(renderAnalytics(rows));
    output.push(
      clr.dim(
        '\nNotes: Codex tokens are cumulative observed counters (proxy, not billing); Codex durations span the rollout file (resumed sessions look long, not active time).' +
          ' Cursor rows marked ~ are partial (counts stored server-side); ↳ = contains sub-agents.' +
          ' Tracked lines: OpenCode/Cursor only (Claude/Codex expose none locally).' +
          ' $API = hypothetical cost at current API rates (subscriptions bill differently); ? = no public rate.',
      ),
    );
    return output.join('\n');
  });

export const app = Effect.gen(function* () {
  const runtime = yield* CliRuntime;
  const command = yield* parseCommandEffect(runtime.argv);

  if (command._tag === 'Help') {
    yield* Console.log(helpText);
    return;
  }

  if (command._tag === 'Quota') {
    yield* Effect.sync(() =>
      setColor(runtime.argv.includes('--no-color') ? false : runtime.stdoutIsTTY || runtime.argv.includes('--color')),
    );
    yield* Console.log(yield* renderQuota);
    return;
  }

  yield* Effect.sync(() => setColor(command.args.color === null ? runtime.stdoutIsTTY : command.args.color));
  yield* Console.log(yield* renderReport(command.args));
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
