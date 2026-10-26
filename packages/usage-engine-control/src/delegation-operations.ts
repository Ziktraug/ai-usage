import { lstat } from 'node:fs/promises';
import type {
  DelegationCancelAnswer,
  DelegationRequest,
  DelegationSelection,
  DelegationStartAnswer,
} from '@ai-usage/report-core/delegation-contracts';
import type { DelegationQualificationPurpose } from '@ai-usage/report-core/delegation-vocabulary';
import { createUsageEngineControlClient, UsageEngineControlError } from './client';
import { executeUsageEngineCommandToCompletion, UsageEngineCommandCompletionError } from './completion';
import {
  type UsageEngineCommand,
  type UsageEngineCommandCompletion,
  UsageEngineContractError,
  type UsageEngineDelegationEvaluationOutput,
  type UsageEngineDelegationQualificationEnvelope,
  type UsageEngineErrorCode,
} from './contracts';
import {
  assertUsageEngineRendezvousTarget,
  loadUsageEngineRendezvous,
  UsageEngineRendezvousError,
  usageEngineTargetIdFor,
} from './rendezvous';

/**
 * The engine side of the delegation operations (ADR 0077) as the MCP server and the CLI call them:
 * the four commands mapped to closed results, and the connection to a running engine. Nothing here
 * opens the store or starts an engine: a caller without a running daemon gets `engine-unavailable`
 * and decides what to tell its operator. Error texts never cross this seam; only codes do, because
 * the control client's messages may name a rendezvous path or a store.
 */

export type DelegationEngineCommand = Extract<
  UsageEngineCommand,
  { readonly command: 'cancel-delegation' | 'qualify-delegation' | 'record-delegation-evaluation' | 'start-delegation' }
>;

/** Runs one delegation command to its completion; `connectDelegationEngine` builds the live one. */
export type DelegationCommandExecutor = (
  command: DelegationEngineCommand,
  signal: AbortSignal | undefined,
) => Promise<UsageEngineCommandCompletion>;

export type DelegationOperationErrorCode =
  | 'cancelled'
  | 'engine-busy'
  | 'engine-unavailable'
  | 'invalid-input'
  | 'unavailable';

export type DelegationOperationResult<Value> =
  | { readonly code: DelegationOperationErrorCode; readonly kind: 'error' }
  | { readonly kind: 'success'; readonly value: Value };

/**
 * The qualification as the control plane transports it: the whole object the engine produced,
 * typed by its envelope only. An edge runs `parseDelegationQualification` (report-core) on it
 * before trusting any other field.
 */
export type DelegationQualificationEnvelope = UsageEngineDelegationQualificationEnvelope;

export type DelegationEvaluationAnswer = Omit<UsageEngineDelegationEvaluationOutput, 'kind'>;

export interface DelegationStartInput {
  readonly idempotencyKey: string;
  readonly request: DelegationRequest;
  readonly selection: DelegationSelection;
}

export interface DelegationEvaluateInput {
  /** The edge's author: the MCP edge passes `calling-model`, the Web edge `operator`. Never the payload's. */
  readonly author: 'calling-model' | 'operator';
  readonly authorLabel: string | null;
  /** The caller's payload (`kind`, `verdict`, `note`, `checks`); the engine parses it with the edge's author. */
  readonly evaluation: Readonly<Record<string, unknown>>;
  readonly jobId: string;
}

export interface DelegationCommands {
  readonly cancel: (jobId: string, signal?: AbortSignal) => Promise<DelegationOperationResult<DelegationCancelAnswer>>;
  readonly evaluate: (
    input: DelegationEvaluateInput,
    signal?: AbortSignal,
  ) => Promise<DelegationOperationResult<DelegationEvaluationAnswer>>;
  readonly qualify: (
    request: DelegationRequest,
    purpose: DelegationQualificationPurpose,
    signal?: AbortSignal,
  ) => Promise<DelegationOperationResult<DelegationQualificationEnvelope>>;
  readonly start: (
    input: DelegationStartInput,
    signal?: AbortSignal,
  ) => Promise<DelegationOperationResult<DelegationStartAnswer>>;
}

