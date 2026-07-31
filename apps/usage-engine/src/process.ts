import {
  parseUsageEngineForegroundOutcome,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineForegroundOutcome,
} from '@ai-usage/usage-engine-control';
import {
  type UsageEngineBearerToken,
  type UsageEngineTargetId,
  usageEngineTargetIdFor,
} from '@ai-usage/usage-engine-control/node';
import type { UsageEngineRuntimeHost } from '@ai-usage/usage-engine-runtime';
import type { UsageEngineControlServer } from './control-server';
import type { UsageEngineProcessMode } from './process-arguments';
import type { PublishedUsageEngineRendezvous } from './rendezvous-file';

export type UsageEngineTerminationSignal = 'SIGINT' | 'SIGTERM';

export interface UsageEngineProcessPaths {
  readonly configCwd: string;
  readonly databasePath: string;
  readonly homeDirectory: string;
  readonly inboxDirectory: string;
  readonly logDirectory: string;
  readonly operatorCwd: string;
  readonly stateDirectory: string;
  readonly temporaryRoot: string;
}

export interface UsageEngineCheckReport {
  readonly lock: {
    readonly instanceId?: string;
    readonly pid?: number;
    readonly state: 'absent' | 'live' | 'stale' | 'unsafe';
  };
  readonly ok: boolean;
  readonly rendezvous: {
    readonly instanceId?: string;
    readonly port?: number;
    readonly protocolVersion?: number;
    readonly state: 'absent' | 'mismatched' | 'unsafe' | 'valid';
  };
  readonly store: {
    readonly machineFleetGeneration?: number;
    readonly reason?: string;
    readonly state: 'compatible' | 'unavailable';
    readonly usageStoreGeneration?: number;
  };
}

export interface UsageEngineProcessDependencies {
  readonly check: (paths: UsageEngineProcessPaths) => Promise<UsageEngineCheckReport>;
  readonly createInstanceId: () => string;
  readonly createRuntime: (input: {
    readonly collectionMode: 'foreground' | 'scheduled';
    readonly instanceId: string;
    readonly paths: UsageEngineProcessPaths;
  }) => UsageEngineRuntimeHost;
  readonly createToken: () => UsageEngineBearerToken;
  readonly publishRendezvous: (input: {
    readonly instanceId: string;
    readonly port: number;
    readonly stateDirectory: string;
    readonly targetId: UsageEngineTargetId;
    readonly token: UsageEngineBearerToken;
  }) => Promise<PublishedUsageEngineRendezvous>;
  readonly startControlServer: (input: {
    readonly hostname: '127.0.0.1';
    readonly port: number;
    readonly runtime: UsageEngineRuntimeHost;
    readonly token: UsageEngineBearerToken;
  }) => Promise<UsageEngineControlServer>;
  readonly writeOutput: (line: string) => void;
}

export interface RunUsageEngineProcessOptions {
  readonly forcedTermination?: Promise<UsageEngineTerminationSignal>;
  readonly mode: UsageEngineProcessMode;
  readonly paths: UsageEngineProcessPaths;
  readonly termination: Promise<UsageEngineTerminationSignal>;
}

export interface UsageEngineProcess {
  readonly run: (options: RunUsageEngineProcessOptions) => Promise<number>;
}

class ProcessTerminated extends Error {
  readonly signal: UsageEngineTerminationSignal;

  constructor(signal: UsageEngineTerminationSignal) {
    super(`Usage engine process received ${signal}.`);
    this.signal = signal;
  }
}

const waitUnlessTerminated = async <Value>(
  operation: Promise<Value>,
  termination: Promise<UsageEngineTerminationSignal>,
): Promise<Value> => {
  const outcome = await Promise.race([
    operation.then((value) => ({ kind: 'operation' as const, value })),
    termination.then((signal) => ({ kind: 'termination' as const, signal })),
  ]);
  if (outcome.kind === 'termination') {
    throw new ProcessTerminated(outcome.signal);
  }
  return outcome.value;
};

const cleanupError = (failures: unknown[]): AggregateError | undefined =>
  failures.length === 0
    ? undefined
    : new AggregateError(failures, 'The usage engine process could not clean up every owned resource.');

const throwProcessFailure = (failure: unknown, cleanupFailure?: AggregateError): never => {
  if (cleanupFailure) {
    throw new AggregateError([failure, cleanupFailure], 'The usage engine process failed and cleanup was incomplete.');
  }
  throw failure;
};

