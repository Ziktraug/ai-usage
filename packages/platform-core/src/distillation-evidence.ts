/** Provider-neutral evidence contracts. Native file locators never cross this seam. */
export const DISTILLATION_EVIDENCE_VERSION = 1 as const;
export const DISTILLATION_NORMALIZATION_VERSION = 1 as const;
export const DISTILLATION_PACKET_MAX_BYTES = 256 * 1024;
export const DISTILLATION_MAX_EVENTS = 256;
export const DISTILLATION_EVENT_MAX_BYTES = 16 * 1024;

export interface DistillationSourceVersion {
  bytes: number;
  /** SHA-256 of the complete JSONL prefix read, before redaction. */
  digest: string;
  modifiedAtMs: number;
  totalBytes: number;
}

export interface DistillationReportAnchor {
  revision: string;
  rowId: string;
}

export interface DistillationEvidenceSource {
  harnessKey: 'codex';
  machineId: string;
  nativeSessionId: string;
  projectId: string;
  reportAnchor: DistillationReportAnchor | null;
  version: DistillationSourceVersion;
}

export const distillationEventKinds = ['user', 'assistant', 'tool-call', 'tool-result'] as const;
export type DistillationEventKind = (typeof distillationEventKinds)[number];

export interface DistillationEvidenceEvent {
  callId: string | null;
  id: string;
  kind: DistillationEventKind;
  line: number;
  nativeTurnId: string | null;
  redacted: boolean;
  /** A canonical deriveSessionRounds ID; null means no proven attribution. */
  roundId: string | null;
  text: string;
  timestamp: string | null;
  toolName: string | null;
  truncated: boolean;
}

export const distillationExclusionReasons = [
  'reasoning',
  'instructions',
  'replayed-history',
  'duplicate-representation',
  'unsupported-content',
  'malformed-record',
  'oversized-record',
  'event-budget',
  'text-budget',
  'source-byte-budget',
  'incomplete-record',
  'unattributed-history',
  'recorded-truncation',
] as const;
export type DistillationExclusionReason = (typeof distillationExclusionReasons)[number];

export interface DistillationEvidenceCoverage {
  childDiscovery: 'not-performed';
  /** Known children are explicitly excluded; null means child discovery was not complete. */
  childrenNotAnalyzed: number | null;
  /** Lifecycle of the last native task observed in this snapshot, not Session success. */
  completion: 'completed' | 'interrupted' | 'in-progress' | 'unknown';
  exclusions: { reason: DistillationExclusionReason; count: number }[];
  includedEvents: number;
  lines: number;
  scope: 'session-only';
  status: 'complete' | 'partial';
}

export interface DistillationEvidencePacket {
  coverage: DistillationEvidenceCoverage;
  events: DistillationEvidenceEvent[];
  normalizationVersion: typeof DISTILLATION_NORMALIZATION_VERSION;
  /** SHA-256 of the deterministic, redacted packet without this field. */
  packetDigest: string;
  redactionVersion: number;
  schemaVersion: typeof DISTILLATION_EVIDENCE_VERSION;
  source: DistillationEvidenceSource;
}

export interface DistillationEvidenceRef {
  eventIds: string[];
  packetDigest: string;
  sourceDigest: string;
}

/** Fixed wire order for the runtime SHA-256; independent of object insertion order after validation. */
export const distillationEvidenceDigestInput = (packet: Omit<DistillationEvidencePacket, 'packetDigest'>): string =>
  JSON.stringify({
    schemaVersion: packet.schemaVersion,
    normalizationVersion: packet.normalizationVersion,
    redactionVersion: packet.redactionVersion,
    source: {
      harnessKey: packet.source.harnessKey,
      machineId: packet.source.machineId,
      projectId: packet.source.projectId,
      nativeSessionId: packet.source.nativeSessionId,
      reportAnchor:
        packet.source.reportAnchor === null
          ? null
          : {
              revision: packet.source.reportAnchor.revision,
              rowId: packet.source.reportAnchor.rowId,
            },
      version: {
        digest: packet.source.version.digest,
        bytes: packet.source.version.bytes,
        totalBytes: packet.source.version.totalBytes,
        modifiedAtMs: packet.source.version.modifiedAtMs,
      },
    },
    events: packet.events.map((event) => ({
      id: event.id,
      line: event.line,
      kind: event.kind,
      text: event.text,
      timestamp: event.timestamp,
      nativeTurnId: event.nativeTurnId,
      roundId: event.roundId,
      toolName: event.toolName,
      callId: event.callId,
      truncated: event.truncated,
      redacted: event.redacted,
    })),
    coverage: {
      scope: packet.coverage.scope,
      status: packet.coverage.status,
      lines: packet.coverage.lines,
      includedEvents: packet.coverage.includedEvents,
      exclusions: packet.coverage.exclusions.map((entry) => ({ reason: entry.reason, count: entry.count })),
      childrenNotAnalyzed: packet.coverage.childrenNotAnalyzed,
      completion: packet.coverage.completion,
      childDiscovery: packet.coverage.childDiscovery,
    },
  });

