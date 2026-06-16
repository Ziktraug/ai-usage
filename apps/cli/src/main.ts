#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { applyProjectAliases } from '@ai-usage/core/project-alias';
import { createUsageSnapshot, mergeUsageSnapshots, parseUsageSnapshot } from '@ai-usage/core/snapshot';
import type { Row, SourcedRow } from '@ai-usage/core/types';
import { usageRowTokenTotal } from '@ai-usage/core/usage-row';
import { collectHarnessFacets, collectSelectedHarnessRows } from '@ai-usage/local-collectors';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig, readAiUsageConfig, writeMachineConfig } from '@ai-usage/local-collectors/machine-config';
import { Console, Effect, Layer } from 'effect';
import { helpText, parseCommand } from './cli';
import { CliArgumentError, formatAppError } from './errors';
import { renderQuota } from './quota';
import { setColor } from './render/colors';
import { fmtNum, pad, trunc } from './render/format';
import { renderUsageReport } from './report';
import { CliRuntime, CliRuntimeLive } from './runtime';
import { runServe } from './serve';
import { runSetupServer } from './setup';

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

  if (command._tag === 'Machine') {
    const machine = yield* ensureMachineConfig;
    yield* Console.log(`Machine: ${machine.label}\nID: ${machine.id}`);
    return;
  }

  if (command._tag === 'MachineSetLabel') {
    const machine = yield* ensureMachineConfig;
    const updated = { ...machine, label: command.label };
    yield* writeMachineConfig(updated);
    yield* Console.log(`Machine: ${updated.label}\nID: ${updated.id}`);
    return;
  }

  if (command._tag === 'Snapshot') {
    const machine = yield* ensureMachineConfig;
    const rows = yield* collectSelectedHarnessRows({
      harness: command.args.harness,
      includeCursor: command.args.cursor,
      keepSource: true,
    });
    const facets = yield* collectHarnessFacets({
      includeCursor: command.args.cursor && (!command.args.harness || command.args.harness === 'cursor'),
    });
    const snapshot = createUsageSnapshot({ machine, rows, facets });
    yield* writeFile(command.args.out, `${JSON.stringify(snapshot, null, 2)}\n`);
    yield* Console.log(`Wrote ${command.args.out}`);
    return;
  }

  if (command._tag === 'Merge') {
    yield* Effect.sync(() => setColor(command.args.color === null ? runtime.stdoutIsTTY : command.args.color));
    const snapshots = [];
    for (const file of command.args.files) {
      snapshots.push(yield* readSnapshotFile(file));
    }
    for (const url of command.args.remote) {
      snapshots.push(yield* fetchRemoteSnapshot(url, command.args.token));
    }
    if (command.args.local) {
      const machine = yield* ensureMachineConfig;
      const rows = yield* collectSelectedHarnessRows({
        harness: command.args.harness,
        includeCursor: command.args.cursor,
        keepSource: true,
      });
      snapshots.push(createUsageSnapshot({ machine, rows }));
    }
    const merged = mergeUsageSnapshots(snapshots);
    const rows = yield* applyConfiguredProjectAliases(merged.rows);
    yield* writeStdout(`${renderUsageReport(rows, command.args)}\n`);
    return;
  }

  if (command._tag === 'ProjectsList') {
    const snapshots = [];
    for (const file of command.args.files) {
      snapshots.push(yield* readSnapshotFile(file));
    }
    if (command.args.local) {
      const machine = yield* ensureMachineConfig;
      const rows = yield* collectSelectedHarnessRows({ harness: null, includeCursor: true, keepSource: true });
      snapshots.push(createUsageSnapshot({ machine, rows }));
    }
    const merged = mergeUsageSnapshots(snapshots);
    yield* writeStdout(`${renderProjectSources(merged.rows)}\n`);
    return;
  }

  if (command._tag === 'Setup') {
    yield* runSetupServer(command.args.files, command.args.local, command.args.port);
    return;
  }

  if (command._tag === 'Serve') {
    yield* runServe(command.args);
    return;
  }

  yield* Effect.sync(() => setColor(command.args.color === null ? runtime.stdoutIsTTY : command.args.color));
  const collectedRows = yield* collectSelectedHarnessRows({
    harness: command.args.harness,
    includeCursor: command.args.cursor,
    keepSource: true,
  });
  const rows = yield* applyConfiguredProjectAliases(collectedRows);
  const facets =
    command.args.format === 'html' || command.args.format === 'payload'
      ? yield* collectHarnessFacets({
          includeCursor: command.args.cursor && (!command.args.harness || command.args.harness === 'cursor'),
        })
      : undefined;
  yield* writeStdout(`${renderUsageReport(rows, command.args, facets)}\n`);
});

const applyConfiguredProjectAliases = (rows: Row[]) =>
  Effect.gen(function* () {
    const config = yield* readAiUsageConfig;
    return applyProjectAliases(rows, config.projectAliases ?? []);
  });

