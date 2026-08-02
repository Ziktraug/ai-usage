import { randomUUID } from 'node:crypto';
import { sourceControlBounds } from '@ai-usage/report-core/source-control';
import {
  parseUsageEngineCommand,
  parseUsageEngineCommandCancellationResult,
  parseUsageEngineCommandId,
  parseUsageEngineCommandResult,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommand,
  type UsageEngineCommandCancellationDisposition,
  type UsageEngineCommandCancellationResult,
  type UsageEngineCommandCompletion,
  type UsageEngineCommandId,
  type UsageEngineCommandResult,
  type UsageEngineErrorCode,
  type UsageEngineInstanceId,
  usageEngineReportSourceIdsFor,
} from '@ai-usage/usage-engine-control';
import { failedCommandCompletion, successfulCommandCompletion } from './runtime-command-completion';
import type { UsageEngineCommandOutput } from './runtime-command-executor';
import {
  UsageEngineCommandError,
  type UsageEngineCommandErrorCode,
  UsageEngineFatalConsistencyError,
} from './runtime-errors';

interface QueuedCommand {
  readonly command: UsageEngineCommand;
  readonly commandId: UsageEngineCommandId;
}

interface ActiveCommand {
  readonly controller: AbortController;
  readonly job: QueuedCommand;
}

interface CommandIdentity {
  completion: UsageEngineCommandCompletion | undefined;
  readonly fileInputFingerprint: string | undefined;
  readonly fingerprint: string;
  readonly waiters: Set<(completion: UsageEngineCommandCompletion) => void>;
}

type FileInputCommand = Extract<
  UsageEngineCommand,
  { readonly command: 'confirm-merge' | 'import-cursor' | 'preview-merge' }
>;

interface CommandDrain {
  readonly abortOnShutdown: boolean;
  readonly active: () => ActiveCommand | undefined;
  readonly drain: () => Promise<void> | undefined;
  readonly queue: QueuedCommand[];
  readonly setActive: (active: ActiveCommand | undefined) => void;
  readonly setDrain: (drain: Promise<void> | undefined) => void;
}

export interface RuntimeCommandCoordinatorDependencies {
  readonly canAcceptCommands: () => boolean;
  readonly discardFileInput: (command: FileInputCommand) => Promise<void>;
  readonly instanceId: UsageEngineInstanceId;
  readonly lifecycleSignal: AbortSignal;
  readonly now: () => Date;
  readonly onCompletion: (completion: UsageEngineCommandCompletion) => void;
  readonly onFatalConsistency: () => void;
  readonly runCommand: (command: UsageEngineCommand, signal: AbortSignal) => Promise<UsageEngineCommandOutput>;
}

export interface RuntimeCommandCoordinator {
  readonly beginShutdown: () => void;
  readonly cancelCommand: (commandId: string) => Promise<UsageEngineCommandCancellationResult>;
  readonly execute: (command: UsageEngineCommand) => Promise<UsageEngineCommandResult>;
  readonly executeCommand: (command: UsageEngineCommand, commandId: string) => Promise<UsageEngineCommandResult>;
  readonly settle: () => Promise<void>;
  readonly waitForCommand: (commandId: string) => Promise<UsageEngineCommandCompletion>;
  readonly waitForIdle: () => Promise<void>;
}

const MAX_COMMAND_IDENTITIES = 256;
const commandFailureMessage = 'The usage engine command could not be completed.';

const commandFingerprint = (command: UsageEngineCommand): string => JSON.stringify(command);

const commandIsSafelyInterruptible = (command: UsageEngineCommand): boolean => {
  switch (command.command) {
    case 'collect-fresh-report':
    case 'collect-fresh-quota':
    case 'detect-all':
    case 'preview-merge':
    case 'run-all-enabled':
    case 'run-source':
      return true;
    case 'confirm-merge':
    case 'import-cursor':
    case 'publish':
    case 'replace-project-aliases':
    case 'replace-project-groups':
    case 'replace-project-groups-by-reference':
    case 'set-machine-label':
    case 'set-campaign-label-override':
    case 'set-source-enabled':
      return false;
    default: {
      const unsupportedCommand: never = command;
      throw new Error(`Unsupported usage engine command: ${JSON.stringify(unsupportedCommand)}`);
    }
  }
};

const commandHasFileInput = (command: UsageEngineCommand): command is FileInputCommand =>
  command.command === 'confirm-merge' || command.command === 'import-cursor' || command.command === 'preview-merge';

