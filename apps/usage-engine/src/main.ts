import { randomBytes, randomUUID } from 'node:crypto';
import { makeAiUsageWideEventResource } from '@ai-usage/effect-runtime';
import { makeEngineWideEventSinkLayer } from '@ai-usage/effect-runtime/node';
import { createUsageEngineBearerToken } from '@ai-usage/usage-engine-control/node';
import { createLiveUsageEngineRuntime } from '@ai-usage/usage-engine-runtime/live';
import { startUsageEngineControlServer } from './control-server';
import { acquireUsageEngineLock } from './engine-lock';
import { createUsageEngineProcess, interruptedExitCode, type UsageEngineProcessDependencies } from './process';
import { parseUsageEngineProcessArguments } from './process-arguments';
import { checkUsageEngine } from './process-check';
import { resolveUsageEngineProcessPaths } from './process-paths';
import { createUsageEngineTermination } from './process-signals';
import { publishUsageEngineRendezvous } from './rendezvous-file';

export const defineUsageEngineComposition = <Factory>(factory: Factory): Factory => factory;

const createProductionDependencies = (env: NodeJS.ProcessEnv): UsageEngineProcessDependencies => ({
  check: checkUsageEngine,
  createInstanceId: randomUUID,
  createRuntime: ({ collectionMode, instanceId, paths }) =>
    createLiveUsageEngineRuntime({
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
        directory: paths.logDirectory,
        resource: {
          ...makeAiUsageWideEventResource({
            instanceId,
            nodeEnvironment: env.NODE_ENV,
            surface: 'engine',
          }),
          surface: 'engine',
        },
      }),
    }),
  createToken: () => createUsageEngineBearerToken(randomBytes(32).toString('base64url')),
  publishRendezvous: publishUsageEngineRendezvous,
  startControlServer: startUsageEngineControlServer,
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
  const termination = createUsageEngineTermination(process, (signal) => {
    process.exit(interruptedExitCode(signal));
  });
  try {
    return await createUsageEngineProcess(createProductionDependencies(env)).run({
      forcedTermination: termination.forced,
      mode,
      paths,
      termination: termination.promise,
    });
  } finally {
    termination.dispose();
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await runUsageEngineMain();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Usage engine failed.'}\n`);
    process.exitCode = 1;
  }
}