export const interruptedExitCode = (signal: UsageEngineTerminationSignal): number => (signal === 'SIGINT' ? 130 : 143);

const writeForegroundOutcome = (
  dependencies: UsageEngineProcessDependencies,
  outcomeValue: UsageEngineForegroundOutcome,
): void => {
  const outcome = parseUsageEngineForegroundOutcome(outcomeValue);
  dependencies.writeOutput(JSON.stringify(outcome));
};

const scheduleLateCleanup = <Resource>(
  resource: Promise<Resource>,
  cleanup: (value: Resource) => Promise<void>,
): void => {
  resource.then(cleanup).catch(() => undefined);
};

type ProcessCleanupOutcome =
  | { readonly kind: 'completed' }
  | { readonly error: unknown; readonly kind: 'failed' }
  | { readonly kind: 'forced' };

const settleProcessCleanup = async (
  cleanup: () => Promise<void>,
  forcedTermination?: Promise<UsageEngineTerminationSignal>,
): Promise<ProcessCleanupOutcome> => {
  let operation: Promise<void>;
  try {
    operation = cleanup();
  } catch (error) {
    return { error, kind: 'failed' };
  }
  const settlement = operation.then<ProcessCleanupOutcome, ProcessCleanupOutcome>(
    () => ({ kind: 'completed' }),
    (error: unknown) => ({ error, kind: 'failed' }),
  );
  if (!forcedTermination) {
    return await settlement;
  }
  return await Promise.race([settlement, forcedTermination.then((): ProcessCleanupOutcome => ({ kind: 'forced' }))]);
};

type TrackedOperationState = 'fulfilled' | 'pending' | 'rejected';

interface TrackedOperation<Value> {
  readonly promise: Promise<Value>;
  readonly state: () => TrackedOperationState;
}

const trackOperation = <Value>(operation: Promise<Value>): TrackedOperation<Value> => {
  let state: TrackedOperationState = 'pending';
  const promise = operation.then(
    (value) => {
      state = 'fulfilled';
      return value;
    },
    (error: unknown) => {
      state = 'rejected';
      throw error;
    },
  );
  return { promise, state: () => state };
};

const disposeRuntimeForProcess = async (
  runtime: UsageEngineRuntimeHost,
  retainWriterLease: boolean,
  forcedTermination?: Promise<UsageEngineTerminationSignal>,
): Promise<void> => {
  const disposal = retainWriterLease ? runtime.disposeRetainingWriterLease() : runtime.dispose();
  if (!forcedTermination) {
    await disposal;
    return;
  }
  const outcome = await Promise.race([
    disposal.then(
      () => ({ kind: 'disposed' as const }),
      (error: unknown) => ({ error, kind: 'failed' as const }),
    ),
    forcedTermination.then(() => ({ kind: 'forced' as const })),
  ]);
  if (outcome.kind === 'failed') {
    throw outcome.error;
  }
  if (outcome.kind === 'forced') {
    runtime.disposeRetainingWriterLease().catch(() => undefined);
  }
};