const commandFileInputFingerprint = (command: UsageEngineCommand): string | undefined =>
  commandHasFileInput(command) ? JSON.stringify(command.input) : undefined;

const failedResult = (
  instanceId: UsageEngineInstanceId,
  commandId: UsageEngineCommandId,
  code: UsageEngineErrorCode,
  message: string,
): UsageEngineCommandResult =>
  parseUsageEngineCommandResult({
    commandId,
    error: { code, message },
    instanceId,
    ok: false,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
  });

const acceptedResult = (
  instanceId: UsageEngineInstanceId,
  commandId: UsageEngineCommandId,
  admission: 'accepted' | 'coalesced',
): UsageEngineCommandResult =>
  parseUsageEngineCommandResult({
    admission,
    commandId,
    instanceId,
    ok: true,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
  });

export const createRuntimeCommandCoordinator = (
  dependencies: RuntimeCommandCoordinatorDependencies,
): RuntimeCommandCoordinator => {
  let activeCommand: ActiveCommand | undefined;
  let activePolicyCommand: ActiveCommand | undefined;
  let drainPromise: Promise<void> | undefined;
  let policyDrainPromise: Promise<void> | undefined;
  let shutdownBegun = false;
  const commandQueue: QueuedCommand[] = [];
  const policyCommandQueue: QueuedCommand[] = [];
  const commandIdentities = new Map<string, CommandIdentity>();
  const preCancelledCommandIds = new Set<UsageEngineCommandId>();
  const idleWaiters = new Set<() => void>();
  const pendingFileInputCleanups = new Set<Promise<void>>();

  const scheduleFileInputCleanup = (command: UsageEngineCommand): void => {
    if (!commandHasFileInput(command)) {
      return;
    }
    const cleanup = dependencies.discardFileInput(command).catch(() => {
      // The live mutation port reports cleanup failures at their bounded boundary.
    });
    pendingFileInputCleanups.add(cleanup);
    cleanup.finally(() => pendingFileInputCleanups.delete(cleanup));
  };

  const resolveIdle = (): void => {
    if (commandQueue.length !== 0 || policyCommandQueue.length !== 0 || drainPromise || policyDrainPromise) {
      return;
    }
    for (const resolve of idleWaiters) {
      resolve();
    }
    idleWaiters.clear();
  };

  const publishCompletion = (completion: UsageEngineCommandCompletion): void => {
    const identity = commandIdentities.get(completion.commandId);
    if (identity) {
      identity.completion = completion;
      for (const resolve of identity.waiters) {
        resolve(completion);
      }
      identity.waiters.clear();
    }
    dependencies.onCompletion(completion);
  };

  const failedCompletionFor = (
    job: QueuedCommand,
    code: 'aborted' | 'command-failed' | 'command-rejected' | 'engine-busy' | UsageEngineCommandErrorCode,
    message = commandFailureMessage,
  ): UsageEngineCommandCompletion => failedCommandCompletion(job, code, dependencies.now().toISOString(), message);

  const cancellationResult = (
    commandId: UsageEngineCommandId,
    disposition: UsageEngineCommandCancellationDisposition,
  ): UsageEngineCommandCancellationResult =>
    parseUsageEngineCommandCancellationResult({
      commandId,
      disposition,
      instanceId: dependencies.instanceId,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });

  const removeQueuedCommand = (queue: QueuedCommand[], commandId: UsageEngineCommandId): QueuedCommand | undefined => {
    const index = queue.findIndex((job) => job.commandId === commandId);
    return index < 0 ? undefined : queue.splice(index, 1)[0];
  };

  const rememberPreCancelledCommand = (commandId: UsageEngineCommandId): void => {
    if (preCancelledCommandIds.has(commandId)) {
      return;
    }
    if (preCancelledCommandIds.size >= MAX_COMMAND_IDENTITIES) {
      const oldest = preCancelledCommandIds.values().next().value;
      if (oldest !== undefined) {
        preCancelledCommandIds.delete(oldest);
      }
    }
    preCancelledCommandIds.add(commandId);
  };

  const cancelCommand = (commandIdValue: string): Promise<UsageEngineCommandCancellationResult> => {
    const commandId = parseUsageEngineCommandId(commandIdValue);
    const identity = commandIdentities.get(commandId);
    if (identity?.completion) {
      return Promise.resolve(cancellationResult(commandId, 'already-completed'));
    }
    const queued = removeQueuedCommand(commandQueue, commandId) ?? removeQueuedCommand(policyCommandQueue, commandId);
    if (queued) {
      scheduleFileInputCleanup(queued.command);
      publishCompletion(failedCompletionFor(queued, 'aborted', 'The usage engine command was cancelled.'));
      resolveIdle();
      return Promise.resolve(cancellationResult(commandId, 'cancelled'));
    }
    let active: ActiveCommand | undefined;
    if (activeCommand?.job.commandId === commandId) {
      active = activeCommand;
    } else if (activePolicyCommand?.job.commandId === commandId) {
      active = activePolicyCommand;
    }
    if (active) {
      if (!commandIsSafelyInterruptible(active.job.command)) {
        return Promise.resolve(cancellationResult(commandId, 'finishing'));
      }
      active.controller.abort();
      return Promise.resolve(cancellationResult(commandId, 'cancelling'));
    }
    if (identity) {
      return Promise.resolve(cancellationResult(commandId, 'finishing'));
    }
    rememberPreCancelledCommand(commandId);
    return Promise.resolve(cancellationResult(commandId, 'cancelled'));
  };

  const rejectQueuedCommandsAfterFatalConsistency = (): void => {
    for (const queuedJob of [...commandQueue.splice(0), ...policyCommandQueue.splice(0)]) {
      scheduleFileInputCleanup(queuedJob.command);
      publishCompletion(
        failedCompletionFor(
          queuedJob,
          'engine-busy',
          'The usage engine requires restart recovery before another command can run.',
        ),
      );
    }
  };

  const drainCommandQueue = (commandDrain: CommandDrain): void => {
    if (commandDrain.drain()) {
      return;
    }
    const drain = (async () => {
      while (commandDrain.queue.length > 0) {
        const job = commandDrain.queue.shift();
        if (!job) {
          continue;
        }
        const controller = new AbortController();
        const currentCommand = { controller, job };
        commandDrain.setActive(currentCommand);
        if (commandDrain.abortOnShutdown && shutdownBegun && commandIsSafelyInterruptible(job.command)) {
          controller.abort();
        }
        try {
          const result = await dependencies.runCommand(job.command, controller.signal);
          if (controller.signal.aborted) {
            throw new Error('Usage engine command was aborted.');
          }
          publishCompletion(successfulCommandCompletion(job, result, dependencies.now().toISOString()));
        } catch (error) {
          const typedCommandError = error instanceof UsageEngineCommandError ? error : undefined;
          publishCompletion(
            failedCompletionFor(
              job,
              controller.signal.aborted || dependencies.lifecycleSignal.aborted
                ? 'aborted'
                : (typedCommandError?.code ?? 'command-failed'),
              typedCommandError?.message ?? commandFailureMessage,
            ),
          );
          if (error instanceof UsageEngineFatalConsistencyError) {
            dependencies.onFatalConsistency();
            rejectQueuedCommandsAfterFatalConsistency();
            break;
          }
        } finally {
          if (commandDrain.active() === currentCommand) {
            commandDrain.setActive(undefined);
          }
        }
      }
    })().finally(() => {
      commandDrain.setDrain(undefined);
      resolveIdle();
      if (commandDrain.queue.length > 0) {
        drainCommandQueue(commandDrain);
      }
    });
    commandDrain.setDrain(drain);
  };

  const ordinaryCommandDrain: CommandDrain = {
    abortOnShutdown: true,
    active: () => activeCommand,
    drain: () => drainPromise,
    queue: commandQueue,
    setActive: (active) => {
      activeCommand = active;
    },
    setDrain: (drain) => {
      drainPromise = drain;
    },
  };
  const policyCommandDrain: CommandDrain = {
    abortOnShutdown: false,
    active: () => activePolicyCommand,
    drain: () => policyDrainPromise,
    queue: policyCommandQueue,
    setActive: (active) => {
      activePolicyCommand = active;
    },
    setDrain: (drain) => {
      policyDrainPromise = drain;
    },
  };

  const sourcePolicyMustPreemptActiveCollection = (
    command: Extract<UsageEngineCommand, { readonly command: 'set-source-enabled' }>,
  ): boolean => {
    if (command.enabled || !activeCommand) {
      return false;
    }
    const active = activeCommand.job.command;
    switch (active.command) {
      case 'collect-fresh-report':
        return usageEngineReportSourceIdsFor(active).includes(command.sourceId);
      case 'run-source':
        return active.sourceId === command.sourceId;
      case 'run-all-enabled':
        return true;
      case 'collect-fresh-quota':
        return command.sourceId === 'codex.usage-limits';
      case 'import-cursor':
        return command.sourceId === 'cursor.sessions';
      default:
        return false;
    }
  };

  const executeCommand = (
    commandValue: UsageEngineCommand,
    commandIdValue: string,
  ): Promise<UsageEngineCommandResult> => {
    try {
      const commandId = parseUsageEngineCommandId(commandIdValue);
      const command = parseUsageEngineCommand(commandValue);
      if (preCancelledCommandIds.has(commandId)) {
        scheduleFileInputCleanup(command);
        return Promise.resolve(
          failedResult(dependencies.instanceId, commandId, 'aborted', 'The usage engine command was cancelled.'),
        );
      }
      const fingerprint = commandFingerprint(command);
      const existing = commandIdentities.get(commandId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          if (commandFileInputFingerprint(command) !== existing.fileInputFingerprint) {
            scheduleFileInputCleanup(command);
          }
          return Promise.resolve(
            failedResult(
              dependencies.instanceId,
              commandId,
              'command-rejected',
              'A command ID cannot be reused for another command.',
            ),
          );
        }
        return Promise.resolve(acceptedResult(dependencies.instanceId, commandId, 'coalesced'));
      }
      if (
        !dependencies.canAcceptCommands() ||
        commandQueue.length + policyCommandQueue.length >= sourceControlBounds.maxQueueDepth
      ) {
        scheduleFileInputCleanup(command);
        return Promise.resolve(
          failedResult(
            dependencies.instanceId,
            commandId,
            'engine-busy',
            'The usage engine is not accepting commands.',
          ),
        );
      }
      if (commandIdentities.size >= MAX_COMMAND_IDENTITIES) {
        for (const [oldestCommandId, identity] of commandIdentities) {
          if (identity.completion) {
            commandIdentities.delete(oldestCommandId);
            break;
          }
        }
      }
      if (commandIdentities.size >= MAX_COMMAND_IDENTITIES) {
        scheduleFileInputCleanup(command);
        return Promise.resolve(
          failedResult(
            dependencies.instanceId,
            commandId,
            'engine-busy',
            'The usage engine command identity cache is full.',
          ),
        );
      }
      commandIdentities.set(commandId, {
        completion: undefined,
        fileInputFingerprint: commandFileInputFingerprint(command),
        fingerprint,
        waiters: new Set(),
      });
      const queue =
        command.command === 'set-source-enabled' && sourcePolicyMustPreemptActiveCollection(command)
          ? policyCommandDrain
          : ordinaryCommandDrain;
      queue.queue.push({ command, commandId });
      drainCommandQueue(queue);
      return Promise.resolve(acceptedResult(dependencies.instanceId, commandId, 'accepted'));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const waitForCommand = async (commandIdValue: string): Promise<UsageEngineCommandCompletion> => {
    const commandId = parseUsageEngineCommandId(commandIdValue);
    const identity = commandIdentities.get(commandId);
    if (!identity) {
      throw new Error('The usage engine command identity is not available.');
    }
    if (identity.completion) {
      return identity.completion;
    }
    return await new Promise<UsageEngineCommandCompletion>((resolve) => identity.waiters.add(resolve));
  };

  const waitForIdle = async (): Promise<void> => {
    if (commandQueue.length === 0 && policyCommandQueue.length === 0 && !drainPromise && !policyDrainPromise) {
      return;
    }
    await new Promise<void>((resolve) => idleWaiters.add(resolve));
  };

  const beginShutdown = (): void => {
    if (shutdownBegun) {
      return;
    }
    shutdownBegun = true;
    for (const job of [...commandQueue.splice(0), ...policyCommandQueue.splice(0)]) {
      scheduleFileInputCleanup(job.command);
      publishCompletion(failedCompletionFor(job, 'aborted'));
    }
    if (activeCommand && commandIsSafelyInterruptible(activeCommand.job.command)) {
      activeCommand.controller.abort();
    }
    if (activePolicyCommand && commandIsSafelyInterruptible(activePolicyCommand.job.command)) {
      activePolicyCommand.controller.abort();
    }
  };

  const settle = async (): Promise<void> => {
    await Promise.all([drainPromise, policyDrainPromise]);
    await Promise.all([...pendingFileInputCleanups]);
    resolveIdle();
  };

  return {
    beginShutdown,
    cancelCommand,
    execute: (command) => executeCommand(command, randomUUID()),
    executeCommand,
    settle,
    waitForCommand,
    waitForIdle,
  };
};
