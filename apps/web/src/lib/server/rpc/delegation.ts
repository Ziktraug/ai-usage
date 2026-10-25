import {
  DELEGATION_JOB_NOT_FOUND_REASON,
  type DelegationCancelInput,
  type DelegationConflictData,
  type DelegationInvalidInputData,
  type DelegationIssueWire,
  type DelegationJobInput,
  type DelegationJobsInput,
  type DelegationRecordAcceptanceInput,
  type DelegationSaveSettingsInput,
  type DelegationSimulateInput,
  delegationCancelOutputSchema,
  delegationContract,
  delegationJobsOutputSchema,
  delegationJobViewSchema,
  delegationQualificationSchema,
  delegationRecordAcceptanceOutputSchema,
  delegationSaveSettingsOutputSchema,
  delegationSettingsViewSchema,
} from '@ai-usage/web-contract/delegation';
import { implement } from '@orpc/server';
import { type BaseIssue, type BaseSchema, type InferOutput, parse } from 'valibot';

/**
 * What the server side of one delegation procedure can answer: the data, or a typed failure the
 * router turns into the procedure's defined error. The server modules never see oRPC; the router
 * never sees the store, the config or the engine. A failure's message is already safe for the
 * browser (no path, no value); its `reason` is a stable lowercase token.
 */
export type DelegationFailure =
  | { readonly kind: 'conflict'; readonly message: string; readonly revision?: string }
  | { readonly kind: 'engine-unavailable'; readonly message: string }
  | { readonly kind: 'forbidden-demo'; readonly message: string }
  | { readonly kind: 'incompatible-store'; readonly message: string }
  | {
      readonly issues: readonly DelegationIssueWire[];
      readonly kind: 'invalid-input';
      readonly message: string;
      readonly reason: string;
    }
  | { readonly kind: 'not-found'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string; readonly reason: string };

export type DelegationOutcome<Data> = DelegationFailure | { readonly data: Data; readonly kind: 'ok' };

export const delegationOk = <Data>(data: Data): DelegationOutcome<Data> => ({ data, kind: 'ok' });

export interface DelegationRpcDependencies {
  readonly cancel: (
    input: DelegationCancelInput,
    signal: AbortSignal | undefined,
  ) => Promise<DelegationOutcome<unknown>>;
  readonly readJob: (input: DelegationJobInput, signal: AbortSignal | undefined) => Promise<DelegationOutcome<unknown>>;
  readonly readJobs: (
    input: DelegationJobsInput,
    signal: AbortSignal | undefined,
  ) => Promise<DelegationOutcome<unknown>>;
  readonly readSettings: (signal: AbortSignal | undefined) => Promise<DelegationOutcome<unknown>>;
  readonly recordAcceptance: (
    input: DelegationRecordAcceptanceInput,
    signal: AbortSignal | undefined,
  ) => Promise<DelegationOutcome<unknown>>;
  readonly saveSettings: (
    input: DelegationSaveSettingsInput,
    signal: AbortSignal | undefined,
  ) => Promise<DelegationOutcome<unknown>>;
  readonly simulate: (
    input: DelegationSimulateInput,
    signal: AbortSignal | undefined,
  ) => Promise<DelegationOutcome<unknown>>;
}

type ErrorConstructor<Data> = (options: { readonly data: Data; readonly message: string }) => Error;
interface ReasonData {
  readonly reason?: string;
}

/** The constructors a procedure defines; a failure without one on this procedure becomes `Unavailable`. */
interface DelegationErrorConstructors {
  readonly Conflict?: ErrorConstructor<DelegationConflictData>;
  readonly EngineUnavailable?: ErrorConstructor<ReasonData>;
  readonly ForbiddenDemo: ErrorConstructor<ReasonData>;
  readonly IncompatibleStore?: ErrorConstructor<ReasonData>;
  readonly InvalidInput?: ErrorConstructor<DelegationInvalidInputData>;
  readonly Unavailable: ErrorConstructor<ReasonData>;
}

const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');

/**
 * The error of one failure on one procedure. oRPC's `errors` proxy constructs any code, so the
 * codes the procedure actually defines are read from the contract: a failure the procedure does
 * not define becomes `Unavailable` with the failure's reason, never an undefined code.
 */
export const delegationFailureError = (
  errors: DelegationErrorConstructors,
  defined: ReadonlySet<string>,
  failure: DelegationFailure,
): Error => {
  const { message } = failure;
  switch (failure.kind) {
    case 'conflict':
      return defined.has('Conflict') && errors.Conflict
        ? errors.Conflict({
            data: {
              reason: 'revision-conflict',
              ...(failure.revision === undefined ? {} : { revision: failure.revision }),
            },
            message,
          })
        : errors.Unavailable({ data: { reason: 'revision-conflict' }, message });
    case 'engine-unavailable':
      return (
        defined.has('EngineUnavailable') && errors.EngineUnavailable ? errors.EngineUnavailable : errors.Unavailable
      )({ data: { reason: 'engine-unavailable' }, message });
    case 'forbidden-demo':
      return errors.ForbiddenDemo({ data: { reason: 'demo-read-only' }, message });
    case 'incompatible-store':
      return (
        defined.has('IncompatibleStore') && errors.IncompatibleStore ? errors.IncompatibleStore : errors.Unavailable
      )({ data: { reason: 'incompatible-store' }, message });
    case 'invalid-input':
      return defined.has('InvalidInput') && errors.InvalidInput
        ? errors.InvalidInput({ data: { issues: [...failure.issues], reason: failure.reason }, message })
        : errors.Unavailable({ data: { reason: failure.reason }, message });
    case 'not-found':
      return errors.Unavailable({ data: { reason: DELEGATION_JOB_NOT_FOUND_REASON }, message });
    default:
      return errors.Unavailable({ data: { reason: failure.reason }, message });
  }
};

