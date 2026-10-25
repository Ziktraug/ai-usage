import {
  type DelegationCancelInput,
  type DelegationCancelOutput,
  type DelegationContractClient,
  type DelegationIssueWire,
  type DelegationJobInput,
  type DelegationJobsInput,
  type DelegationJobsOutput,
  type DelegationJobViewWire,
  type DelegationQualificationWire,
  type DelegationRecordAcceptanceInput,
  type DelegationRecordAcceptanceOutput,
  type DelegationSaveSettingsInput,
  type DelegationSaveSettingsOutput,
  type DelegationSettingsView,
  type DelegationSimulateInput,
  delegationIssueSchema,
  parseDelegationCancelOutput,
  parseDelegationJobsOutput,
  parseDelegationJobView,
  parseDelegationQualificationWire,
  parseDelegationRecordAcceptanceOutput,
  parseDelegationSaveSettingsOutput,
  parseDelegationSettingsView,
} from '@ai-usage/web-contract/delegation';
import { ORPCError } from '@orpc/client';
import { safeParse } from 'valibot';

export type DelegationRpcTransport = Pick<
  DelegationContractClient,
  'cancel' | 'job' | 'jobs' | 'recordAcceptance' | 'saveSettings' | 'settings' | 'simulate'
>;

export interface DelegationClientCallOptions {
  readonly signal?: AbortSignal;
}

export const delegationErrorTags = [
  'Conflict',
  'EngineUnavailable',
  'ForbiddenDemo',
  'IncompatibleStore',
  'InvalidInput',
  'Unavailable',
] as const;
export type DelegationErrorTag = (typeof delegationErrorTags)[number];

/**
 * A failure the page renders: the defined error's tag and message, plus what the contract attached
 * to it (the current revision on a conflict, the issues by config path on an invalid write, the
 * stable reason such as `job-not-found`). Anything that is not a defined error is `Unavailable`
 * with fixed text, so no server detail reaches the page.
 */
export interface DelegationClientError {
  readonly issues?: readonly DelegationIssueWire[];
  readonly message: string;
  readonly reason?: string;
  readonly revision?: string;
  readonly tag: DelegationErrorTag;
}

export type DelegationClientResult<Data> =
  | { readonly data: Data; readonly ok: true }
  | { readonly error: DelegationClientError; readonly ok: false };

export interface DelegationClient {
  readonly cancel: (
    input: DelegationCancelInput,
    options?: DelegationClientCallOptions,
  ) => Promise<DelegationClientResult<DelegationCancelOutput>>;
  readonly job: (
    input: DelegationJobInput,
    options?: DelegationClientCallOptions,
  ) => Promise<DelegationClientResult<DelegationJobViewWire>>;
  readonly jobs: (
    input: DelegationJobsInput,
    options?: DelegationClientCallOptions,
  ) => Promise<DelegationClientResult<DelegationJobsOutput>>;
  readonly recordAcceptance: (
    input: DelegationRecordAcceptanceInput,
    options?: DelegationClientCallOptions,
  ) => Promise<DelegationClientResult<DelegationRecordAcceptanceOutput>>;
  readonly saveSettings: (
    input: DelegationSaveSettingsInput,
    options?: DelegationClientCallOptions,
  ) => Promise<DelegationClientResult<DelegationSaveSettingsOutput>>;
  readonly settings: (options?: DelegationClientCallOptions) => Promise<DelegationClientResult<DelegationSettingsView>>;
  readonly simulate: (
    input: DelegationSimulateInput,
    options?: DelegationClientCallOptions,
  ) => Promise<DelegationClientResult<DelegationQualificationWire>>;
}

const isDelegationErrorTag = (value: unknown): value is DelegationErrorTag =>
  typeof value === 'string' && (delegationErrorTags as readonly string[]).includes(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a defined error attached, read defensively: only the shapes the contract declares survive. */
const errorDetail = (data: unknown): Pick<DelegationClientError, 'issues' | 'reason' | 'revision'> => {
  if (!isRecord(data)) {
    return {};
  }
  const issues = Array.isArray(data.issues)
    ? data.issues.flatMap((issue) => {
        const parsed = safeParse(delegationIssueSchema, issue);
        return parsed.success ? [parsed.output] : [];
      })
    : undefined;
  return {
    ...(issues === undefined ? {} : { issues }),
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(typeof data.revision === 'string' ? { revision: data.revision } : {}),
  };
};

const failure = (error: unknown, fallback: string): DelegationClientResult<never> => {
  if (error instanceof ORPCError && error.defined && isDelegationErrorTag(error.code)) {
    return { error: { ...errorDetail(error.data), message: error.message, tag: error.code }, ok: false };
  }
  return { error: { message: fallback, tag: 'Unavailable' }, ok: false };
};

const callOptions = (options: DelegationClientCallOptions) =>
  options.signal === undefined ? undefined : { signal: options.signal };

const guarded = async <Data>(
  options: DelegationClientCallOptions,
  call: () => Promise<unknown>,
  parse: (value: unknown) => Data,
  fallback: string,
): Promise<DelegationClientResult<Data>> => {
  try {
    options.signal?.throwIfAborted();
    const result = await call();
    options.signal?.throwIfAborted();
    return { data: parse(result), ok: true };
  } catch (error) {
    // Cancellation is the caller's; it is never reported as an availability failure.
    options.signal?.throwIfAborted();
    return failure(error, fallback);
  }
};

/**
 * The browser-side delegation client: every answer is a result the page renders, never an
 * exception, except cancellation which is re-thrown. Defined errors keep their tag and detail.
 */
export const createDelegationClient = (transport: DelegationRpcTransport): DelegationClient => ({
  cancel: (input, options = {}) =>
    guarded(
      options,
      () => transport.cancel(input, callOptions(options)),
      parseDelegationCancelOutput,
      'The cancellation could not be recorded.',
    ),
  job: (input, options = {}) =>
    guarded(
      options,
      () => transport.job(input, callOptions(options)),
      parseDelegationJobView,
      'The delegation job is unavailable.',
    ),
  jobs: (input, options = {}) =>
    guarded(
      options,
      () => transport.jobs(input, callOptions(options)),
      parseDelegationJobsOutput,
      'Delegation jobs are unavailable.',
    ),
  recordAcceptance: (input, options = {}) =>
    guarded(
      options,
      () => transport.recordAcceptance(input, callOptions(options)),
      parseDelegationRecordAcceptanceOutput,
      'The acceptance could not be recorded.',
    ),
  saveSettings: (input, options = {}) =>
    guarded(
      options,
      () => transport.saveSettings(input, callOptions(options)),
      parseDelegationSaveSettingsOutput,
      'The delegation settings could not be written.',
    ),
  settings: (options = {}) =>
    guarded(
      options,
      () => transport.settings({}, callOptions(options)),
      parseDelegationSettingsView,
      'Delegation settings are unavailable.',
    ),
  simulate: (input, options = {}) =>
    guarded(
      options,
      () => transport.simulate(input, callOptions(options)),
      parseDelegationQualificationWire,
      'The delegation could not be simulated.',
    ),
});
