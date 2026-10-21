import type { WorkAttentionDataset } from '@ai-usage/report-core/work-attention';
import { queryWorkAttention } from '@ai-usage/report-data/work-attention-read';
import { usageStoreErrorReasonFrom } from '@ai-usage/usage-store/reader';
import type { WorkAttentionErrorTag, WorkAttentionInput } from '@ai-usage/web-contract/work';
import { Effect, type Either } from 'effect';
import type { RuntimeMode } from '../runtime-mode';
import { getServerRuntimeMode } from './runtime-mode.server';
import { resolveUsageWebRuntimePaths } from './usage-runtime-paths.server';

/**
 * The server side of `work.attention` (ADR 0050). Live mode reads the usage store read-only
 * through the one read model in `report-data`; e2e mode serves the same read model over a
 * disposable store seeded once per process; demo mode exposes nothing. Failures become the
 * envelope the contract declares, with a public message that never carries a path.
 */

export type WorkAttentionServerResult =
  | { readonly data: WorkAttentionDataset; readonly ok: true }
  | { readonly error: { readonly message: string; readonly tag: WorkAttentionErrorTag }; readonly ok: false };

export interface WorkAttentionServerOptions {
  /** Overrides the runtime database path; tests point it at a disposable store. */
  readonly dbPath?: string;
  readonly mode?: RuntimeMode;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

const INCOMPATIBLE_STORE_REASONS = new Set(['corrupt', 'schema-too-new', 'schema-too-old']);

const failure = (tag: WorkAttentionErrorTag, message: string): WorkAttentionServerResult => ({
  error: { message, tag },
  ok: false,
});

export const readWorkAttentionFromStore = async (input: {
  readonly dbPath: string;
  readonly now?: () => Date;
  readonly request: WorkAttentionInput;
  readonly signal?: AbortSignal;
}): Promise<WorkAttentionServerResult> => {
  input.signal?.throwIfAborted();
  let result: Either.Either<WorkAttentionDataset, unknown>;
  try {
    result = await Effect.runPromise(
      Effect.either(
        queryWorkAttention({
          dbPath: input.dbPath,
          ...(input.request.limit === undefined ? {} : { limit: input.request.limit }),
          ...(input.request.machineId === undefined || input.request.machineId === null
            ? {}
            : { machineId: input.request.machineId }),
          ...(input.now === undefined ? {} : { now: input.now() }),
        }),
      ),
      input.signal === undefined ? undefined : { signal: input.signal },
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    throw error;
  }
  input.signal?.throwIfAborted();
  if (result._tag === 'Right') {
    return { data: result.right, ok: true };
  }
  const reason = usageStoreErrorReasonFrom(result.left);
  if (reason !== undefined && INCOMPATIBLE_STORE_REASONS.has(reason)) {
    return failure('IncompatibleStore', 'The usage store is not compatible with this version of the application.');
  }
  return failure('Unavailable', 'Work attention could not be read from the usage store.');
};

export const readWorkAttentionForServer = async (
  request: WorkAttentionInput,
  options: WorkAttentionServerOptions = {},
): Promise<WorkAttentionServerResult> => {
  const mode = options.mode ?? getServerRuntimeMode();
  if (mode === 'demo') {
    return failure('ForbiddenDemo', 'Work attention is unavailable in demo mode.');
  }
  if (mode === 'e2e') {
    const fixture = await import('./work-attention-e2e-fixture.server');
    return await fixture.readE2EWorkAttention(request, options.signal);
  }
  return await readWorkAttentionFromStore({
    dbPath: options.dbPath ?? resolveUsageWebRuntimePaths().databasePath,
    ...(options.now === undefined ? {} : { now: options.now }),
    request,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
};