interface UnavailableText {
  readonly message: string;
  readonly reason: string;
}

/**
 * One procedure: the dependency answers an outcome; a thrown dependency (config, store or engine
 * problem the server did not classify) and an answer the schema refuses both become `Unavailable`
 * with fixed text, so no path or value reaches the browser. Aborts propagate.
 */
interface DelegationProcedure {
  readonly '~orpc': { readonly errorMap?: Readonly<Record<string, unknown>> };
}

const definedCodes = (procedure: DelegationProcedure): ReadonlySet<string> =>
  new Set(Object.keys(procedure['~orpc'].errorMap ?? {}));

const relay = async <Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>>(
  errors: DelegationErrorConstructors,
  defined: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  read: () => Promise<DelegationOutcome<unknown>>,
  schema: Schema,
  unavailable: UnavailableText,
): Promise<InferOutput<Schema>> => {
  let outcome: DelegationOutcome<unknown>;
  try {
    outcome = await read();
  } catch (error) {
    signal?.throwIfAborted();
    if (isAbortError(error, signal)) {
      throw error;
    }
    throw errors.Unavailable({ data: { reason: unavailable.reason }, message: unavailable.message });
  }
  if (outcome.kind !== 'ok') {
    throw delegationFailureError(errors, defined, outcome);
  }
  try {
    return parse(schema, outcome.data);
  } catch {
    throw errors.Unavailable({ data: { reason: unavailable.reason }, message: unavailable.message });
  }
};

const SETTINGS_UNAVAILABLE: UnavailableText = {
  message: 'Delegation settings could not be read safely.',
  reason: 'delegation-settings-unavailable',
};
const SAVE_UNAVAILABLE: UnavailableText = {
  message: 'The delegation settings could not be written.',
  reason: 'delegation-save-unavailable',
};
const SIMULATE_UNAVAILABLE: UnavailableText = {
  message: 'The delegation could not be simulated.',
  reason: 'delegation-simulation-unavailable',
};
const JOBS_UNAVAILABLE: UnavailableText = {
  message: 'Delegation jobs could not be read safely.',
  reason: 'delegation-jobs-unavailable',
};
const JOB_UNAVAILABLE: UnavailableText = {
  message: 'The delegation job could not be read safely.',
  reason: 'delegation-job-unavailable',
};
const CANCEL_UNAVAILABLE: UnavailableText = {
  message: 'The cancellation could not be recorded.',
  reason: 'delegation-cancel-unavailable',
};
const ACCEPTANCE_UNAVAILABLE: UnavailableText = {
  message: 'The acceptance could not be recorded.',
  reason: 'delegation-acceptance-unavailable',
};

export const createDelegationRpcRouter = (dependencies: DelegationRpcDependencies) => {
  const delegation = implement(delegationContract);
  const codes = {
    cancel: definedCodes(delegationContract.cancel),
    job: definedCodes(delegationContract.job),
    jobs: definedCodes(delegationContract.jobs),
    recordAcceptance: definedCodes(delegationContract.recordAcceptance),
    saveSettings: definedCodes(delegationContract.saveSettings),
    settings: definedCodes(delegationContract.settings),
    simulate: definedCodes(delegationContract.simulate),
  };
  return {
    settings: delegation.settings.handler(({ errors, signal }) =>
      relay(
        errors,
        codes.settings,
        signal,
        () => dependencies.readSettings(signal),
        delegationSettingsViewSchema,
        SETTINGS_UNAVAILABLE,
      ),
    ),
    saveSettings: delegation.saveSettings.handler(({ errors, input, signal }) =>
      relay(
        errors,
        codes.saveSettings,
        signal,
        () => dependencies.saveSettings(input, signal),
        delegationSaveSettingsOutputSchema,
        SAVE_UNAVAILABLE,
      ),
    ),
    simulate: delegation.simulate.handler(({ errors, input, signal }) =>
      relay(
        errors,
        codes.simulate,
        signal,
        () => dependencies.simulate(input, signal),
        delegationQualificationSchema,
        SIMULATE_UNAVAILABLE,
      ),
    ),
    jobs: delegation.jobs.handler(({ errors, input, signal }) =>
      relay(
        errors,
        codes.jobs,
        signal,
        () => dependencies.readJobs(input, signal),
        delegationJobsOutputSchema,
        JOBS_UNAVAILABLE,
      ),
    ),
    job: delegation.job.handler(({ errors, input, signal }) =>
      relay(
        errors,
        codes.job,
        signal,
        () => dependencies.readJob(input, signal),
        delegationJobViewSchema,
        JOB_UNAVAILABLE,
      ),
    ),
    cancel: delegation.cancel.handler(({ errors, input, signal }) =>
      relay(
        errors,
        codes.cancel,
        signal,
        () => dependencies.cancel(input, signal),
        delegationCancelOutputSchema,
        CANCEL_UNAVAILABLE,
      ),
    ),
    recordAcceptance: delegation.recordAcceptance.handler(({ errors, input, signal }) =>
      relay(
        errors,
        codes.recordAcceptance,
        signal,
        () => dependencies.recordAcceptance(input, signal),
        delegationRecordAcceptanceOutputSchema,
        ACCEPTANCE_UNAVAILABLE,
      ),
    ),
  };
};

export type DelegationRpcRouter = ReturnType<typeof createDelegationRpcRouter>;