export interface CreateDelegationCommandsOptions {
  readonly execute: DelegationCommandExecutor;
}

export type DelegationEngineConnectionCode = 'engine-unavailable' | 'unavailable';

/** Why no executor could be built; the message is fixed per code and names no path. */
export class DelegationEngineConnectionError extends Error {
  readonly code: DelegationEngineConnectionCode;
  override readonly name = 'DelegationEngineConnectionError';

  constructor(code: DelegationEngineConnectionCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface ConnectDelegationEngineOptions {
  /** The config root the engine was started for; with the database path it identifies the engine. */
  readonly configCwd: string;
  readonly expectedStoreSchemaVersion: number;
  readonly runtimePaths: { readonly databasePath: string; readonly rendezvousPath: string };
  /** Cancels the connection probe; each command takes its own signal. */
  readonly signal?: AbortSignal;
  /** Per command, at most the completion timeout of the control plane. */
  readonly timeoutMs?: number;
}

const errorHasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

/** Control-plane codes folded onto the closed set an edge exposes. */
const operationCodeOf = (code: UsageEngineErrorCode): DelegationOperationErrorCode => {
  switch (code) {
    case 'aborted':
      return 'cancelled';
    case 'engine-busy':
      return 'engine-busy';
    case 'engine-unavailable':
    case 'transport-failed':
      return 'engine-unavailable';
    case 'command-rejected':
    case 'request-too-large':
      return 'invalid-input';
    default:
      return 'unavailable';
  }
};

const failureCodeOf = (error: unknown, signal: AbortSignal | undefined): DelegationOperationErrorCode => {
  if (signal?.aborted === true) {
    return 'cancelled';
  }
  if (error instanceof DelegationEngineConnectionError) {
    return error.code;
  }
  if (error instanceof UsageEngineCommandCompletionError || error instanceof UsageEngineControlError) {
    return operationCodeOf(error.code);
  }
  if (error instanceof UsageEngineContractError) {
    // The client parses the command before sending it: a contract failure here is this command's shape.
    return 'invalid-input';
  }
  return 'unavailable';
};

const UNAVAILABLE = Object.freeze({ code: 'unavailable', kind: 'error' } as const);

/**
 * The four delegation commands over one executor. Every answer is a closed result: the value the
 * engine produced (already validated by the control-plane completion parser), or one of five codes.
 * A completion for another command is `unavailable` (the engine spoke, but not to this command).
 */
export const createDelegationCommands = ({ execute }: CreateDelegationCommandsOptions): DelegationCommands => {
  const run = async (
    command: DelegationEngineCommand,
    signal: AbortSignal | undefined,
  ): Promise<DelegationOperationResult<UsageEngineCommandCompletion>> => {
    if (signal?.aborted === true) {
      return { code: 'cancelled', kind: 'error' };
    }
    try {
      return { kind: 'success', value: await execute(command, signal) };
    } catch (error) {
      return { code: failureCodeOf(error, signal), kind: 'error' };
    }
  };

  const commands: DelegationCommands = {
    cancel: async (jobId, signal) => {
      const outcome = await run({ command: 'cancel-delegation', jobId }, signal);
      if (outcome.kind === 'error') {
        return outcome;
      }
      const completion = outcome.value;
      if (completion.state !== 'succeeded' || completion.command !== 'cancel-delegation') {
        return UNAVAILABLE;
      }
      const { jobId: cancelledJobId, result, state } = completion.output;
      return { kind: 'success', value: { jobId: cancelledJobId, result, state } };
    },
    evaluate: async (input, signal) => {
      const outcome = await run(
        {
          author: input.author,
          authorLabel: input.authorLabel,
          command: 'record-delegation-evaluation',
          evaluation: input.evaluation,
          jobId: input.jobId,
        },
        signal,
      );
      if (outcome.kind === 'error') {
        return outcome;
      }
      const completion = outcome.value;
      if (completion.state !== 'succeeded' || completion.command !== 'record-delegation-evaluation') {
        return UNAVAILABLE;
      }
      const { evaluationId, refusal } = completion.output;
      return { kind: 'success', value: { evaluationId, refusal } };
    },
    qualify: async (request, purpose, signal) => {
      const outcome = await run({ command: 'qualify-delegation', purpose, request: { ...request } }, signal);
      if (outcome.kind === 'error') {
        return outcome;
      }
      const completion = outcome.value;
      if (completion.state !== 'succeeded' || completion.command !== 'qualify-delegation') {
        return UNAVAILABLE;
      }
      return { kind: 'success', value: completion.output.qualification };
    },
    start: async (input, signal) => {
      const outcome = await run(
        {
          command: 'start-delegation',
          idempotencyKey: input.idempotencyKey,
          request: { ...input.request },
          selection: { ...input.selection },
        },
        signal,
      );
      if (outcome.kind === 'error') {
        return outcome;
      }
      const completion = outcome.value;
      if (completion.state !== 'succeeded' || completion.command !== 'start-delegation') {
        return UNAVAILABLE;
      }
      const { job, refusal } = completion.output;
      return { kind: 'success', value: { job, refusal } };
    },
  };
  return Object.freeze(commands);
};

/**
 * Finds the running engine for this store and config root and returns an executor over its control
 * plane. No rendezvous means no engine is running (`engine-unavailable`); a rendezvous for another
 * target means this target's engine is not running either; an unreadable or incompatible rendezvous
 * is `unavailable`. Nothing is started here: a foreground one-shot engine would terminate the
 * workers it launched when it quiesced, so delegation goes only through a daemon.
 */
export const connectDelegationEngine = async (
  options: ConnectDelegationEngineOptions,
): Promise<DelegationCommandExecutor> => {
  const { configCwd, expectedStoreSchemaVersion, runtimePaths, timeoutMs } = options;
  const present = await lstat(runtimePaths.rendezvousPath).then(
    () => true,
    (error: unknown) => {
      if (errorHasCode(error, 'ENOENT') || errorHasCode(error, 'ENOTDIR')) {
        return false;
      }
      throw new DelegationEngineConnectionError('unavailable', 'The usage engine rendezvous could not be read.', {
        cause: error,
      });
    },
  );
  if (!present) {
    throw new DelegationEngineConnectionError('engine-unavailable', 'No usage engine is running for this store.');
  }
  let rendezvous: Awaited<ReturnType<typeof loadUsageEngineRendezvous>>;
  try {
    rendezvous = await loadUsageEngineRendezvous(runtimePaths.rendezvousPath);
    assertUsageEngineRendezvousTarget(
      rendezvous,
      usageEngineTargetIdFor({ configCwd, databasePath: runtimePaths.databasePath }),
    );
  } catch (error) {
    if (error instanceof UsageEngineRendezvousError && error.reason === 'target-mismatch') {
      throw new DelegationEngineConnectionError(
        'engine-unavailable',
        'The running usage engine serves another store or config root.',
        { cause: error },
      );
    }
    throw new DelegationEngineConnectionError('unavailable', 'The usage engine rendezvous is not usable.', {
      cause: error,
    });
  }
  const control = createUsageEngineControlClient({ resolveRendezvous: () => Promise.resolve(rendezvous) });
  // A rendezvous can outlive its engine. One status request tells a dead engine from a live one at
  // once, where the completion's event stream would reconnect until its timeout.
  try {
    await control.getStatus(options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) {
    if (
      error instanceof UsageEngineControlError &&
      (error.code === 'engine-unavailable' || error.code === 'transport-failed')
    ) {
      throw new DelegationEngineConnectionError('engine-unavailable', 'The usage engine is not reachable.', {
        cause: error,
      });
    }
    if (error instanceof UsageEngineControlError && error.code === 'aborted') {
      throw error;
    }
    throw new DelegationEngineConnectionError('unavailable', 'The usage engine did not answer its status.', {
      cause: error,
    });
  }
  return (command, signal) =>
    executeUsageEngineCommandToCompletion(control, command, {
      expectedStoreSchemaVersion,
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
};
