import { randomBytes, randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { makeAiUsageWideEventResource } from '@ai-usage/effect-runtime';
import { makeEngineWideEventSinkLayer, resolveWideEventLogDirectory } from '@ai-usage/effect-runtime/node';
import { createLocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { parseUsageEngineInstanceId, type UsageEngineInstanceId } from '@ai-usage/usage-engine-control';
import { createUsageEngineBearerToken } from '@ai-usage/usage-engine-control/node';
import { createLiveUsageEngineRuntime } from '@ai-usage/usage-engine-runtime/live';
import { startUsageEngineControlServer, type UsageEngineInternalFailureBoundary } from './control-server';
import { acquireUsageEngineLock, UsageEngineWriterLockContendedError } from './engine-lock';
import { localMemoryIdentityDatabasePath, withLocalMemoryIdentityKernel } from './memory-identity-runtime';
import { createRandomMemoryServiceToken, startLocalMemoryService } from './memory-service-server';
import {
  createUsageEngineProcess,
  interruptedExitCode,
  type UsageEngineCleanupResource,
  type UsageEngineProcessDependencies,
} from './process';
import { parseUsageEngineProcessArguments } from './process-arguments';
import { checkUsageEngine } from './process-check';
import { resolveUsageEngineProcessPaths } from './process-paths';
import { createUsageEngineTermination } from './process-signals';
import { publishUsageEngineRendezvous } from './rendezvous-file';
import {
  type DeviceReplicationDiagnostic,
  deviceReplicationStatusOutput,
  localOnlyReplicationStatus,
  startConfiguredDeviceReplication,
} from './replication-runtime';

export const defineUsageEngineComposition = <Factory>(factory: Factory): Factory => factory;

export const usageEngineFailureDiagnostic = 'Usage engine failed to start or complete its command.';
export const usageEngineForcedShutdownDiagnostic = 'Usage engine forced shutdown before cleanup was confirmed.';

const engineInstanceIdFrom = (env: NodeJS.ProcessEnv): UsageEngineInstanceId =>
  env.AI_USAGE_ENGINE_INSTANCE_ID === undefined
    ? parseUsageEngineInstanceId(randomUUID())
    : parseUsageEngineInstanceId(env.AI_USAGE_ENGINE_INSTANCE_ID);

const reportControlFailure = (boundary: UsageEngineInternalFailureBoundary): void => {
  process.stderr.write(`usage-engine controlFailure=${boundary}\n`);
};

const reportCleanupFailure = (resource: UsageEngineCleanupResource): void => {
  process.stderr.write(`usage-engine cleanupFailure=${resource}\n`);
};

const reportReplicationDiagnostic = (diagnostic: DeviceReplicationDiagnostic): void => {
  if (diagnostic.code === 'idle') {
    return;
  }
  const stream = diagnostic.streamId === undefined ? '' : ` stream=${diagnostic.streamId}`;
  const problem = diagnostic.problemCode === undefined ? '' : ` problem=${diagnostic.problemCode}`;
  process.stderr.write(`usage-engine replication=${diagnostic.code}${stream}${problem}\n`);
};

const createProductionDependencies = (
  env: NodeJS.ProcessEnv,
  logDirectory: string | null,
): UsageEngineProcessDependencies => ({
  check: checkUsageEngine,
  createInstanceId: () => engineInstanceIdFrom(env),
  createRuntime: ({ collectionMode, instanceId, paths }) => {
    let readReplicationStatus = localOnlyReplicationStatus;
    const usageRuntime = createLiveUsageEngineRuntime({
      acquireWriterLease: async () =>
        await acquireUsageEngineLock({
          databasePath: paths.databasePath,
          instanceId,
          stateDirectory: paths.stateDirectory,
        }),
      configCwd: paths.configCwd,
      dbPath: paths.databasePath,
      inboxDirectory: paths.inboxDirectory,
      initialSourceDetection: collectionMode === 'foreground' ? 'deferred' : 'automatic',
      instanceId,
      operatorCwd: paths.operatorCwd,
      readReplicationStatus: async () => readReplicationStatus(),
      storage: createLocalHistoryStorage(paths.homeDirectory),
      reportRecovery: ({
        deletedBytes,
        deletedEntries,
        deletedInboxBytes,
        deletedInboxFiles,
        deletedRoots,
        skippedSuspicious,
        skippedSuspiciousInboxEntries,
      }) => {
        process.stderr.write(
          `usage-engine recovery deletedRoots=${deletedRoots} deletedEntries=${deletedEntries} deletedBytes=${deletedBytes} deletedInboxFiles=${deletedInboxFiles} deletedInboxBytes=${deletedInboxBytes} skippedSuspicious=${skippedSuspicious} skippedSuspiciousInboxEntries=${skippedSuspiciousInboxEntries}\n`,
        );
      },
      temporaryRoot: paths.temporaryRoot,
      wideEventSinkLayer: makeEngineWideEventSinkLayer({
        consoleWrite: (line) => {
          process.stderr.write(`${line}\n`);
        },
        directory: logDirectory,
        resource: {
          ...makeAiUsageWideEventResource({
            instanceId,
            nodeEnvironment: env.NODE_ENV,
            surface: 'engine',
          }),
          surface: 'engine',
        },
      }),
    });
    return withLocalMemoryIdentityKernel(usageRuntime, localMemoryIdentityDatabasePath(paths.stateDirectory), {
      ...(env.AI_USAGE_PLATFORM_BASE_URL === undefined
        ? {}
        : {
            startReplication: (kernel) => {
              const replication = startConfiguredDeviceReplication({
                allowInsecureLoopback: env.NODE_ENV !== 'production',
                baseUrl: env.AI_USAGE_PLATFORM_BASE_URL ?? '',
                kernel,
                reportDiagnostic: reportReplicationDiagnostic,
                stateDirectory: paths.stateDirectory,
                usageDatabasePath: paths.databasePath,
              });
              readReplicationStatus = () => deviceReplicationStatusOutput(replication.status());
              return Promise.resolve(replication);
            },
          }),
      startService: async (kernel) =>
        await startLocalMemoryService({
          kernel,
          stateDirectory: paths.stateDirectory,
          token: createRandomMemoryServiceToken(),
        }),
    });
  },
  createToken: () => createUsageEngineBearerToken(randomBytes(32).toString('base64url')),
  publishRendezvous: publishUsageEngineRendezvous,
  reportCleanupFailure,
  startControlServer: async (input) =>
    await startUsageEngineControlServer({ ...input, reportInternalFailure: reportControlFailure }),
  writeOutput: (line) => {
    process.stdout.write(`${line}\n`);
  },
});

export const runUsageEngineMain = async (
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> => {
  const mode = parseUsageEngineProcessArguments(args);
  const paths = resolveUsageEngineProcessPaths({ env });
  const logDirectory = await resolveWideEventLogDirectory(env);
  const termination = createUsageEngineTermination(process, (signal) => {
    writeSync(process.stderr.fd, `${usageEngineForcedShutdownDiagnostic}\n`);
    process.exit(interruptedExitCode(signal));
  });
  try {
    return await createUsageEngineProcess(createProductionDependencies(env, logDirectory)).run({
      forcedTermination: termination.forced,
      mode,
      paths,
      termination: termination.promise,
    });
  } finally {
    termination.dispose();
  }
};

export type UsageEngineStartupFailureKind = 'startup-failure' | 'writer-lock-contended';

// Startup diagnostics are a closed public vocabulary. Never derive them from an error tag, class
// name, or message: those values are not stable and may carry private local details.
export const usageEngineStartupFailureKind = (error: unknown): UsageEngineStartupFailureKind =>
  error instanceof UsageEngineWriterLockContendedError ? 'writer-lock-contended' : 'startup-failure';

if (import.meta.main) {
  try {
    process.exitCode = await runUsageEngineMain();
  } catch (error) {
    process.stderr.write(`${usageEngineFailureDiagnostic}\n`);
    process.stderr.write(`usage-engine startupFailureKind=${usageEngineStartupFailureKind(error)}\n`);
    process.exitCode = 1;
  }
}
