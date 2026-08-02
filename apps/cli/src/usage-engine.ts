import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseUsageEngineCommandRequest,
  parseUsageEngineForegroundOutcome,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommand,
  type UsageEngineCommandCompletion,
  type UsageEngineErrorCode,
  type UsageEngineStatus,
  usageEngineControlBounds,
} from '@ai-usage/usage-engine-control';
import {
  createUsageEngineControlClient,
  type UsageEngineControlClient,
  UsageEngineControlError,
} from '@ai-usage/usage-engine-control/client';
import {
  executeUsageEngineCommandToCompletion,
  USAGE_ENGINE_COMMAND_COMPLETION_TIMEOUT_MS,
  UsageEngineCommandCompletionError,
} from '@ai-usage/usage-engine-control/completion';
import {
  assertUsageEngineRendezvousTarget,
  loadUsageEngineRendezvous,
  UsageEngineRendezvousError,
  usageEngineTargetIdFor,
} from '@ai-usage/usage-engine-control/node';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';
import type { CliUsagePaths } from './usage-paths';

const RENDEZVOUS_FILE_NAME = 'rendezvous.json';
const DEFAULT_FOREGROUND_TERMINATION_GRACE_MS = 1000;

interface ForegroundChild {
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number | NodeJS.Signals) => void;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
}

export interface CliUsageEngineExecution {
  readonly completion: UsageEngineCommandCompletion;
  readonly mode: 'daemon' | 'foreground';
}

export interface CliUsageEngine {
  readonly execute: (
    command: UsageEngineCommand,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<CliUsageEngineExecution>;
}

export type CliUsageDaemonResolution =
  | { readonly kind: 'absent' }
  | { readonly control: UsageEngineControlClient; readonly kind: 'available' };

export interface CliUsageEngineDependencies {
  readonly executeDaemon: (
    control: UsageEngineControlClient,
    command: UsageEngineCommand,
    signal?: AbortSignal,
  ) => Promise<CliUsageEngineExecution>;
  readonly launchForeground: (command: UsageEngineCommand, signal?: AbortSignal) => Promise<CliUsageEngineExecution>;
  readonly resolveDaemon: () => Promise<CliUsageDaemonResolution>;
}

export class CliUsageEngineError extends Error {
  readonly code: UsageEngineErrorCode;
  override readonly name = 'CliUsageEngineError';

