import { type ContractRouterClient, oc } from '@orpc/contract';
import {
  check,
  custom,
  type InferOutput,
  maxLength,
  minLength,
  minValue,
  nullable,
  number,
  parse,
  picklist,
  pipe,
  regex,
  safeInteger,
  strictObject,
  string,
} from 'valibot';
import { publicErrorMap } from './errors';
import { emptyInputSchema, isJsonWireValue } from './schema-conventions';

const replicationDiagnosticCodeSchema = picklist([
  'acknowledged',
  'blocked',
  'configuration-invalid',
  'credential-missing',
  'credential-unavailable',
  'device-rejected',
  'device-unreachable',
  'idle',
  'retry-scheduled',
  'setup-failed',
]);
const replicationProblemCodeSchema = picklist([
  'batch-id-conflict',
  'capture-context-forbidden',
  'event-id-conflict',
  'generation-gap',
  'invalid-batch',
  'overlap-conflict',
  'protocol-incompatible',
  'rate-limited',
  'request-too-large',
  'revoked',
  'server-unavailable',
  'unauthenticated',
]);
const replicationStreamIdSchema = picklist(['memory-v1', 'usage-v1']);

const isStrictIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const timestampSchema = custom<string>(isStrictIsoTimestamp, 'Expected a canonical ISO timestamp.');
const nonNegativeIntegerSchema = pipe(number(), safeInteger(), minValue(0));
const errorCodeSchema = pipe(string(), minLength(1), maxLength(128), regex(/^[a-z0-9][a-z0-9-]{0,127}$/u));

const replicationDiagnosticSchema = strictObject({
  code: replicationDiagnosticCodeSchema,
  problemCode: nullable(replicationProblemCodeSchema),
  streamId: nullable(replicationStreamIdSchema),
});

const replicationStreamStatusSchema = strictObject({
  acknowledged: nonNegativeIntegerSchema,
  acknowledgedThroughGeneration: nonNegativeIntegerSchema,
  blocked: nonNegativeIntegerSchema,
  inFlight: nonNegativeIntegerSchema,
  lastAcknowledgedAt: nullable(timestampSchema),
  lastErrorCode: nullable(errorCodeSchema),
  nextRetryAt: nullable(timestampSchema),
  oldestUnacknowledgedAt: nullable(timestampSchema),
  pending: nonNegativeIntegerSchema,
  streamId: replicationStreamIdSchema,
});

export const replicationStatusSchema = pipe(
  custom<unknown>(isJsonWireValue, 'Expected a finite JSON replication status without accessors.'),
  strictObject({
    kind: picklist(['replication-status']),
    lastDiagnostic: nullable(replicationDiagnosticSchema),
    memory: nullable(replicationStreamStatusSchema),
    mode: picklist(['connected', 'local-only']),
    runtimeState: picklist(['connecting', 'disabled', 'disposed', 'publishing', 'waiting']),
    usage: nullable(replicationStreamStatusSchema),
  }),
  check(
    ({ lastDiagnostic, memory, mode, runtimeState, usage }) =>
      (mode === 'local-only' &&
        runtimeState === 'disabled' &&
        lastDiagnostic === null &&
        memory === null &&
        usage === null) ||
      (mode === 'connected' &&
        runtimeState !== 'disabled' &&
        (memory === null || memory.streamId === 'memory-v1') &&
        (usage === null || usage.streamId === 'usage-v1')),
    'Replication mode, runtime, and stream identities must be consistent.',
  ),
);

export type ReplicationStatus = InferOutput<typeof replicationStatusSchema>;
export type ReplicationStreamStatus = NonNullable<ReplicationStatus['memory']>;
export const parseReplicationStatus = (value: unknown): ReplicationStatus => parse(replicationStatusSchema, value);

const replicationStatusErrors = {
  ForbiddenDemo: publicErrorMap.ForbiddenDemo,
  Unavailable: publicErrorMap.Unavailable,
} as const;

export const replicationContract = {
  status: oc
    .route({ method: 'GET', path: '/replication/status' })
    .input(emptyInputSchema)
    .output(replicationStatusSchema)
    .errors(replicationStatusErrors),
} as const;

export type ReplicationContractClient = ContractRouterClient<typeof replicationContract>;