interface ProjectSourceSummary {
  project: string;
  machine: string;
  harness: string;
  sourcePath: string;
  sessions: number;
  tokens: number;
}

const projectFromRow = (row: Row) =>
  row.project || path.basename((row as Partial<SourcedRow>).source?.sourcePath ?? '') || '(unknown)';

const renderProjectSources = (rows: Row[]) => {
  const summaries = new Map<string, ProjectSourceSummary>();
  for (const row of rows) {
    const source = (row as Partial<SourcedRow>).source;
    const summary: ProjectSourceSummary = {
      project: projectFromRow(row),
      machine: source?.machineLabel ?? 'Unknown machine',
      harness: row.harness,
      sourcePath: source?.sourcePath ?? '',
      sessions: 0,
      tokens: 0,
    };
    const key = [summary.project, summary.machine, summary.harness, summary.sourcePath].join('|');
    const current = summaries.get(key) ?? summary;
    current.sessions++;
    current.tokens += usageRowTokenTotal(row);
    summaries.set(key, current);
  }

  const cols = [
    { h: 'Project', w: 20, f: (s: ProjectSourceSummary) => s.project },
    { h: 'Machine', w: 18, f: (s: ProjectSourceSummary) => s.machine },
    { h: 'Harness', w: 12, f: (s: ProjectSourceSummary) => s.harness },
    { h: 'Sessions', w: 8, f: (s: ProjectSourceSummary) => fmtNum(s.sessions), r: true },
    { h: 'Tokens', w: 10, f: (s: ProjectSourceSummary) => fmtNum(s.tokens), r: true },
    { h: 'Path', w: 48, f: (s: ProjectSourceSummary) => s.sourcePath || '—' },
  ];
  const items = [...summaries.values()].sort(
    (a, b) =>
      a.project.localeCompare(b.project) || a.machine.localeCompare(b.machine) || a.harness.localeCompare(b.harness),
  );
  const header = cols.map((col) => pad(col.h, col.w, col.r)).join('  ');
  const body = items.map((item) => cols.map((col) => pad(trunc(col.f(item), col.w), col.w, col.r)).join('  '));
  return [header, ...body].join('\n');
};

// Multi-megabyte outputs (e.g. --payload-json) get truncated when stdout is a
// pipe and the runtime exits before the async stream drains, so completion is
// gated on the write callback for the actual payload chunk before the explicit
// process.exit below. (Bun.write(Bun.stdout, …) busy-spins on a backed-up pipe
// once process.stdout has been touched, so the node stream is used throughout.)
const writeStdout = (text: string) =>
  Effect.async<void>((resume) => {
    process.stdout.write(text, () => resume(Effect.void));
  });

const fileError = (operation: string, filePath: string) => (cause: unknown) =>
  new CliArgumentError({
    message: `${operation} ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const readFile = (filePath: string) =>
  Effect.try({
    try: () => fs.readFileSync(filePath, 'utf8'),
    catch: fileError('readFile', filePath),
  });

const readSnapshotFile = (filePath: string) =>
  readFile(filePath).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => parseUsageSnapshot(text),
        catch: fileError('parseSnapshot', filePath),
      }),
    ),
  );

const fetchRemoteSnapshot = (url: string, token: string | null) =>
  Effect.gen(function* () {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { headers }),
      catch: (cause) =>
        new CliArgumentError({ message: `fetch ${url}: ${cause instanceof Error ? cause.message : String(cause)}` }),
    });
    if (!response.ok) {
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => response.statusText,
      });
      return yield* Effect.fail(new CliArgumentError({ message: `fetch ${url}: HTTP ${response.status} ${body}` }));
    }
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new CliArgumentError({ message: `read ${url}: ${cause instanceof Error ? cause.message : String(cause)}` }),
    });
    return yield* Effect.try({
      try: () => parseUsageSnapshot(text),
      catch: (cause) =>
        new CliArgumentError({ message: `parse ${url}: ${cause instanceof Error ? cause.message : String(cause)}` }),
    });
  });

const writeFile = (filePath: string, text: string) =>
  Effect.try({
    try: () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, text, 'utf8');
    },
    catch: fileError('writeFile', filePath),
  });

const formatDefect = (defect: unknown) => (defect instanceof Error ? defect.message : String(defect));

const runnable = app.pipe(
  Effect.as(0 as number),
  Effect.catchAll((error: unknown) =>
    Console.error(`Error: ${error instanceof Error ? error.message : formatAppError(error as any)}`).pipe(Effect.as(1)),
  ),
  Effect.catchAllDefect((defect: unknown) => Console.error(`Error: ${formatDefect(defect)}`).pipe(Effect.as(1))),
  Effect.provide(Layer.mergeAll(LocalHistoryStorageLive, CliRuntimeLive)),
);

Effect.runPromise(runnable).then((code) => {
  if (code !== 0) process.exit(code);
});