  constructor(code: UsageEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

const stableEngineError = (error: unknown): CliUsageEngineError => {
  if (error instanceof CliUsageEngineError) {
    return error;
  }
  if (error instanceof UsageEngineControlError || error instanceof UsageEngineCommandCompletionError) {
    return new CliUsageEngineError(error.code, error.message, { cause: error });
  }
  return new CliUsageEngineError('engine-unavailable', 'Usage engine is unavailable.', { cause: error });
};

const assertCompatibleReadyStatus = (status: UsageEngineStatus): void => {
  if (status.storeSchemaVersion !== null && status.storeSchemaVersion !== USAGE_STORE_SCHEMA_VERSION) {
    throw new CliUsageEngineError('protocol-mismatch', 'Usage engine store schema is incompatible.');
  }
  if (status.readiness !== 'ready') {
    throw new CliUsageEngineError('engine-unavailable', 'Usage engine is not ready.');
  }
};

export const createCliUsageEngine = (dependencies: CliUsageEngineDependencies): CliUsageEngine => ({
  execute: async (command, options = {}) => {
    const daemon = await dependencies.resolveDaemon().catch((error: unknown) => {
      throw stableEngineError(error);
    });
    if (daemon.kind === 'absent') {
      return await dependencies.launchForeground(command, options.signal).catch((error: unknown) => {
        throw stableEngineError(error);
      });
    }
    try {
      const initialStatus = await daemon.control.getStatus({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      assertCompatibleReadyStatus(initialStatus);
    } catch (error) {
      if (
        error instanceof UsageEngineControlError &&
        (error.code === 'engine-unavailable' || error.code === 'transport-failed')
      ) {
        return await dependencies.launchForeground(command, options.signal).catch((foregroundError: unknown) => {
          throw stableEngineError(foregroundError);
        });
      }
      throw stableEngineError(error);
    }
    return await dependencies.executeDaemon(daemon.control, command, options.signal).catch((error: unknown) => {
      throw stableEngineError(error);
    });
  },
});

const errorHasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const resolveLiveDaemon = async (paths: CliUsagePaths): Promise<CliUsageDaemonResolution> => {
  const rendezvousPath = path.join(paths.stateDirectory, RENDEZVOUS_FILE_NAME);
  const stats = await lstat(rendezvousPath).catch((error: unknown) => {
    if (errorHasCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  });
  if (!stats) {
    return { kind: 'absent' };
  }
  try {
    const rendezvous = await loadUsageEngineRendezvous(rendezvousPath);
    assertUsageEngineRendezvousTarget(rendezvous, usageEngineTargetIdFor(paths));
    return {
      control: createUsageEngineControlClient({ resolveRendezvous: () => Promise.resolve(rendezvous) }),
      kind: 'available',
    };
  } catch (error) {
    if (error instanceof UsageEngineRendezvousError && error.reason === 'protocol-mismatch') {
      throw new CliUsageEngineError('protocol-mismatch', 'Usage engine protocol version mismatch.', { cause: error });
    }
    if (error instanceof UsageEngineRendezvousError && error.reason === 'target-mismatch') {
      throw new CliUsageEngineError('protocol-mismatch', 'Usage engine target mismatch.', { cause: error });
    }
    throw new CliUsageEngineError('invalid-response', 'Usage engine rendezvous is invalid.', { cause: error });
  }
};

const readBoundedStream = async (stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new CliUsageEngineError('response-too-large', 'Usage engine foreground response is too large.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const writeProcessStderr = async (bytes: Uint8Array): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    process.stderr.write(bytes, (error) => (error ? reject(error) : resolve()));
  });

const drainDiagnostics = async (
  stream: ReadableStream<Uint8Array>,
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<void> => {
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      await write(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
};

const waitForForegroundExit = async (child: ForegroundChild, graceMs: number): Promise<boolean> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const terminateForegroundChild = async (
  child: ForegroundChild,
  gracefulSignal: 'SIGINT' | 'SIGTERM',
  graceMs: number,
): Promise<void> => {
  if (child.exitCode !== null) {
    return;
  }
  child.kill(gracefulSignal);
  const exitedGracefully = await waitForForegroundExit(child, graceMs);
  if (!(exitedGracefully || child.exitCode !== null)) {
    child.kill('SIGKILL');
  }
  await child.exited.catch(() => undefined);
};

export interface CreateLiveCliUsageEngineOptions {
  readonly engineEntrypoint?: string;
  readonly foregroundDeadlineMs?: number;
  readonly foregroundTerminationGraceMs?: number;
  readonly paths: CliUsagePaths;
  readonly writeDiagnostics?: (bytes: Uint8Array) => Promise<void>;
}

export const createLiveCliUsageEngine = (options: CreateLiveCliUsageEngineOptions): CliUsageEngine => {
  const engineEntrypoint =
    options.engineEntrypoint ?? fileURLToPath(import.meta.resolve('@ai-usage/usage-engine/main'));
  const writeDiagnostics = options.writeDiagnostics ?? writeProcessStderr;
  const foregroundDeadlineMs = options.foregroundDeadlineMs ?? USAGE_ENGINE_COMMAND_COMPLETION_TIMEOUT_MS;
  const foregroundTerminationGraceMs = options.foregroundTerminationGraceMs ?? DEFAULT_FOREGROUND_TERMINATION_GRACE_MS;
  if (
    !(
      Number.isSafeInteger(foregroundDeadlineMs) &&
      foregroundDeadlineMs > 0 &&
      foregroundDeadlineMs <= USAGE_ENGINE_COMMAND_COMPLETION_TIMEOUT_MS
    )
  ) {
    throw new Error('Usage engine foreground deadline must be a positive bounded integer.');
  }
  if (!(Number.isSafeInteger(foregroundTerminationGraceMs) && foregroundTerminationGraceMs >= 0)) {
    throw new Error('Usage engine foreground termination grace must be a non-negative integer.');
  }
  const launchForeground = async (
    command: UsageEngineCommand,
    signal?: AbortSignal,
  ): Promise<CliUsageEngineExecution> => {
    if (signal?.aborted) {
      throw new CliUsageEngineError('aborted', 'Usage engine command was cancelled.');
    }
    const request = parseUsageEngineCommandRequest({
      command,
      commandId: randomUUID(),
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });
    const child = Bun.spawn([process.execPath, '--no-env-file', engineEntrypoint, 'once', JSON.stringify(request)], {
      cwd: options.paths.operatorCwd,
      env: {
        ...process.env,
        AI_USAGE_DATABASE_PATH: options.paths.databasePath,
        AI_USAGE_ENGINE_STATE_DIR: options.paths.stateDirectory,
        AI_USAGE_HOME: options.paths.homeDirectory,
        AI_USAGE_ROOT_DIR: options.paths.configCwd,
        AI_USAGE_TEMP_ROOT: options.paths.temporaryRoot,
        HOME: options.paths.homeDirectory,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    let resolveAbort: (() => void) | undefined;
    const abort = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const markAborted = (): void => resolveAbort?.();
    signal?.addEventListener('abort', markAborted, { once: true });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, foregroundDeadlineMs);
    });
    const processSettlement = Promise.all([
      readBoundedStream(child.stdout, usageEngineControlBounds.maxForegroundOutcomeBytes),
      child.exited,
      drainDiagnostics(child.stderr, writeDiagnostics),
    ]);
    processSettlement.catch(() => undefined);
    try {
      const settlement = await Promise.race([
        processSettlement.then(([stdout, exitCode]) => ({ exitCode, kind: 'settled' as const, stdout })),
        abort.then(() => ({ kind: 'aborted' as const })),
        timedOut.then(() => ({ kind: 'timed-out' as const })),
      ]);
      if (settlement.kind === 'timed-out') {
        throw new CliUsageEngineError('timeout', 'Usage engine foreground command timed out.');
      }
      if (settlement.kind === 'aborted' || signal?.aborted) {
        throw new CliUsageEngineError('aborted', 'Usage engine command was cancelled.');
      }
      const { exitCode, stdout } = settlement;
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)) as unknown;
      } catch (error) {
        if (exitCode !== 0) {
          throw new CliUsageEngineError('engine-unavailable', 'Usage engine foreground process failed.', {
            cause: error,
          });
        }
        throw new CliUsageEngineError('invalid-response', 'Usage engine foreground response is invalid.', {
          cause: error,
        });
      }
      const outcome = parseUsageEngineForegroundOutcome(value);
      if (outcome.kind === 'admission-rejected') {
        throw new CliUsageEngineError(outcome.result.error.code, outcome.result.error.message);
      }
      assertCompatibleReadyStatus(outcome.status);
      if (outcome.completion.commandId !== request.commandId || outcome.completion.command !== command.command) {
        throw new CliUsageEngineError('invalid-response', 'Usage engine foreground completion identity is invalid.');
      }
      if (outcome.completion.state === 'failed') {
        throw new CliUsageEngineError(outcome.completion.error.code, outcome.completion.error.message);
      }
      if (exitCode !== 0) {
        throw new CliUsageEngineError('engine-unavailable', 'Usage engine foreground process failed.');
      }
      return { completion: outcome.completion, mode: 'foreground' };
    } catch (error) {
      if (signal?.aborted) {
        throw new CliUsageEngineError('aborted', 'Usage engine command was cancelled.', { cause: error });
      }
      throw error;
    } finally {
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }
      signal?.removeEventListener('abort', markAborted);
      if (child.exitCode === null) {
        await terminateForegroundChild(child, signal?.aborted ? 'SIGINT' : 'SIGTERM', foregroundTerminationGraceMs);
      }
      if (!signal?.aborted) {
        await processSettlement.catch(() => undefined);
      }
    }
  };

  return createCliUsageEngine({
    executeDaemon: async (control, command, signal) => {
      const completion = await executeUsageEngineCommandToCompletion(control, command, {
        expectedStoreSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
        ...(signal === undefined ? {} : { signal }),
      });
      return { completion, mode: 'daemon' };
    },
    launchForeground,
    resolveDaemon: async () => await resolveLiveDaemon(options.paths),
  });
};
