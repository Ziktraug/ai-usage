import { Redacted } from 'effect';
import {
  type LogValue,
  MAX_ANNOTATION_KEYS,
  MAX_ANNOTATION_LEVELS,
  MAX_ARRAY_ITEMS,
  MAX_COMPLETED_HOPS,
  MAX_ERROR_MESSAGE_BYTES,
  MAX_HOP_LEVELS,
  MAX_SERIALIZED_EVENT_BYTES,
  MAX_STRING_BYTES,
  type SanitizedTaggedError,
  type ServiceHop,
  type WideEventResource,
  type WideEventSnapshot,
} from './model';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /authorization|cookie|password|secret|token/i;
const AUTHORIZATION_CREDENTIAL = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const CREDENTIAL_QUERY_VALUE = /([?&](?:access_token|api_key|apikey|password|secret|token)=)[^&#\s]+/gi;
const UTF8 = new TextEncoder();

export interface SanitizeResult {
  readonly truncated: boolean;
  readonly value: WideEventSnapshot;
}

const byteLength = (value: string): number => UTF8.encode(value).byteLength;

const truncateString = (value: string, maxBytes: number): { readonly truncated: boolean; readonly value: string } => {
  const encoded = UTF8.encode(value);
  if (encoded.byteLength <= maxBytes) {
    return { truncated: false, value };
  }
  // Walk back to a code-point boundary so JSON stays valid UTF-8 text.
  let end = maxBytes;
  // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 continuation-byte mask
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return { truncated: true, value: new TextDecoder().decode(encoded.subarray(0, end)) };
};

export const scrubApprovedPublicString = (value: string): string =>
  value
    .replace(AUTHORIZATION_CREDENTIAL, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(CREDENTIAL_QUERY_VALUE, `$1${REDACTED}`);

const safeOwnString = (value: unknown, key: string): string | undefined => {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : undefined;
  } catch {
    return;
  }
};

const sanitizeResourceString = (value: string | undefined, fallback: string): string =>
  truncateString(scrubApprovedPublicString(value ?? fallback), MAX_STRING_BYTES).value || fallback;

export const sanitizeWideEventResource = (value: unknown): WideEventResource => {
  const runtimeMode = safeOwnString(value, 'runtimeMode');
  const surface = safeOwnString(value, 'surface');
  return {
    instanceId: sanitizeResourceString(safeOwnString(value, 'instanceId'), 'unknown-instance'),
    runtimeMode:
      runtimeMode === 'development' || runtimeMode === 'production' || runtimeMode === 'test' ? runtimeMode : 'unknown',
    serviceName: 'ai-usage',
    serviceVersion: sanitizeResourceString(safeOwnString(value, 'serviceVersion'), 'unknown'),
    surface: surface === 'cli' ? 'cli' : 'web',
  };
};

const isFiniteNumber = (value: number): boolean => Number.isFinite(value);

const isLogRecord = (value: LogValue): value is Readonly<Record<string, LogValue>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withTruncationMarker = (annotations: Readonly<Record<string, LogValue>>): Readonly<Record<string, LogValue>> => {
  const retained = Object.entries(annotations)
    .filter(([key]) => key !== 'observabilityTruncated')
    .slice(0, MAX_ANNOTATION_KEYS - 1);
  return Object.fromEntries([...retained, ['observabilityTruncated', true]]);
};

const sanitizeScalar = (
  value: unknown,
  maxStringBytes: number,
): { readonly truncated: boolean; readonly value: LogValue } => {
  if (value === null) {
    return { truncated: false, value: null };
  }
  if (typeof value === 'boolean') {
    return { truncated: false, value };
  }
  if (typeof value === 'number') {
    return { truncated: false, value: isFiniteNumber(value) ? value : null };
  }
  if (typeof value === 'string') {
    return truncateString(value, maxStringBytes);
  }
  if (typeof value === 'bigint') {
    return truncateString(value.toString(), maxStringBytes);
  }
  return { truncated: false, value: null };
};

const sanitizeLogValue = (
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): { readonly truncated: boolean; readonly value: LogValue } => {
  if (Redacted.isRedacted(value)) {
    return { truncated: false, value: REDACTED };
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return sanitizeScalar(value, MAX_STRING_BYTES);
  }

  if (typeof value === 'bigint') {
    return sanitizeScalar(value, MAX_STRING_BYTES);
  }

  if (typeof value !== 'object') {
    return { truncated: false, value: null };
  }

  if (seen.has(value)) {
    return { truncated: true, value: '[Circular]' };
  }

  if (depth >= MAX_ANNOTATION_LEVELS) {
    return { truncated: true, value: '[Truncated]' };
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items: LogValue[] = [];
      let truncated = value.length > MAX_ARRAY_ITEMS;
      for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
        const nested = sanitizeLogValue(item, seen, depth + 1);
        truncated ||= nested.truncated;
        items.push(nested.value);
      }
      return { truncated, value: items };
    }

    let descriptors: Record<string, PropertyDescriptor> = {};
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return { truncated: true, value: '[Unreadable]' };
    }
    const keys = Object.keys(descriptors);
    const result: Record<string, LogValue> = {};
    let truncated = keys.length > MAX_ANNOTATION_KEYS;
    for (const key of keys.slice(0, MAX_ANNOTATION_KEYS)) {
      if (SENSITIVE_KEY.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      const descriptor = descriptors[key];
      try {
        let nested: unknown;
        if (descriptor && 'value' in descriptor) {
          nested = descriptor.value;
        } else if (descriptor?.get) {
          nested = descriptor.get.call(value);
        } else {
          nested = undefined;
        }
        const sanitized = sanitizeLogValue(nested, seen, depth + 1);
        truncated ||= sanitized.truncated;
        result[key] = sanitized.value;
      } catch {
        truncated = true;
        result[key] = '[Unreadable]';
      }
    }
    return { truncated, value: result };
  } catch {
    return { truncated: true, value: '[Unreadable]' };
  } finally {
    seen.delete(value);
  }
};

