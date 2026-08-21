import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  array,
  boolean,
  check,
  custom,
  type InferOutput,
  maxLength,
  minLength,
  minValue,
  nullable,
  number,
  parse,
  pipe,
  safeInteger,
  strictObject,
  string,
} from 'valibot';
import { publicErrorMap } from './errors';
import { emptyInputSchema, isJsonWireValue } from './schema-conventions';

const MAX_MACHINE_TEXT = 512;
const MAX_FLEET_MACHINES = 100;

const isStrictIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const machineIdSchema = pipe(string(), minLength(1), maxLength(MAX_MACHINE_TEXT));
const machineLabelSchema = pipe(string(), maxLength(MAX_MACHINE_TEXT));
const nonNegativeIntegerSchema = pipe(number(), safeInteger(), minValue(0));
const timestampSchema = custom<string>(isStrictIsoTimestamp, 'Expected a canonical ISO timestamp.');

const usageMachineSchema = strictObject({ id: machineIdSchema, label: machineLabelSchema });
const fleetMachineSchema = strictObject({
  hasLocalObservedRows: boolean(),
  hasPortableRows: boolean(),
  id: machineIdSchema,
  label: machineLabelSchema,
  lastSeenAt: timestampSchema,
  newestSessionAt: nullable(timestampSchema),
  sessionCount: nonNegativeIntegerSchema,
});

const syncFleetRecordSchema = pipe(
  strictObject({
    currentMachine: usageMachineSchema,
    machines: pipe(array(fleetMachineSchema), maxLength(MAX_FLEET_MACHINES)),
    omittedMachines: nonNegativeIntegerSchema,
    skipped: nonNegativeIntegerSchema,
  }),
  check(
    ({ machines }) => new Set(machines.map(({ id }) => id)).size === machines.length,
    'Sync fleet machine identifiers must be unique.',
  ),
);

export const syncFleetOutputSchema = pipe(
  custom<unknown>(isJsonWireValue, 'Expected a finite JSON Sync fleet response without accessors.'),
  syncFleetRecordSchema,
);
export type SyncFleet = InferOutput<typeof syncFleetOutputSchema>;
export const parseSyncFleet = (value: unknown): SyncFleet => parse(syncFleetOutputSchema, value);

// The engine bounds `set-machine-label` by UTF-8 bytes, so this boundary counts bytes too: a
// character cap would accept a label the engine then rejects, and the rename would fail late.
export const MAX_MACHINE_LABEL_BYTES = 240;
const labelEncoder = new TextEncoder();

const machineLabelInputSchema = pipe(
  string(),
  check((value) => value.trim().length > 0, 'A machine label cannot be blank.'),
  check(
    (value) => labelEncoder.encode(value.trim()).byteLength <= MAX_MACHINE_LABEL_BYTES,
    'A machine label exceeds its byte limit.',
  ),
);

export const syncMachineLabelInputSchema = pipe(
  custom<unknown>(isJsonWireValue, 'Expected a finite JSON machine label request without accessors.'),
  strictObject({ label: machineLabelInputSchema }),
);
export type SyncMachineLabelInput = InferOutput<typeof syncMachineLabelInputSchema>;

export const syncMachineLabelOutputSchema = pipe(
  custom<unknown>(isJsonWireValue, 'Expected a finite JSON machine label response without accessors.'),
  strictObject({ machine: usageMachineSchema }),
);
export type SyncMachineLabelResult = InferOutput<typeof syncMachineLabelOutputSchema>;
export const parseSyncMachineLabelResult = (value: unknown): SyncMachineLabelResult =>
  parse(syncMachineLabelOutputSchema, value);

const syncFleetErrors = {
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  IncompatibleStore: publicErrorMap.IncompatibleStore,
  Unavailable: publicErrorMap.Unavailable,
} as const;

const syncMachineLabelErrors = {
  EngineUnavailable: publicErrorMap.EngineUnavailable,
  Forbidden: publicErrorMap.Forbidden,
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  InvalidInput: publicErrorMap.InvalidInput,
} as const;

export const syncContract = {
  fleet: oc
    .route({ method: 'GET', path: '/sync/fleet' })
    .input(emptyInputSchema)
    .output(syncFleetOutputSchema)
    .errors(syncFleetErrors),
  setMachineLabel: oc
    .route({ method: 'POST', path: '/sync/setMachineLabel' })
    .input(syncMachineLabelInputSchema)
    .output(syncMachineLabelOutputSchema)
    .errors(syncMachineLabelErrors),
} as const;

export type SyncContractClient = ContractRouterClient<typeof syncContract>;

export interface ExplicitSyncTransportDescriptor {
  readonly abort: 'request-signal' | 'request-signal-with-late-staging-cleanup';
  readonly body: 'none' | 'portable-usage-json';
  readonly csrf: 'required';
  readonly id: 'manual-merge-download' | 'manual-merge-upload';
  readonly method: 'POST';
  readonly path: '/api/manual-merge/download' | '/api/manual-merge/upload';
  readonly response: 'attachment-portable-usage-json' | 'bounded-json';
  readonly trustedLocal: 'required';
}

export const manualMergeUploadTransport = {
  abort: 'request-signal-with-late-staging-cleanup',
  body: 'portable-usage-json',
  csrf: 'required',
  id: 'manual-merge-upload',
  method: 'POST',
  path: '/api/manual-merge/upload',
  response: 'bounded-json',
  trustedLocal: 'required',
} as const satisfies ExplicitSyncTransportDescriptor;

export const manualMergeDownloadTransport = {
  abort: 'request-signal',
  body: 'none',
  csrf: 'required',
  id: 'manual-merge-download',
  method: 'POST',
  path: '/api/manual-merge/download',
  response: 'attachment-portable-usage-json',
  trustedLocal: 'required',
} as const satisfies ExplicitSyncTransportDescriptor;
