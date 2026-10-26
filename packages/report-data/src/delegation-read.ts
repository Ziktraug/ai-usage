import { type DelegationJobView, projectDelegationJobView } from '@ai-usage/report-core/delegation-job';
import { isDelegationUuid } from '@ai-usage/report-core/delegation-request';
import { DELEGATION_LIVE_STATES } from '@ai-usage/report-core/delegation-vocabulary';
import { type DelegationStoreReadFailure, readDelegationJob, readDelegationJobs } from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';

/**
 * Delegation jobs as an edge reads them (ADR 0077): the bounded job view of `report-core`, from the
 * query-only usage-store reader, without any engine. The CLI (`ai-usage delegation status|list`)
 * and the local MCP tools (`delegation.status`, `delegation.list`) both call these functions, so a
 * second client of the same operator reads a job a first client started, even when the engine is
 * down. Failures are typed and their messages fixed: a missing store is a failure, never an empty
 * list, and no message names a path or a store detail.
 */

export const DELEGATION_READ_BOUNDS = {
  defaultListLimit: 20,
  /** Jobs one list answer carries at most; each is a bounded view of up to 64 KiB. */
  maxListLimit: 50,
} as const;

export const DELEGATION_READ_FAILURE_CODES = [
  'cancelled',
  'incompatible-store',
  'invalid-input',
  'not-found',
  'store-missing',
  'store-not-upgraded',
  'unavailable',
] as const;
export type DelegationReadFailureCode = (typeof DELEGATION_READ_FAILURE_CODES)[number];

/** A typed failure whose message never carries a path or a store detail. */
export interface DelegationReadFailure {
  readonly code: DelegationReadFailureCode;
  readonly message: string;
}

export type DelegationReadResult<Value> =
  | { readonly failure: DelegationReadFailure; readonly kind: 'error' }
  | { readonly kind: 'success'; readonly value: Value };

export interface DelegationJobList {
  /** Newest request first. */
  readonly jobs: readonly DelegationJobView[];
  /** Persisted rows that no longer pass validation; counted, never silently omitted. */
  readonly skipped: number;
  readonly truncated: boolean;
}

export interface ReadDelegationJobViewInput {
  readonly dbPath: string;
  readonly jobId: string;
  /** The instant heartbeat ages are measured against; defaults to the read time. */
  readonly now?: string;
  readonly signal?: AbortSignal;
}

export interface ListDelegationJobViewsInput {
  readonly dbPath: string;
  /** 1 to `DELEGATION_READ_BOUNDS.maxListLimit`; defaults to `defaultListLimit`. */
  readonly limit?: number;
  /** Only jobs in a live state (`requested`, `starting`, `running`). */
  readonly liveOnly?: boolean;
  readonly now?: string;
  readonly signal?: AbortSignal;
}

const failure = <Value>(code: DelegationReadFailureCode, message: string): DelegationReadResult<Value> => ({
  failure: { code, message },
  kind: 'error',
});

const CANCELLED_MESSAGE = 'The delegation read was cancelled.';

/** Maps a store read failure to its typed, path-free failure. */
export const delegationReadFailureOf = (read: DelegationStoreReadFailure): DelegationReadFailure => {
  switch (read.kind) {
    case 'store-missing':
      return {
        code: 'store-missing',
        message: 'No usage store exists yet; the usage engine creates it on its first run.',
      };
    case 'store-not-upgraded':
      return {
        code: 'store-not-upgraded',
        message:
          'The usage store has not been upgraded for this version yet; the engine upgrades it when it next starts.',
      };
    case 'incompatible-store':
      return {
        code: 'incompatible-store',
        message: 'The usage store is not compatible with this version of ai-usage.',
      };
    default:
      return { code: 'unavailable', message: 'The delegation jobs could not be read from the usage store.' };
  }
};

/** Read at call time: the signal may abort while the effect runs, after the first check narrowed it. */
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const runRead = async <Read>(
  effect: Effect.Effect<Read>,
  signal: AbortSignal | undefined,
): Promise<DelegationReadResult<Read>> => {
  if (isAborted(signal)) {
    return failure('cancelled', CANCELLED_MESSAGE);
  }
  try {
    const value = await Effect.runPromise(effect, signal === undefined ? undefined : { signal });
    return { kind: 'success', value };
  } catch (error) {
    if (isAborted(signal)) {
      return failure('cancelled', CANCELLED_MESSAGE);
    }
    // The reader classifies storage failures itself; anything thrown past it is a defect of the read.
    throw error;
  }
};

const nowOf = (now: string | undefined): string => now ?? new Date().toISOString();

/** One job with its evaluations as the bounded view; `not-found` when no row has the id. */
export const readDelegationJobView = async (
  input: ReadDelegationJobViewInput,
): Promise<DelegationReadResult<DelegationJobView>> => {
  if (!isDelegationUuid(input.jobId)) {
    return failure('invalid-input', 'The delegation job id must be the lowercase UUID of a job.');
  }
  const read = await runRead(readDelegationJob({ dbPath: input.dbPath, jobId: input.jobId }), input.signal);
  if (read.kind === 'error') {
    return read;
  }
  const outcome = read.value;
  if (outcome.kind === 'not-found') {
    return failure('not-found', 'No delegation job has this id.');
  }
  if (outcome.kind !== 'ok') {
    return { failure: delegationReadFailureOf(outcome), kind: 'error' };
  }
  return {
    kind: 'success',
    value: projectDelegationJobView(outcome.job, outcome.evaluations, { now: nowOf(input.now) }),
  };
};

/** Recent jobs, newest first, each as the bounded view; an empty store answers an empty list. */
export const listDelegationJobViews = async (
  input: ListDelegationJobViewsInput,
): Promise<DelegationReadResult<DelegationJobList>> => {
  const limit = input.limit ?? DELEGATION_READ_BOUNDS.defaultListLimit;
  if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= DELEGATION_READ_BOUNDS.maxListLimit)) {
    return failure(
      'invalid-input',
      `The delegation list limit must be an integer from 1 to ${DELEGATION_READ_BOUNDS.maxListLimit}.`,
    );
  }
  const read = await runRead(
    readDelegationJobs({
      dbPath: input.dbPath,
      limit,
      ...(input.liveOnly === true ? { states: DELEGATION_LIVE_STATES } : {}),
    }),
    input.signal,
  );
  if (read.kind === 'error') {
    return read;
  }
  const outcome = read.value;
  if (outcome.kind !== 'ok') {
    return { failure: delegationReadFailureOf(outcome), kind: 'error' };
  }
  const now = nowOf(input.now);
  return {
    kind: 'success',
    value: {
      jobs: outcome.jobs.map((job) => projectDelegationJobView(job, outcome.evaluations, { now })),
      skipped: outcome.skipped,
      truncated: outcome.truncated,
    },
  };
};