const sanitizeError = (
  error: SanitizedTaggedError | null,
): {
  readonly truncated: boolean;
  readonly value: SanitizedTaggedError | null;
} => {
  if (error === null) {
    return { truncated: false, value: null };
  }
  const tag = truncateString(error.tag, MAX_STRING_BYTES);
  const code = error.code === undefined ? undefined : truncateString(error.code, MAX_STRING_BYTES);
  const message =
    error.message === undefined
      ? undefined
      : truncateString(scrubApprovedPublicString(error.message), MAX_ERROR_MESSAGE_BYTES);
  return {
    truncated: tag.truncated || (code?.truncated ?? false) || (message?.truncated ?? false),
    value: {
      tag: tag.value,
      ...(code === undefined ? {} : { code: code.value }),
      ...(message === undefined ? {} : { message: message.value }),
    },
  };
};

type SnapshotIdentity = Pick<
  WideEventSnapshot,
  'boundary' | 'emittedAt' | 'eventId' | 'spanId' | 'startedAt' | 'traceId'
>;

const sanitizeSnapshotIdentity = (
  event: WideEventSnapshot,
): { readonly truncated: boolean; readonly value: SnapshotIdentity } => {
  const boundary = truncateString(event.boundary, MAX_STRING_BYTES);
  const emittedAt = truncateString(event.emittedAt, MAX_STRING_BYTES);
  const eventId = truncateString(event.eventId, MAX_STRING_BYTES);
  const spanId = truncateString(event.spanId, MAX_STRING_BYTES);
  const startedAt = truncateString(event.startedAt, MAX_STRING_BYTES);
  const traceId = truncateString(event.traceId, MAX_STRING_BYTES);
  return {
    truncated:
      boundary.truncated ||
      emittedAt.truncated ||
      eventId.truncated ||
      spanId.truncated ||
      startedAt.truncated ||
      traceId.truncated,
    value: {
      boundary: boundary.value,
      emittedAt: emittedAt.value,
      eventId: eventId.value,
      spanId: spanId.value,
      startedAt: startedAt.value,
      traceId: traceId.value,
    },
  };
};

