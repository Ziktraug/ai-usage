#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { UsageReportWarning } from '@ai-usage/report-core/report-data';
import { LocalHistoryStorageLive } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig, writeMachineConfig } from '@ai-usage/local-collectors/machine-config';
import {
  collectLocalReportRowsWithWarnings,
  createLocalReportPayload,
  createLocalUsageSnapshot,
  createMergedUsageReport,
  listProjectSourcesWithWarnings,
  type ProjectSource,
} from '@ai-usage/report-data';
import { fetchRemoteSnapshot, readSnapshotFile } from '@ai-usage/sync/transport';
import { Console, Effect, Layer } from 'effect';
import { type Args, helpText, parseCommand } from './cli';
import { CliArgumentError, formatAppError } from './errors';
import { renderQuota } from './quota';
import { setColor } from './render/colors';
import { fmtNum, pad, trunc } from './render/format';
import { renderUsagePayloadForCli, renderUsageReportForCli, renderWarnings, renderWarningsForStderr } from './report';
import { CliRuntime, CliRuntimeLive } from './runtime';
import { runServe } from './serve';
import { runSetupServer } from './setup';
import { runSyncCommand } from './sync';

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
    const snapshot = yield* createLocalUsageSnapshot({
      harness: command.args.harness,
      includeCursor: command.args.cursor,
      includeFacets: true,
    });
    yield* writeFile(command.args.out, `${JSON.stringify(snapshot, null, 2)}\n`);
    yield* writeWarningsStderr(snapshot.warnings);
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
    const merged = yield* createMergedUsageReport({
      snapshots,
      includeLocal: command.args.local,
      harness: command.args.harness,
      includeCursor: command.args.cursor,
      options: command.args,
    });
    const output = yield* Effect.promise(() =>
      command.args.format === 'html' || command.args.format === 'payload'
        ? renderUsagePayloadForCli(merged.payload, command.args)
        : renderUsageReportForCli(merged.rows, command.args, undefined, merged.payload.warnings),
    );
    yield* writeFormatWarningsStderr(command.args, merged.payload.warnings);
    yield* writeStdout(`${output}\n`);
    return;
  }

  if (command._tag === 'Sync') {
    yield* runSyncCommand(command.args);
    return;
  }

  if (command._tag === 'ProjectsList') {
    const snapshots = [];
    for (const file of command.args.files) {
      snapshots.push(yield* readSnapshotFile(file));
    }
    const { sources, warnings } = yield* listProjectSourcesWithWarnings({
      snapshots,
      includeLocal: command.args.local,
      harness: null,
      includeCursor: true,
    });
    yield* writeWarningsStderr(warnings);
    yield* writeStdout(`${renderProjectSources(sources)}\n`);
    return;
  }

  if (command._tag === 'CursorImport') {
    const imported = yield* importCursorUsageExport(command.args.file);
    yield* Console.log(
      imported.alreadyImported
        ? `Already imported: ${imported.path}`
        : `Imported Cursor usage export: ${imported.path}`,
    );
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
  const reportRequest = {
    harness: command.args.harness,
    includeCursor: command.args.cursor,
    keepSource: true,
  };
  const output =
    command.args.format === 'html' || command.args.format === 'payload'
      ? yield* Effect.gen(function* () {
          const payload = command.args.synced !== false
            ? (yield* createMergedUsageReport({
                snapshots: [],
                includeLocal: true,
                includeSynced: true,
                harness: command.args.harness,
                includeCursor: command.args.cursor,
                options: command.args,
                includeFacets: true,
              })).payload
            : yield* createLocalReportPayload({
                ...reportRequest,
                options: command.args,
                includeFacets: true,
              });
          return yield* Effect.promise(() => renderUsagePayloadForCli(payload, command.args));
        })
      : yield* Effect.gen(function* () {
          const { rows, warnings } = command.args.synced !== false
            ? yield* Effect.gen(function* () {
                const merged = yield* createMergedUsageReport({
                  snapshots: [],
                  includeLocal: true,
                  includeSynced: true,
                  harness: command.args.harness,
                  includeCursor: command.args.cursor,
                  options: command.args,
                });
                return { rows: merged.rows, warnings: merged.payload.warnings ?? [] };
              })
            : yield* collectLocalReportRowsWithWarnings(reportRequest);
          yield* writeFormatWarningsStderr(command.args, warnings);
          return yield* Effect.promise(() => renderUsageReportForCli(rows, command.args, undefined, warnings));
        });
  yield* writeStdout(`${output}\n`);
});

const renderProjectSources = (items: ProjectSource[]) => {
  const cols = [
    { h: 'Project', w: 20, f: (s: ProjectSource) => s.project },
    { h: 'Machine', w: 18, f: (s: ProjectSource) => s.machine },
    { h: 'Harness', w: 12, f: (s: ProjectSource) => s.harness },
    { h: 'Sessions', w: 8, f: (s: ProjectSource) => fmtNum(s.sessions), r: true },
    { h: 'Tokens', w: 10, f: (s: ProjectSource) => fmtNum(s.tokens), r: true },
    { h: 'Path', w: 48, f: (s: ProjectSource) => s.sourcePath || '—' },
  ];
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

const writeStderr = (text: string) =>
  Effect.async<void>((resume) => {
    process.stderr.write(text, () => resume(Effect.void));
  });

const writeWarningsStderr = (warnings: UsageReportWarning[] | undefined) => {
  const output = renderWarnings(warnings);
  return output ? writeStderr(`${output}\n`) : Effect.void;
};

const writeFormatWarningsStderr = (args: Args, warnings: UsageReportWarning[] | undefined) => {
  const output = renderWarningsForStderr(args, warnings);
  return output ? writeStderr(`${output}\n`) : Effect.void;
};

const fileError = (operation: string, filePath: string) => (cause: unknown) =>
  new CliArgumentError({
    message: `${operation} ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const writeFile = (filePath: string, text: string) =>
  Effect.try({
    try: () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, text, 'utf8');
    },
    catch: fileError('writeFile', filePath),
  });

const CURSOR_EXPORT_DIR = path.join(process.cwd(), '.ai-usage', 'cursor-exports');

const safeImportName = (filePath: string) => path.basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, '-');

const cursorCsvLooksValid = (text: string) => {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  return ['Date', 'User', 'Kind', 'Model', 'Cost'].every((column) => header.includes(column));
};

const importCursorUsageExport = (filePath: string) =>
  Effect.try({
    try: () => {
      const sourcePath = path.resolve(filePath);
      const content = fs.readFileSync(sourcePath);
      if (!cursorCsvLooksValid(content.toString('utf8', 0, Math.min(content.length, 4096)))) {
        throw new Error('not a Cursor usage-events CSV export');
      }
      fs.mkdirSync(CURSOR_EXPORT_DIR, { recursive: true });
      const hash = createHash('sha256').update(content).digest('hex');
      for (const entry of fs.readdirSync(CURSOR_EXPORT_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.csv')) continue;
        const existingPath = path.join(CURSOR_EXPORT_DIR, entry.name);
        const existingHash = createHash('sha256').update(fs.readFileSync(existingPath)).digest('hex');
        if (existingHash === hash) return { path: existingPath, alreadyImported: true };
      }
      const destination = path.join(CURSOR_EXPORT_DIR, `${hash.slice(0, 12)}-${safeImportName(sourcePath)}`);
      fs.writeFileSync(destination, content);
      return { path: destination, alreadyImported: false };
    },
    catch: fileError('cursorImport', filePath),
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
