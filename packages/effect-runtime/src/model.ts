export type BoundaryOutcome = 'degraded' | 'failure' | 'interrupted' | 'success' | 'timed-out';

export type LogScalar = boolean | number | string | null;

export type LogValue = LogScalar | readonly LogValue[] | { readonly [key: string]: LogValue };

export interface SanitizedTaggedError {
  readonly code?: string;
  readonly message?: string;
  readonly tag: string;
}

export interface ServiceHop {
  readonly annotations?: Readonly<Record<string, LogValue>>;
  readonly children?: readonly ServiceHop[];
  readonly durationMs: number;
  readonly name: string;
  readonly outcome: BoundaryOutcome;
  readonly spanId: string;
  readonly traceId: string;
}

export interface WideEventSnapshot {
  readonly annotations: Readonly<Record<string, LogValue>>;
  readonly boundary: string;
  readonly durationMs: number;
  readonly emittedAt: string;
  readonly error: SanitizedTaggedError | null;
  readonly event: 'wide-event';
  readonly eventId: string;
  readonly outcome: BoundaryOutcome;
  readonly schemaVersion: 1;
  readonly services: readonly ServiceHop[];
  readonly spanId: string;
  readonly startedAt: string;
  readonly traceId: string;
}

export interface BoundaryClassification {
  readonly annotations?: Readonly<Record<string, LogValue>>;
  readonly error?: SanitizedTaggedError | null;
  readonly outcome: BoundaryOutcome;
}

export const MAX_SERIALIZED_EVENT_BYTES = 256 * 1024;
export const MAX_COMPLETED_HOPS = 256;
export const MAX_HOP_LEVELS = 16;
export const MAX_ANNOTATION_KEYS = 64;
export const MAX_ANNOTATION_LEVELS = 8;
export const MAX_ARRAY_ITEMS = 128;
export const MAX_STRING_BYTES = 4 * 1024;
export const MAX_ERROR_MESSAGE_BYTES = 1 * 1024;
