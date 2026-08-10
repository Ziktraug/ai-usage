import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type BoundaryClassification, classifyExit, runBoundaryEffect } from '@ai-usage/effect-runtime';
import type { ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import type { ProjectGroupConfig } from '@ai-usage/report-core/project-group';
import type { ProviderStatus } from '@ai-usage/report-core/provider-status';
import type { UsageReportWarning } from '@ai-usage/report-core/report-data';
import { serializeUsageSnapshot, type UsageSnapshot } from '@ai-usage/report-core/snapshot';
import { providerUsageSourceIds, sanitizeSourceWarningCodes } from '@ai-usage/report-core/source-control';
import {
  assembleMergedUsageReport,
  collectProjectSourcesFromSnapshots,
  type ProjectSource,
} from '@ai-usage/report-data/portable-report';
import type {
  UsageEngineCollectionOutput,
  UsageEngineCommand,
  UsageEnginePublicationOutput,
} from '@ai-usage/usage-engine-control';
import { UsageStoreError } from '@ai-usage/usage-store/reader';
import { Console, Effect, Exit } from 'effect';
import { type Args, helpText, parseCommand } from './cli';
import { type AppError, CliArgumentError, formatAppError } from './errors';
import { renderQuota } from './quota';
import { setColor } from './render/colors';
import { fmtNum, pad, trunc } from './render/format';
import { renderUsagePayloadForCli, renderUsageReportForCli, renderWarnings, renderWarningsForStderr } from './report';
import { CliRuntime, type CliRuntime as CliRuntimeService } from './runtime';
import { runSetupServer } from './setup';
import { readUsageSnapshotFile } from './snapshot-file';
import { CliUsageEngineError, type CliUsageEngineExecution } from './usage-engine';
import {
  type CliSourceExecutionOutcome,
  readLatestProviderQuotas,
  readServedLocalUsageSnapshot,
  readServedPortableConfig,
  readServedUsageReport,
  readServedUsageSupport,
  readUsageMachine,
  reportSourceIdsFor,
  sourceExecutionOutcomes,
  sourceExecutionWarnings,
} from './usage-read-model';

interface CliQuotaBoundaryResult {
  readonly latest: readonly ProviderStatus[];
  /** One per provider-usage source. The command refreshes every provider, not a nominated one. */
  readonly sources: readonly CliSourceExecutionOutcome[];
}

const CLI_QUOTA_ERROR_POLICY = {
  allowedTags: new Set(['CliArgumentError']),
  interruptedTags: new Set<string>(),
};

const classifyCliQuotaOutcome = (exit: Exit.Exit<CliQuotaBoundaryResult, unknown>): BoundaryClassification => {
  if (Exit.isFailure(exit)) {
    return {
      ...classifyExit(exit, CLI_QUOTA_ERROR_POLICY),
      annotations: { failureKind: 'quota-command-failed' },
    };
  }
  const { latest, sources } = exit.value;
  const hasUsableLatest = latest.length > 0;
  const warningCodes = sanitizeSourceWarningCodes(sources.flatMap(({ warnings }) => warnings));
  // One provider failing while another refreshed is a degraded run, not a failed one — the report
  // still gained a fresh reading. Only a run where nothing succeeded and nothing is stored fails.
  const failed = sources.find(({ status }) => status === 'failed');
  const allSucceeded = sources.length > 0 && sources.every(({ status }) => status === 'success');
  let outcome: BoundaryClassification['outcome'] = 'failure';
  if (allSucceeded) {
    outcome = 'success';
  } else if (hasUsableLatest) {
    outcome = 'degraded';
  }
  const unavailable = sources.find(({ result }) => result?.unavailable !== undefined)?.result?.unavailable;
  return {
    outcome,
    annotations: {
      domainOutcome: allSucceeded ? 'success' : (failed?.status ?? sources[0]?.status ?? 'unavailable'),
      outputCount: latest.length,
      ...(failed === undefined ? {} : { failureKind: 'quota-refresh-failed' }),
      ...(unavailable === undefined ? {} : { unavailableCode: unavailable.code }),
      ...(warningCodes.length === 0 ? {} : { warningCodes }),
    },
  };
};

const fromPromise = <Value>(run: () => Promise<Value>): Effect.Effect<Value, unknown> =>
  Effect.tryPromise({ catch: (error: unknown) => error, try: run });

const executeEngine = (runtime: CliRuntimeService, command: UsageEngineCommand) =>
  fromPromise(() => runtime.usageEngine.execute(command, { signal: runtime.signal }));

const requiredCollectionOutput = (
  execution: CliUsageEngineExecution,
  sourceIds: readonly string[],
): UsageEngineCollectionOutput => {
  const completion = execution.completion;
  if (!(completion.state === 'succeeded' && completion.output.kind === 'collection')) {
    throw new CliUsageEngineError('invalid-response', 'Usage engine collection result is invalid.');
  }
  const actualSourceIds = completion.output.sources.map(({ id }) => id);
  if (
    actualSourceIds.length !== sourceIds.length ||
    actualSourceIds.some((sourceId, index) => sourceId !== sourceIds[index])
  ) {
    throw new CliUsageEngineError('invalid-response', 'Usage engine collection result has invalid source scope.');
  }
  return completion.output;
};

const requiredPublicationOutput = (execution: CliUsageEngineExecution): UsageEnginePublicationOutput => {
  const completion = execution.completion;
  if (
    !(completion.state === 'succeeded' && completion.command === 'publish' && completion.output.kind === 'publication')
  ) {
    throw new CliUsageEngineError('invalid-response', 'Usage engine publication result is invalid.');
  }
  return completion.output;
};

const readOrInitializeUsageMachine = async (runtime: CliRuntimeService) => {
  try {
    return await readUsageMachine(runtime.paths.databasePath);
  } catch (error) {
    const canInitialize =
      error instanceof UsageStoreError &&
      (error.reason === 'machine-unavailable' || error.reason === 'schema-too-old' || error.reason === 'store-missing');
    if (!canInitialize) {
      throw error;
    }
  }
  const execution = await runtime.usageEngine.execute({ command: 'publish' }, { signal: runtime.signal });
  requiredPublicationOutput(execution);
  return await readUsageMachine(runtime.paths.databasePath);
};

const readOptionalCurrentPortableConfig = async (dbPath: string) => {
  try {
    return await readServedPortableConfig(dbPath);
  } catch (error) {
    const isUnavailable =
      error instanceof UsageStoreError &&
      (error.reason === 'revision-expired' ||
        error.reason === 'revision-unavailable' ||
        error.reason === 'store-missing');
    if (isUnavailable) {
      return;
    }
    throw error;
  }
};

const reportWarningsFor = (
  output: UsageEngineCollectionOutput,
  selection: { readonly harness: Args['harness']; readonly includeCursor: boolean },
): UsageReportWarning[] =>
  sourceExecutionWarnings(sourceExecutionOutcomes(output.sources, reportSourceIdsFor(selection)));

const readSnapshots = (files: readonly string[]) =>
  Effect.gen(function* () {
    const snapshots: UsageSnapshot[] = [];
    for (const file of files) {
      snapshots.push(yield* readUsageSnapshotFile(file));
    }
    return snapshots;
  });

const runFreshReport = (runtime: CliRuntimeService, args: Args) =>
  Effect.gen(function* () {
    const selection = { harness: args.harness, includeCursor: args.cursor };
    const execution = yield* executeEngine(runtime, { command: 'collect-fresh-report', ...selection });
    const collection = requiredCollectionOutput(execution, reportSourceIdsFor(selection));
    const revision = collection.publication.revision;
    const warnings = reportWarningsFor(collection, selection);
    return yield* fromPromise(() =>
      readServedUsageReport({ args, dbPath: runtime.paths.databasePath, revision, warnings }),
    );
  });

const renderReport = (args: Args, report: Awaited<ReturnType<typeof readServedUsageReport>>): string =>
  args.format === 'payload'
    ? renderUsagePayloadForCli(report.payload)
    : renderUsageReportForCli(report.rows, args, undefined, report.warnings);

export const app = Effect.gen(function* () {
  const runtime = yield* CliRuntime;
  const command = yield* parseCommand(runtime.argv);

  if (command._tag === 'Help') {
    yield* Console.log(helpText);
    return;
  }

  if (command._tag === 'Quota') {
    yield* runBoundaryEffect(
      { boundary: 'cli.quota', classify: classifyCliQuotaOutcome },
      Effect.gen(function* () {
        yield* Effect.sync(() => setColor(command.color === null ? runtime.stdoutIsTTY : command.color));
        const execution = yield* executeEngine(runtime, { command: 'collect-fresh-quota' });
        const quotaSourceIds = [...providerUsageSourceIds];
        const collection = requiredCollectionOutput(execution, quotaSourceIds);
        const sources = sourceExecutionOutcomes(collection.sources, quotaSourceIds);
        if (sources.length === 0) {
          return yield* Effect.fail(new CliArgumentError({ message: 'No provider usage-limit source is available.' }));
        }
        // Paused is only fatal when every provider is paused; one live source still has news.
        const paused = sources.filter(({ status }) => status === 'paused');
        if (paused.length === sources.length) {
          return yield* Effect.fail(
            new CliArgumentError({
              message: `Provider usage-limit collection is paused; re-enable ${paused.map(({ sourceId }) => sourceId).join(' or ')} first.`,
            }),
          );
        }
        const latest = yield* fromPromise(() => readLatestProviderQuotas(runtime.paths.databasePath));
        yield* Console.log(renderQuota(latest));
        return { latest, sources };
      }),
    );
    return;
  }

  if (command._tag === 'Machine') {
    const machine = yield* fromPromise(() => readOrInitializeUsageMachine(runtime));
    yield* Console.log(`Machine: ${machine.label}\nID: ${machine.id}`);
    return;
  }

  if (command._tag === 'MachineSetLabel') {
    const execution = yield* executeEngine(runtime, { command: 'set-machine-label', label: command.label });
    const completion = execution.completion;
    if (!(completion.state === 'succeeded' && completion.command === 'set-machine-label')) {
      return yield* Effect.fail(new CliUsageEngineError('invalid-response', 'Machine label result is invalid.'));
    }
    const { machine } = completion.output;
    yield* Console.log(`Machine: ${machine.label}\nID: ${machine.id}`);
    return;
  }

  if (command._tag === 'Snapshot') {
    const selection = { harness: command.args.harness, includeCursor: command.args.cursor };
    const execution = yield* executeEngine(runtime, { command: 'collect-fresh-report', ...selection });
    const collection = requiredCollectionOutput(execution, reportSourceIdsFor(selection));
    const revision = collection.publication.revision;
    const warnings = reportWarningsFor(collection, selection);
    const local = yield* fromPromise(() =>
      readServedLocalUsageSnapshot({
        dbPath: runtime.paths.databasePath,
        revision,
        selection,
        warnings,
      }),
    );
    yield* writePortableFile(command.args.out, serializeUsageSnapshot(local.snapshot));
    yield* writeWarningsStderr(local.snapshot.warnings);
    yield* Console.log(`Wrote ${command.args.out}`);
    return;
  }

  if (command._tag === 'Merge') {
    yield* Effect.sync(() => setColor(command.args.color === null ? runtime.stdoutIsTTY : command.args.color));
    const snapshots = yield* readSnapshots(command.args.files);
    let localSnapshot: UsageSnapshot | undefined;
    let projectAliases: ProjectAliasEntry[] | undefined;
    let projectGroupConfigs: ProjectGroupConfig[] | undefined;
    if (command.args.local) {
      const selection = { harness: command.args.harness, includeCursor: command.args.cursor };
      const execution = yield* executeEngine(runtime, { command: 'collect-fresh-report', ...selection });
      const collection = requiredCollectionOutput(execution, reportSourceIdsFor(selection));
      const revision = collection.publication.revision;
      const local = yield* fromPromise(() =>
        readServedLocalUsageSnapshot({
          dbPath: runtime.paths.databasePath,
          revision,
          selection,
          warnings: reportWarningsFor(collection, selection),
        }),
      );
      localSnapshot = local.snapshot;
      const config = yield* fromPromise(() => readServedPortableConfig(runtime.paths.databasePath, revision));
      projectAliases = [...config.projectAliases];
      projectGroupConfigs = [...config.projectGroupConfigs];
    } else {
      const config = yield* fromPromise(() => readOptionalCurrentPortableConfig(runtime.paths.databasePath));
      projectAliases = config === undefined ? undefined : [...config.projectAliases];
      projectGroupConfigs = config === undefined ? undefined : [...config.projectGroupConfigs];
    }
    const merged = assembleMergedUsageReport({
      harness: command.args.harness,
      includeCursor: command.args.cursor,
      ...(localSnapshot === undefined ? {} : { localSnapshots: [localSnapshot] }),
      options: command.args,
      ...(projectAliases === undefined ? {} : { projectAliases }),
      ...(projectGroupConfigs === undefined ? {} : { projectGroupConfigs }),
      snapshots,
    });
    const output =
      command.args.format === 'payload'
        ? renderUsagePayloadForCli(merged.payload)
        : renderUsageReportForCli(merged.rows, command.args, undefined, merged.payload.warnings);
    yield* writeFormatWarningsStderr(command.args, merged.payload.warnings);
    yield* writeStdout(`${output}\n`);
    return;
  }

  if (command._tag === 'ProjectsList') {
    const snapshots = yield* readSnapshots(command.args.files);
    let localSnapshot: UsageSnapshot | undefined;
    if (command.args.local) {
      const selection = { harness: null, includeCursor: true } as const;
      const execution = yield* executeEngine(runtime, { command: 'collect-fresh-report', ...selection });
      const collection = requiredCollectionOutput(execution, reportSourceIdsFor(selection));
      const revision = collection.publication.revision;
      const local = yield* fromPromise(() =>
        readServedLocalUsageSnapshot({
          dbPath: runtime.paths.databasePath,
          revision,
          selection,
          warnings: reportWarningsFor(collection, selection),
        }),
      );
      localSnapshot = local.snapshot;
    }
    const { sources, warnings } = collectProjectSourcesFromSnapshots({
      harness: null,
      includeCursor: true,
      ...(localSnapshot === undefined ? {} : { localSnapshots: [localSnapshot] }),
      snapshots,
    });
    yield* writeWarningsStderr(warnings);
    yield* writeStdout(`${renderProjectSources(sources)}\n`);
    return;
  }

  if (command._tag === 'CursorImport') {
    const execution = yield* executeEngine(runtime, {
      command: 'import-cursor',
      input: { filePath: path.resolve(runtime.paths.operatorCwd, command.args.file), kind: 'operator-file' },
    });
    const completion = execution.completion;
    if (!(completion.state === 'succeeded' && completion.command === 'import-cursor')) {
      return yield* Effect.fail(new CliUsageEngineError('invalid-response', 'Cursor import result is invalid.'));
    }
    const importedPath = path.join(
      runtime.paths.configCwd,
      '.ai-usage',
      'cursor-exports',
      completion.output.artifactName,
    );
    yield* Console.log(
      completion.output.alreadyImported
        ? `Already imported: ${importedPath}`
        : `Imported Cursor usage export: ${importedPath}`,
    );
    return;
  }

  if (command._tag === 'Setup') {
    const engineCommand: UsageEngineCommand = command.args.local
      ? { command: 'collect-fresh-report', harness: null, includeCursor: true }
      : { command: 'publish' };
    const execution = yield* executeEngine(runtime, engineCommand);
    const collection = command.args.local
      ? requiredCollectionOutput(execution, reportSourceIdsFor({ harness: null, includeCursor: true }))
      : undefined;
    const revision = collection?.publication.revision ?? requiredPublicationOutput(execution).publication.revision;
    const support = yield* fromPromise(() => readServedUsageSupport(runtime.paths.databasePath, revision));
    const local = command.args.local
      ? yield* fromPromise(() =>
          readServedLocalUsageSnapshot({
            dbPath: runtime.paths.databasePath,
            revision,
            selection: { harness: null, includeCursor: true },
            warnings:
              collection === undefined ? [] : reportWarningsFor(collection, { harness: null, includeCursor: true }),
          }),
        )
      : undefined;
    yield* runSetupServer({
      ...(local === undefined ? {} : { localSnapshot: local.snapshot }),
      port: command.args.port,
      projectGroups: support.projectGroupConfigs ?? [],
      signal: runtime.signal,
      snapshotFiles: command.args.files,
      writeProjectGroups: async (projectGroups) => {
        await runtime.usageEngine.execute(
          { command: 'replace-project-groups', projectGroups },
          { signal: runtime.signal },
        );
      },
    });
    return;
  }

  yield* Effect.sync(() => setColor(command.args.color === null ? runtime.stdoutIsTTY : command.args.color));
  const report = command.args.stored
    ? yield* fromPromise(() => readServedUsageReport({ args: command.args, dbPath: runtime.paths.databasePath }))
    : yield* runFreshReport(runtime, command.args);
  yield* writeFormatWarningsStderr(command.args, report.warnings);
  yield* writeStdout(`${renderReport(command.args, report)}\n`);
});

const renderProjectSources = (items: ProjectSource[]): string => {
  const cols = [
    { f: (source: ProjectSource) => source.project, h: 'Project', w: 20 },
    { f: (source: ProjectSource) => source.machine, h: 'Machine', w: 18 },
    { f: (source: ProjectSource) => source.harness, h: 'Harness', w: 12 },
    { f: (source: ProjectSource) => fmtNum(source.sessions), h: 'Sessions', r: true, w: 8 },
    { f: (source: ProjectSource) => fmtNum(source.tokens), h: 'Tokens', r: true, w: 10 },
    { f: (source: ProjectSource) => source.sourcePath || '—', h: 'Path', w: 48 },
  ];
  const header = cols.map((column) => pad(column.h, column.w, column.r)).join('  ');
  const body = items.map((item) =>
    cols.map((column) => pad(trunc(column.f(item), column.w), column.w, column.r)).join('  '),
  );
  return [header, ...body].join('\n');
};

const writeStdout = (text: string): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    process.stdout.write(text, () => resume(Effect.void));
  });