export const createUsageEngineProcess = (dependencies: UsageEngineProcessDependencies): UsageEngineProcess => {
  const runServe = async (
    options: RunUsageEngineProcessOptions & { readonly mode: { readonly mode: 'serve'; readonly port: number } },
  ) => {
    const instanceId = dependencies.createInstanceId();
    const token = dependencies.createToken();
    const runtime = dependencies.createRuntime({
      collectionMode: 'scheduled',
      instanceId,
      paths: options.paths,
    });
    let server: UsageEngineControlServer | undefined;
    let rendezvous: PublishedUsageEngineRendezvous | undefined;
    let serverStart: TrackedOperation<UsageEngineControlServer> | undefined;
    let rendezvousPublication: TrackedOperation<PublishedUsageEngineRendezvous> | undefined;
    let failure: unknown;
    try {
      await waitUnlessTerminated(runtime.start(), options.termination);
      serverStart = trackOperation(
        dependencies.startControlServer({
          hostname: '127.0.0.1',
          port: options.mode.port,
          runtime,
          token,
        }),
      );
      server = await waitUnlessTerminated(serverStart.promise, options.termination);
      rendezvousPublication = trackOperation(
        dependencies.publishRendezvous({
          instanceId,
          port: server.port,
          stateDirectory: options.paths.stateDirectory,
          targetId: usageEngineTargetIdFor(options.paths),
          token,
        }),
      );
      rendezvous = await waitUnlessTerminated(rendezvousPublication.promise, options.termination);
      await options.termination;
    } catch (error) {
      failure = error;
    }

    const cleanupFailures: unknown[] = [];
    let retainWriterLease = false;
    if (!rendezvous && rendezvousPublication) {
      if (rendezvousPublication.state() === 'fulfilled') {
        rendezvous = await rendezvousPublication.promise;
      } else if (rendezvousPublication.state() === 'pending') {
        retainWriterLease = true;
        scheduleLateCleanup(rendezvousPublication.promise, async (published) => await published.remove());
      }
    }
    if (rendezvous) {
      const removal = await settleProcessCleanup(() => rendezvous.remove(), options.forcedTermination);
      if (removal.kind === 'failed') {
        cleanupFailures.push(removal.error);
        retainWriterLease = true;
      } else if (removal.kind === 'forced') {
        retainWriterLease = true;
      }
    }
    if (!server && serverStart) {
      if (serverStart.state() === 'fulfilled') {
        server = await serverStart.promise;
      } else if (serverStart.state() === 'pending') {
        retainWriterLease = true;
        scheduleLateCleanup(serverStart.promise, async (started) => await started.dispose());
      }
    }
    if (server) {
      const disposal = await settleProcessCleanup(() => server.dispose(), options.forcedTermination);
      if (disposal.kind === 'failed') {
        cleanupFailures.push(disposal.error);
        retainWriterLease = true;
      } else if (disposal.kind === 'forced') {
        retainWriterLease = true;
      }
    }
    try {
      await disposeRuntimeForProcess(runtime, retainWriterLease, options.forcedTermination);
    } catch (error) {
      cleanupFailures.push(error);
    }
    const cleanupFailure = cleanupError(cleanupFailures);
    if (failure && !(failure instanceof ProcessTerminated)) {
      throwProcessFailure(failure, cleanupFailure);
    }
    if (cleanupFailure) {
      throw cleanupFailure;
    }
    return 0;
  };

  const runOnce = async (
    options: RunUsageEngineProcessOptions & {
      readonly mode: Extract<UsageEngineProcessMode, { readonly mode: 'once' }>;
    },
  ) => {
    const instanceId = dependencies.createInstanceId();
    const runtime = dependencies.createRuntime({
      collectionMode: 'foreground',
      instanceId,
      paths: options.paths,
    });
    let failure: unknown;
    let exitCode = 1;
    try {
      await waitUnlessTerminated(runtime.start(), options.termination);
      const result = await runtime.executeCommand(options.mode.request.command, options.mode.request.commandId);
      if (result.ok) {
        const completion = await waitUnlessTerminated(
          runtime.waitForCommand(options.mode.request.commandId),
          options.termination,
        );
        const status = await waitUnlessTerminated(runtime.status(), options.termination);
        writeForegroundOutcome(dependencies, {
          completion,
          instanceId: result.instanceId,
          kind: 'command-completed',
          protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
          status,
        });
        exitCode = completion.state === 'succeeded' ? 0 : 1;
      } else {
        writeForegroundOutcome(dependencies, { kind: 'admission-rejected', result });
      }
    } catch (error) {
      failure = error;
    }
    let cleanupFailure: unknown;
    try {
      await disposeRuntimeForProcess(runtime, false, options.forcedTermination);
    } catch (error) {
      cleanupFailure = error;
    }
    if (failure instanceof ProcessTerminated) {
      if (cleanupFailure) {
        throw cleanupFailure;
      }
      return interruptedExitCode(failure.signal);
    }
    if (failure) {
      throwProcessFailure(failure, cleanupFailure === undefined ? undefined : cleanupError([cleanupFailure]));
    }
    if (cleanupFailure) {
      throw cleanupFailure;
    }
    return exitCode;
  };

  return {
    run: async (options) => {
      if (options.mode.mode === 'check') {
        const report = await dependencies.check(options.paths);
        dependencies.writeOutput(JSON.stringify(report));
        return report.ok ? 0 : 1;
      }
      if (options.mode.mode === 'once') {
        return await runOnce({ ...options, mode: options.mode });
      }
      return await runServe({ ...options, mode: options.mode });
    },
  };
};