const sanitizeHop = (
  hop: ServiceHop,
  seen: WeakSet<object>,
  depth: number,
  hopBudget: { remaining: number },
): { readonly truncated: boolean; readonly value: ServiceHop | null } => {
  if (hopBudget.remaining <= 0 || depth > MAX_HOP_LEVELS) {
    return { truncated: true, value: null };
  }
  hopBudget.remaining -= 1;

  let truncated = false;
  const annotations =
    hop.annotations === undefined
      ? undefined
      : (() => {
          const nested = sanitizeLogValue(hop.annotations, seen, 0);
          const record = isLogRecord(nested.value) ? nested.value : {};
          truncated ||= nested.truncated || !isLogRecord(nested.value);
          return record;
        })();

  const children: ServiceHop[] = [];
  for (const child of hop.children ?? []) {
    const nested = sanitizeHop(child, seen, depth + 1, hopBudget);
    truncated ||= nested.truncated;
    if (nested.value !== null) {
      children.push(nested.value);
    }
  }

  const name = truncateString(hop.name, MAX_STRING_BYTES);
  const traceId = truncateString(hop.traceId, MAX_STRING_BYTES);
  const spanId = truncateString(hop.spanId, MAX_STRING_BYTES);
  truncated ||= name.truncated || traceId.truncated || spanId.truncated;

  return {
    truncated,
    value: {
      name: name.value,
      traceId: traceId.value,
      spanId: spanId.value,
      outcome: hop.outcome,
      durationMs: isFiniteNumber(hop.durationMs) ? hop.durationMs : 0,
      ...(annotations === undefined ? {} : { annotations }),
      ...(children.length > 0 ? { children } : {}),
    },
  };
};

const minimalSafeSnapshot = (event: WideEventSnapshot): WideEventSnapshot => {
  const identity = sanitizeSnapshotIdentity(event).value;
  return {
    schemaVersion: 2,
    event: 'wide-event',
    ...identity,
    outcome: event.outcome,
    durationMs: isFiniteNumber(event.durationMs) ? event.durationMs : 0,
    error: null,
    resource: sanitizeWideEventResource(event.resource),
    annotations: { observabilityTruncated: true },
    services: [],
  };
};

const serializedByteLength = (event: WideEventSnapshot): number => {
  try {
    return byteLength(JSON.stringify(event));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export const sanitizeWideEventSnapshot = (event: WideEventSnapshot): SanitizeResult => {
  try {
    const seen = new WeakSet<object>();
    let truncated = false;

    const identity = sanitizeSnapshotIdentity(event);
    truncated ||= identity.truncated;

    const annotations = sanitizeLogValue(event.annotations, seen, 0);
    truncated ||= annotations.truncated;

    const error = sanitizeError(event.error);
    truncated ||= error.truncated;

    const resource = sanitizeWideEventResource(event.resource);

    const hopBudget = { remaining: MAX_COMPLETED_HOPS };
    const services: ServiceHop[] = [];
    for (const hop of event.services) {
      const nested = sanitizeHop(hop, seen, 1, hopBudget);
      truncated ||= nested.truncated;
      if (nested.value !== null) {
        services.push(nested.value);
      }
    }
    if (hopBudget.remaining < MAX_COMPLETED_HOPS - event.services.length) {
      // hops were dropped while walking children
    }
    if (services.length < event.services.length) {
      truncated = true;
    }

    const annotationsRecord = isLogRecord(annotations.value) ? annotations.value : {};
    truncated ||= !isLogRecord(annotations.value);
    let snapshot: WideEventSnapshot = {
      schemaVersion: 2,
      event: 'wide-event',
      ...identity.value,
      outcome: event.outcome,
      durationMs: isFiniteNumber(event.durationMs) ? event.durationMs : 0,
      error: error.value,
      resource,
      annotations: truncated ? withTruncationMarker(annotationsRecord) : annotationsRecord,
      services,
    };

    if (serializedByteLength(snapshot) > MAX_SERIALIZED_EVENT_BYTES) {
      truncated = true;
      snapshot = {
        ...snapshot,
        annotations: withTruncationMarker(snapshot.annotations),
        services: [],
        error: null,
      };
    }

    if (serializedByteLength(snapshot) > MAX_SERIALIZED_EVENT_BYTES) {
      return { truncated: true, value: minimalSafeSnapshot(event) };
    }

    return { truncated, value: snapshot };
  } catch {
    return { truncated: true, value: minimalSafeSnapshot(event) };
  }
};

export const serializeWideEventSnapshot = (event: WideEventSnapshot): string => {
  const sanitized = sanitizeWideEventSnapshot(event).value;
  try {
    return JSON.stringify(sanitized);
  } catch {
    return JSON.stringify(minimalSafeSnapshot(event));
  }
};