const writeStderr = (text: string): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    process.stderr.write(text, () => resume(Effect.void));
  });

const writeWarningsStderr = (warnings: UsageReportWarning[] | undefined): Effect.Effect<void> => {
  const output = renderWarnings(warnings);
  return output ? writeStderr(`${output}\n`) : Effect.void;
};

const writeFormatWarningsStderr = (args: Args, warnings: UsageReportWarning[] | undefined): Effect.Effect<void> => {
  const output = renderWarningsForStderr(args, warnings);
  return output ? writeStderr(`${output}\n`) : Effect.void;
};

const fileError = (operation: string, filePath: string) => (cause: unknown) =>
  new CliArgumentError({
    message: `${operation} ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const writePortableFile = (filePath: string, text: string) =>
  Effect.try({
    catch: fileError('writeFile', filePath),
    try: () => {
      const directory = path.dirname(filePath);
      fs.mkdirSync(directory, { recursive: true });
      const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporaryPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(temporaryPath, filePath);
        if (process.platform !== 'win32') {
          fs.chmodSync(filePath, 0o600);
        }
      } finally {
        fs.rmSync(temporaryPath, { force: true });
      }
    },
  });

const formatDefect = (defect: unknown): string => (defect instanceof Error ? defect.message : String(defect));

const isAppError = (error: unknown): error is AppError =>
  error instanceof CliArgumentError || error instanceof CliUsageEngineError;

export const runnableApp = app.pipe(
  Effect.as(0 as number),
  Effect.catchAll((error: unknown) =>
    Console.error(`Error: ${isAppError(error) ? formatAppError(error) : formatDefect(error)}`).pipe(Effect.as(1)),
  ),
  Effect.catchAllDefect((defect: unknown) => Console.error(`Error: ${formatDefect(defect)}`).pipe(Effect.as(1))),
);