export class DistillationEvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistillationEvidenceValidationError';
  }
}

const digestPattern = /^[a-f0-9]{64}$/;
const record = (value: unknown, name: string, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DistillationEvidenceValidationError(`${name} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) {
    throw new DistillationEvidenceValidationError(`${name} contains an unsupported field`);
  }
  return result;
};
const text = (value: unknown, name: string, maximum = 512): string => {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > maximum) {
    throw new DistillationEvidenceValidationError(`${name} must be bounded non-empty text`);
  }
  return value;
};
const nullableText = (value: unknown, name: string): string | null => (value === null ? null : text(value, name));
const integer = (value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new DistillationEvidenceValidationError(`${name} must be a bounded non-negative integer`);
  }
  return value;
};
const digest = (value: unknown, name: string): string => {
  const result = text(value, name, 64);
  if (!digestPattern.test(result)) {
    throw new DistillationEvidenceValidationError(`${name} must be a SHA-256 digest`);
  }
  return result;
};
const boolean = (value: unknown, name: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new DistillationEvidenceValidationError(`${name} must be a boolean`);
  }
  return value;
};

export const parseDistillationEvidenceEvent = (value: unknown): DistillationEvidenceEvent => {
  const item = record(value, 'Evidence event', [
    'id',
    'line',
    'kind',
    'text',
    'timestamp',
    'nativeTurnId',
    'roundId',
    'toolName',
    'callId',
    'truncated',
    'redacted',
  ]);
  const kind = distillationEventKinds.find((candidate) => candidate === item.kind);
  if (!kind) {
    throw new DistillationEvidenceValidationError('Evidence event kind is unsupported');
  }
  const line = integer(item.line, 'Evidence line');
  if (line === 0) {
    throw new DistillationEvidenceValidationError('Evidence line is one-based');
  }
  const timestamp = nullableText(item.timestamp, 'Evidence timestamp');
  if (timestamp !== null && !Number.isFinite(Date.parse(timestamp))) {
    throw new DistillationEvidenceValidationError('Evidence timestamp is invalid');
  }
  return {
    id: text(item.id, 'Evidence ID'),
    line,
    kind,
    text: text(item.text, 'Evidence text', DISTILLATION_EVENT_MAX_BYTES),
    timestamp,
    nativeTurnId: nullableText(item.nativeTurnId, 'Native turn ID'),
    roundId: nullableText(item.roundId, 'Round ID'),
    toolName: nullableText(item.toolName, 'Tool name'),
    callId: nullableText(item.callId, 'Call ID'),
    truncated: boolean(item.truncated, 'Evidence truncation'),
    redacted: boolean(item.redacted, 'Evidence redaction'),
  };
};

export const parseDistillationEvidenceSource = (value: unknown): DistillationEvidenceSource => {
  const source = record(value, 'Evidence source', [
    'harnessKey',
    'machineId',
    'projectId',
    'nativeSessionId',
    'reportAnchor',
    'version',
  ]);
  if (source.harnessKey !== 'codex') {
    throw new DistillationEvidenceValidationError('Evidence harness is unsupported');
  }
  const version = record(source.version, 'Source version', ['digest', 'bytes', 'totalBytes', 'modifiedAtMs']);
  const bytes = integer(version.bytes, 'Source prefix bytes');
  const totalBytes = integer(version.totalBytes, 'Source bytes');
  if (
    bytes > totalBytes ||
    typeof version.modifiedAtMs !== 'number' ||
    !Number.isFinite(version.modifiedAtMs) ||
    version.modifiedAtMs < 0
  ) {
    throw new DistillationEvidenceValidationError('Source version is invalid');
  }
  const anchor =
    source.reportAnchor === null ? null : record(source.reportAnchor, 'Report anchor', ['revision', 'rowId']);
  return {
    harnessKey: 'codex',
    machineId: text(source.machineId, 'Machine ID'),
    projectId: text(source.projectId, 'Project ID'),
    nativeSessionId: text(source.nativeSessionId, 'Native session ID'),
    reportAnchor:
      anchor === null
        ? null
        : { revision: text(anchor.revision, 'Report revision'), rowId: text(anchor.rowId, 'Report row ID') },
    version: { digest: digest(version.digest, 'Source digest'), bytes, totalBytes, modifiedAtMs: version.modifiedAtMs },
  };
};

export const parseDistillationEvidenceCoverage = (
  value: unknown,
  events?: readonly DistillationEvidenceEvent[],
): DistillationEvidenceCoverage => {
  const item = record(value, 'Evidence coverage', [
    'scope',
    'status',
    'lines',
    'includedEvents',
    'exclusions',
    'childrenNotAnalyzed',
    'childDiscovery',
    'completion',
  ]);
  if (
    item.scope !== 'session-only' ||
    item.childDiscovery !== 'not-performed' ||
    (item.status !== 'complete' && item.status !== 'partial') ||
    !Array.isArray(item.exclusions) ||
    item.exclusions.length > distillationExclusionReasons.length
  ) {
    throw new DistillationEvidenceValidationError('Evidence coverage is invalid');
  }
  const lines = integer(item.lines, 'Evidence lines');
  const includedEvents = integer(item.includedEvents, 'Included events', DISTILLATION_MAX_EVENTS);
  if (events && (includedEvents !== events.length || events.some((event) => event.line > lines))) {
    throw new DistillationEvidenceValidationError('Evidence coverage does not match its events');
  }
  const seen = new Set<string>();
  const completion = (['completed', 'interrupted', 'in-progress', 'unknown'] as const).find(
    (candidate) => candidate === item.completion,
  );
  if (!completion) {
    throw new DistillationEvidenceValidationError('Evidence completion is invalid');
  }
  const exclusions = item.exclusions.map((value) => {
    const exclusion = record(value, 'Evidence exclusion', ['reason', 'count']);
    const reason = distillationExclusionReasons.find((candidate) => candidate === exclusion.reason);
    if (!reason || seen.has(reason)) {
      throw new DistillationEvidenceValidationError('Evidence exclusion is invalid or duplicated');
    }
    seen.add(reason);
    return { reason, count: integer(exclusion.count, 'Excluded events') };
  });
  return {
    scope: 'session-only',
    status: item.status,
    lines,
    includedEvents,
    exclusions,
    childrenNotAnalyzed:
      item.childrenNotAnalyzed === null ? null : integer(item.childrenNotAnalyzed, 'Unanalyzed children'),
    childDiscovery: 'not-performed',
    completion,
  };
};

export const parseDistillationEvidencePacket = (value: unknown): DistillationEvidencePacket => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > DISTILLATION_PACKET_MAX_BYTES) {
    throw new DistillationEvidenceValidationError('Evidence packet exceeds its byte budget');
  }
  const packet = record(value, 'Evidence packet', [
    'schemaVersion',
    'normalizationVersion',
    'redactionVersion',
    'source',
    'packetDigest',
    'events',
    'coverage',
  ]);
  if (
    packet.schemaVersion !== DISTILLATION_EVIDENCE_VERSION ||
    packet.normalizationVersion !== DISTILLATION_NORMALIZATION_VERSION ||
    !Array.isArray(packet.events) ||
    packet.events.length > DISTILLATION_MAX_EVENTS
  ) {
    throw new DistillationEvidenceValidationError('Evidence packet version or events are invalid');
  }
  const events = packet.events.map(parseDistillationEvidenceEvent);
  if (new Set(events.map((event) => event.id)).size !== events.length) {
    throw new DistillationEvidenceValidationError('Evidence event IDs must be unique');
  }
  return {
    schemaVersion: DISTILLATION_EVIDENCE_VERSION,
    normalizationVersion: DISTILLATION_NORMALIZATION_VERSION,
    redactionVersion: integer(packet.redactionVersion, 'Redaction version'),
    source: parseDistillationEvidenceSource(packet.source),
    packetDigest: digest(packet.packetDigest, 'Packet digest'),
    events,
    coverage: parseDistillationEvidenceCoverage(packet.coverage, events),
  };
};

export const parseDistillationEvidenceRef = (value: unknown): DistillationEvidenceRef => {
  const reference = record(value, 'Evidence reference', ['packetDigest', 'sourceDigest', 'eventIds']);
  if (
    !Array.isArray(reference.eventIds) ||
    reference.eventIds.length === 0 ||
    reference.eventIds.length > DISTILLATION_MAX_EVENTS
  ) {
    throw new DistillationEvidenceValidationError('Evidence reference must select bounded event IDs');
  }
  const eventIds = reference.eventIds.map((id) => text(id, 'Evidence event ID'));
  if (new Set(eventIds).size !== eventIds.length) {
    throw new DistillationEvidenceValidationError('Evidence reference event IDs must be unique');
  }
  return {
    packetDigest: digest(reference.packetDigest, 'Packet digest'),
    sourceDigest: digest(reference.sourceDigest, 'Source digest'),
    eventIds,
  };
};
