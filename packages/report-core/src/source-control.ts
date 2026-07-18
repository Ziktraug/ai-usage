import { MAX_PORTABLE_USAGE_ROWS } from './portable-usage';

export const collectionSourceIds = [
  'claude.sessions',
  'codex.sessions',
  'opencode.sessions',
  'cursor.sessions',
  'codex.usage-limits',
  'rtk.savings',
  'cursor.commit-attribution',
] as const;

export type CollectionSourceId = (typeof collectionSourceIds)[number];

export type CollectionSourceGroup = 'sessions' | 'provider-usage' | 'enrichments';

export type CollectionSourceKind = 'producer' | 'enricher' | 'dataset-producer';

export interface CollectionSourceDefinition {
  readonly cadenceMs: number;
  readonly defaultEnabled: boolean;
  readonly group: CollectionSourceGroup;
  readonly id: CollectionSourceId;
  readonly kind: CollectionSourceKind;
  readonly label: string;
}

const oneMinuteMs = 60_000;
const fiveMinutesMs = 5 * oneMinuteMs;

export const collectionSourceDefinitions = [
  {
    cadenceMs: oneMinuteMs,
    defaultEnabled: true,
    group: 'sessions',
    id: 'claude.sessions',
    kind: 'producer',
    label: 'Claude sessions',
  },
  {
    cadenceMs: oneMinuteMs,
    defaultEnabled: true,
    group: 'sessions',
    id: 'codex.sessions',
    kind: 'producer',
    label: 'Codex sessions',
  },
  {
    cadenceMs: oneMinuteMs,
    defaultEnabled: true,
    group: 'sessions',
    id: 'opencode.sessions',
    kind: 'producer',
    label: 'OpenCode sessions',
  },
  {
    cadenceMs: oneMinuteMs,
    defaultEnabled: true,
    group: 'sessions',
    id: 'cursor.sessions',
    kind: 'producer',
    label: 'Cursor sessions',
  },
  {
    cadenceMs: fiveMinutesMs,
    defaultEnabled: true,
    group: 'provider-usage',
    id: 'codex.usage-limits',
    kind: 'producer',
    label: 'Codex usage limits',
  },
  {
    cadenceMs: oneMinuteMs,
    defaultEnabled: true,
    group: 'enrichments',
    id: 'rtk.savings',
    kind: 'enricher',
    label: 'RTK savings',
  },
  {
    cadenceMs: oneMinuteMs,
    defaultEnabled: true,
    group: 'enrichments',
    id: 'cursor.commit-attribution',
    kind: 'dataset-producer',
    label: 'Cursor commit attribution',
  },
] as const satisfies readonly CollectionSourceDefinition[];

const collectionSourceIdSet = new Set<string>(collectionSourceIds);
const collectionSourceDefinitionById = new Map(
  collectionSourceDefinitions.map((definition) => [definition.id, definition] as const),
);

export const isCollectionSourceId = (value: unknown): value is CollectionSourceId =>
  typeof value === 'string' && collectionSourceIdSet.has(value);

export const getCollectionSourceDefinition = (id: CollectionSourceId): CollectionSourceDefinition => {
  const definition = collectionSourceDefinitionById.get(id);
  if (!definition) {
    throw new Error(`Unknown collection source: ${id}`);
  }
  return definition;
};

export interface SourcePolicyOverride {
  readonly enabled: boolean;
}

export type SourcePolicyOverrides = Partial<Record<CollectionSourceId, SourcePolicyOverride>>;

const isSourcePolicyOverride = (value: unknown): value is SourcePolicyOverride => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.enabled === 'boolean';
};

export const isSourcePolicyOverrides = (value: unknown): value is SourcePolicyOverrides => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([sourceId, policy]) => isCollectionSourceId(sourceId) && isSourcePolicyOverride(policy),
  );
};

export const resolveSourceEnabled = (id: CollectionSourceId, overrides?: SourcePolicyOverrides): boolean =>
  overrides?.[id]?.enabled ?? getCollectionSourceDefinition(id).defaultEnabled;

export const updateSourcePolicyOverrides = (
  overrides: SourcePolicyOverrides | undefined,
  id: CollectionSourceId,
  enabled: boolean | undefined,
): SourcePolicyOverrides | undefined => {
  const next = { ...overrides };
  const defaultEnabled = getCollectionSourceDefinition(id).defaultEnabled;
  if (enabled === undefined || enabled === defaultEnabled) {
    delete next[id];
  } else {
    next[id] = { enabled };
  }
  return Object.keys(next).length === 0 ? undefined : next;
};

export type SourceControlCommand =
  | {
      readonly command: 'set-enabled';
      readonly enabled: boolean;
      readonly sourceId: CollectionSourceId;
    }
  | {
      readonly command: 'run-now';
      readonly sourceId: CollectionSourceId;
    }
  | { readonly command: 'run-all' }
  | { readonly command: 'detect-all' };

const isCommandRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const commandHasExactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

export const parseSourceControlCommand = (value: unknown): SourceControlCommand => {
  if (!isCommandRecord(value) || typeof value.command !== 'string') {
    throw new Error('Source control command must be an object.');
  }
  if (value.command === 'run-all' || value.command === 'detect-all') {
    if (!commandHasExactKeys(value, ['command'])) {
      throw new Error('Source control command contains unknown fields.');
    }
    return { command: value.command };
  }
  if (value.command === 'run-now') {
    if (!(commandHasExactKeys(value, ['command', 'sourceId']) && isCollectionSourceId(value.sourceId))) {
      throw new Error('Run-now requires one known source ID.');
    }
    return { command: value.command, sourceId: value.sourceId };
  }
  if (value.command === 'set-enabled') {
    if (
      !(commandHasExactKeys(value, ['command', 'enabled', 'sourceId']) && isCollectionSourceId(value.sourceId)) ||
      typeof value.enabled !== 'boolean'
    ) {
      throw new Error('Set-enabled requires one known source ID and a boolean policy.');
    }
    return {
      command: value.command,
      enabled: value.enabled,
      sourceId: value.sourceId,
    };
  }
  throw new Error('Unknown source control command.');
};

export type SourcePolicyState = 'enabled' | 'disabled';
export type SourceAvailability = 'detected' | 'not-detected' | 'unsupported' | 'misconfigured';
export type SourceLifecycle = 'dormant' | 'scheduled' | 'queued' | 'running' | 'pausing';
export type SourceLastOutcome = 'not-run' | 'success' | 'warning' | 'failed' | 'skipped' | 'timed-out';

export type SourceReasonCode =
  | 'none'
  | 'input-missing'
  | 'input-unreadable'
  | 'unsupported-platform'
  | 'misconfigured'
  | 'policy-disabled'
  | 'stale-policy'
  | 'already-pending'
  | 'run-unavailable'
  | 'run-failed'
  | 'timed-out'
  | 'shutting-down'
  | 'partial-results';

export interface SourceReason {
  readonly code: SourceReasonCode;
  readonly message?: string;
}

export type SourceProgressPhase = 'discovering' | 'reading' | 'normalizing' | 'importing';

export interface SourceProgress {
  readonly completed?: number;
  readonly message?: string;
  readonly phase: SourceProgressPhase;
  readonly total?: number;
}

export interface SourceWarning {
  readonly code: string;
  readonly message?: string;
}

export interface SourceDetectionResult {
  readonly availability: SourceAvailability;
  readonly reason: SourceReason;
}

export interface SourceRunResult {
  readonly changed: boolean;
  readonly inputCount: number;
  readonly outputCount: number;
  readonly unavailable?: SourceReason;
  readonly warnings: readonly SourceWarning[];
}

export interface SourceControlEntryView {
  readonly availability: SourceAvailability;
  readonly cadenceMs: number;
  readonly durationMs?: number;
  readonly id: CollectionSourceId;
  readonly inputCount?: number;
  readonly label: string;
  readonly lastFinishedAt?: string;
  readonly lastOutcome: SourceLastOutcome;
  readonly lastStartedAt?: string;
  readonly lastSuccessAt?: string;
  readonly lifecycle: SourceLifecycle;
  readonly nextDueAt?: string;
  readonly outputCount?: number;
  readonly policy: SourcePolicyState;
  readonly progress?: SourceProgress;
  readonly queueDelayMs?: number;
  readonly reason: SourceReason;
  readonly warnings: readonly SourceWarning[];
}

export interface SourcePublicationView {
  readonly acknowledgedRequestGeneration: number;
  readonly dirty: boolean;
  readonly dirtyGeneration: number;
  readonly lastDurationMs?: number;
  readonly lastOutcome: 'not-run' | 'success' | 'failed';
  readonly lastPublishedAt?: string;
  readonly pendingDemand: boolean;
  readonly publishedGeneration: number;
  readonly queued: boolean;
  readonly requestedGeneration: number;
  readonly revision?: string;
  readonly rtkCompletedGeneration: number;
  readonly rtkRequiredGeneration: number;
  readonly running: boolean;
}

export interface SourceControlView {
  readonly generatedAt: string;
  readonly generation: number;
  readonly instanceId: string;
  readonly publication: SourcePublicationView;
  readonly queueDepth: number;
  readonly runningCount: number;
  readonly sources: readonly SourceControlEntryView[];
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const QUEUE_SLOTS_PER_SOURCE = 3;
const QUEUE_CONTROL_SLOTS = 3;
const MAX_QUEUE_DEPTH = collectionSourceDefinitions.length * QUEUE_SLOTS_PER_SOURCE + QUEUE_CONTROL_SLOTS;
const MAX_CONCURRENT_SOURCES = 8;

export const sourceControlBounds = {
  maxCadenceMs: Math.max(...collectionSourceDefinitions.map(({ cadenceMs }) => cadenceMs)),
  maxCount: MAX_PORTABLE_USAGE_ROWS,
  maxDurationMs: MILLISECONDS_PER_DAY,
  maxEventBytes: 4096,
  maxGeneration: Number.MAX_SAFE_INTEGER,
  maxMessageLength: 240,
  maxQueueDelayMs: MAX_QUEUE_DEPTH * MILLISECONDS_PER_DAY,
  maxQueueDepth: MAX_QUEUE_DEPTH,
  maxRunningCount: MAX_CONCURRENT_SOURCES,
  maxSnapshotBytes: 64 * 1024,
  maxWarningsPerSource: 8,
  minCadenceMs: Math.min(...collectionSourceDefinitions.map(({ cadenceMs }) => cadenceMs)),
} as const;

export interface ReportPublishedEvent {
  readonly instanceId: string;
  readonly publishedAt: string;
  readonly revision: string;
  readonly sourceControlGeneration: number;
}

export type SourceControlCommandResponse =
  | {
      readonly accepted: boolean | number;
      readonly ok: true;
      readonly snapshot: SourceControlView;
    }
  | {
      readonly error: {
        readonly message: string;
        readonly reason: string;
        readonly tag: 'SourceControlCommandError';
      };
      readonly ok: false;
    };

export class SourceControlParseError extends Error {
  override readonly name = 'SourceControlParseError';
}

const sourcePolicyStates = new Set<SourcePolicyState>(['enabled', 'disabled']);
const sourceAvailabilities = new Set<SourceAvailability>(['detected', 'not-detected', 'unsupported', 'misconfigured']);
const sourceLifecycles = new Set<SourceLifecycle>(['dormant', 'scheduled', 'queued', 'running', 'pausing']);
const sourceOutcomes = new Set<SourceLastOutcome>(['not-run', 'success', 'warning', 'failed', 'skipped', 'timed-out']);
const sourceReasonCodes = new Set<SourceReasonCode>([
  'none',
  'input-missing',
  'input-unreadable',
  'unsupported-platform',
  'misconfigured',
  'policy-disabled',
  'stale-policy',
  'already-pending',
  'run-unavailable',
  'run-failed',
  'timed-out',
  'shutting-down',
  'partial-results',
]);
const progressPhases = new Set<SourceProgressPhase>(['discovering', 'reading', 'normalizing', 'importing']);
const publicationOutcomes = new Set<SourcePublicationView['lastOutcome']>(['not-run', 'success', 'failed']);
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const revisionPattern = /^[a-zA-Z0-9._-]{1,160}$/;
const boundedCodePattern = /^[a-zA-Z0-9._-]{1,64}$/;

const parseFailure = (message: string): never => {
  throw new SourceControlParseError(message);
};

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyRecordKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
};

const isBoundedString = (value: unknown, maximum: number = sourceControlBounds.maxMessageLength): value is string =>
  typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).byteLength <= maximum;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isBoundedNonNegativeInteger = (value: unknown, maximum: number): value is number =>
  isNonNegativeSafeInteger(value) && value <= maximum;

const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && isoTimestampPattern.test(value) && !Number.isNaN(Date.parse(value));

const isOptionalIsoTimestamp = (value: unknown): value is string | undefined =>
  value === undefined || isIsoTimestamp(value);

const isOptionalBoundedInteger = (value: unknown, maximum: number): value is number | undefined =>
  value === undefined || isBoundedNonNegativeInteger(value, maximum);

const isReason = (value: unknown): value is SourceReason => {
  if (!(isRecordValue(value) && hasOnlyRecordKeys(value, ['code', 'message']))) {
    return false;
  }
  return (
    sourceReasonCodes.has(value.code as SourceReasonCode) &&
    (value.message === undefined || isBoundedString(value.message))
  );
};

const isWarning = (value: unknown): value is SourceWarning =>
  isRecordValue(value) &&
  hasOnlyRecordKeys(value, ['code', 'message']) &&
  typeof value.code === 'string' &&
  boundedCodePattern.test(value.code) &&
  (value.message === undefined || isBoundedString(value.message));

const isProgress = (value: unknown): value is SourceProgress =>
  isRecordValue(value) &&
  hasOnlyRecordKeys(value, ['completed', 'message', 'phase', 'total']) &&
  progressPhases.has(value.phase as SourceProgressPhase) &&
  isOptionalBoundedInteger(value.completed, sourceControlBounds.maxCount) &&
  isOptionalBoundedInteger(value.total, sourceControlBounds.maxCount) &&
  (value.message === undefined || isBoundedString(value.message));

const isSourceEntry = (value: unknown): value is SourceControlEntryView => {
  if (
    !(
      isRecordValue(value) &&
      hasOnlyRecordKeys(value, [
        'availability',
        'cadenceMs',
        'durationMs',
        'id',
        'inputCount',
        'label',
        'lastFinishedAt',
        'lastOutcome',
        'lastStartedAt',
        'lastSuccessAt',
        'lifecycle',
        'nextDueAt',
        'outputCount',
        'policy',
        'progress',
        'queueDelayMs',
        'reason',
        'warnings',
      ])
    )
  ) {
    return false;
  }
  if (!isCollectionSourceId(value.id)) {
    return false;
  }
  const definition = getCollectionSourceDefinition(value.id);
  return (
    value.label === definition.label &&
    sourcePolicyStates.has(value.policy as SourcePolicyState) &&
    sourceAvailabilities.has(value.availability as SourceAvailability) &&
    sourceLifecycles.has(value.lifecycle as SourceLifecycle) &&
    sourceOutcomes.has(value.lastOutcome as SourceLastOutcome) &&
    value.cadenceMs === definition.cadenceMs &&
    isOptionalBoundedInteger(value.durationMs, sourceControlBounds.maxDurationMs) &&
    isOptionalBoundedInteger(value.inputCount, sourceControlBounds.maxCount) &&
    isOptionalBoundedInteger(value.outputCount, sourceControlBounds.maxCount) &&
    isOptionalBoundedInteger(value.queueDelayMs, sourceControlBounds.maxQueueDelayMs) &&
    isOptionalIsoTimestamp(value.lastFinishedAt) &&
    isOptionalIsoTimestamp(value.lastStartedAt) &&
    isOptionalIsoTimestamp(value.lastSuccessAt) &&
    isOptionalIsoTimestamp(value.nextDueAt) &&
    isReason(value.reason) &&
    (value.progress === undefined || isProgress(value.progress)) &&
    Array.isArray(value.warnings) &&
    value.warnings.length <= sourceControlBounds.maxWarningsPerSource &&
    value.warnings.every(isWarning)
  );
};

const isSourceLifecycleConsistent = (source: SourceControlEntryView): boolean => {
  if (source.progress !== undefined && source.lifecycle !== 'running' && source.lifecycle !== 'pausing') {
    return false;
  }
  if (source.lifecycle === 'running') {
    return source.policy === 'enabled';
  }
  if (source.lifecycle === 'pausing') {
    return source.policy === 'disabled';
  }
  if (source.lifecycle === 'scheduled' || source.lifecycle === 'queued') {
    return source.policy === 'enabled' && source.availability === 'detected';
  }
  return true;
};

const isPublication = (value: unknown): value is SourcePublicationView => {
  if (
    !(
      isRecordValue(value) &&
      hasOnlyRecordKeys(value, [
        'acknowledgedRequestGeneration',
        'dirty',
        'dirtyGeneration',
        'lastDurationMs',
        'lastOutcome',
        'lastPublishedAt',
        'pendingDemand',
        'publishedGeneration',
        'queued',
        'requestedGeneration',
        'revision',
        'rtkCompletedGeneration',
        'rtkRequiredGeneration',
        'running',
      ])
    )
  ) {
    return false;
  }
  return (
    typeof value.dirty === 'boolean' &&
    typeof value.pendingDemand === 'boolean' &&
    typeof value.queued === 'boolean' &&
    typeof value.running === 'boolean' &&
    publicationOutcomes.has(value.lastOutcome as SourcePublicationView['lastOutcome']) &&
    isBoundedNonNegativeInteger(value.acknowledgedRequestGeneration, sourceControlBounds.maxGeneration) &&
    isBoundedNonNegativeInteger(value.dirtyGeneration, sourceControlBounds.maxGeneration) &&
    isBoundedNonNegativeInteger(value.publishedGeneration, sourceControlBounds.maxGeneration) &&
    isBoundedNonNegativeInteger(value.requestedGeneration, sourceControlBounds.maxGeneration) &&
    isBoundedNonNegativeInteger(value.rtkCompletedGeneration, sourceControlBounds.maxGeneration) &&
    isBoundedNonNegativeInteger(value.rtkRequiredGeneration, sourceControlBounds.maxGeneration) &&
    isOptionalBoundedInteger(value.lastDurationMs, sourceControlBounds.maxDurationMs) &&
    isOptionalIsoTimestamp(value.lastPublishedAt) &&
    (value.revision === undefined || (typeof value.revision === 'string' && revisionPattern.test(value.revision))) &&
    value.acknowledgedRequestGeneration <= value.requestedGeneration &&
    value.publishedGeneration <= value.dirtyGeneration &&
    value.rtkCompletedGeneration <= value.rtkRequiredGeneration &&
    value.rtkRequiredGeneration <= value.dirtyGeneration &&
    !(value.queued && value.running) &&
    value.dirty === value.dirtyGeneration > value.publishedGeneration &&
    value.pendingDemand ===
      (value.requestedGeneration > value.acknowledgedRequestGeneration ||
        value.dirtyGeneration > value.publishedGeneration)
  );
};

const assertSerializedBound = (value: unknown, maximumBytes: number, label: string): void => {
  let serialized = '';
  try {
    serialized = JSON.stringify(value);
  } catch {
    parseFailure(`${label} is not serializable.`);
  }
  if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    parseFailure(`${label} exceeds its size limit.`);
  }
};

export const parseSourceControlSnapshot = (value: unknown): SourceControlView => {
  assertSerializedBound(value, sourceControlBounds.maxSnapshotBytes, 'Source control snapshot');
  if (
    !(
      isRecordValue(value) &&
      hasOnlyRecordKeys(value, [
        'generatedAt',
        'generation',
        'instanceId',
        'publication',
        'queueDepth',
        'runningCount',
        'sources',
      ]) &&
      isIsoTimestamp(value.generatedAt) &&
      isBoundedNonNegativeInteger(value.generation, sourceControlBounds.maxGeneration) &&
      isBoundedString(value.instanceId, 160) &&
      isBoundedNonNegativeInteger(value.queueDepth, sourceControlBounds.maxQueueDepth) &&
      isBoundedNonNegativeInteger(value.runningCount, sourceControlBounds.maxRunningCount) &&
      isPublication(value.publication) &&
      Array.isArray(value.sources)
    )
  ) {
    return parseFailure('Source control snapshot is invalid.');
  }
  const sources: SourceControlEntryView[] = [];
  for (const source of value.sources) {
    if (!isSourceEntry(source)) {
      return parseFailure('Source control snapshot is invalid.');
    }
    sources.push({
      availability: source.availability,
      cadenceMs: source.cadenceMs,
      id: source.id,
      label: source.label,
      lastOutcome: source.lastOutcome,
      lifecycle: source.lifecycle,
      policy: source.policy,
      reason: { ...source.reason },
      warnings: source.warnings.map((warning) => ({ ...warning })),
      ...(source.durationMs === undefined ? {} : { durationMs: source.durationMs }),
      ...(source.inputCount === undefined ? {} : { inputCount: source.inputCount }),
      ...(source.lastFinishedAt === undefined ? {} : { lastFinishedAt: source.lastFinishedAt }),
      ...(source.lastStartedAt === undefined ? {} : { lastStartedAt: source.lastStartedAt }),
      ...(source.lastSuccessAt === undefined ? {} : { lastSuccessAt: source.lastSuccessAt }),
      ...(source.nextDueAt === undefined ? {} : { nextDueAt: source.nextDueAt }),
      ...(source.outputCount === undefined ? {} : { outputCount: source.outputCount }),
      ...(source.progress === undefined ? {} : { progress: { ...source.progress } }),
      ...(source.queueDelayMs === undefined ? {} : { queueDelayMs: source.queueDelayMs }),
    });
  }
  const sourceIds = new Set(sources.map(({ id }) => id));
  const runningCount = sources.filter(({ lifecycle }) => lifecycle === 'running' || lifecycle === 'pausing').length;
  const visiblyQueuedCount = sources.filter(({ lifecycle }) => lifecycle === 'queued').length;
  const completeCatalogue =
    sources.length === collectionSourceDefinitions.length &&
    sourceIds.size === collectionSourceDefinitions.length &&
    collectionSourceIds.every((sourceId) => sourceIds.has(sourceId));
  const operationallyConsistent =
    completeCatalogue &&
    sources.every(isSourceLifecycleConsistent) &&
    value.runningCount === runningCount &&
    runningCount + (value.publication.running ? 1 : 0) <= sourceControlBounds.maxRunningCount &&
    value.queueDepth >= visiblyQueuedCount + (value.publication.queued ? 1 : 0);
  if (!operationallyConsistent) {
    return parseFailure('Source control snapshot is invalid.');
  }
  const publication: SourcePublicationView = {
    acknowledgedRequestGeneration: value.publication.acknowledgedRequestGeneration,
    dirty: value.publication.dirty,
    dirtyGeneration: value.publication.dirtyGeneration,
    lastOutcome: value.publication.lastOutcome,
    pendingDemand: value.publication.pendingDemand,
    publishedGeneration: value.publication.publishedGeneration,
    queued: value.publication.queued,
    requestedGeneration: value.publication.requestedGeneration,
    rtkCompletedGeneration: value.publication.rtkCompletedGeneration,
    rtkRequiredGeneration: value.publication.rtkRequiredGeneration,
    running: value.publication.running,
    ...(value.publication.lastDurationMs === undefined ? {} : { lastDurationMs: value.publication.lastDurationMs }),
    ...(value.publication.lastPublishedAt === undefined ? {} : { lastPublishedAt: value.publication.lastPublishedAt }),
    ...(value.publication.revision === undefined ? {} : { revision: value.publication.revision }),
  };
  return {
    generatedAt: value.generatedAt,
    generation: value.generation,
    instanceId: value.instanceId,
    publication,
    queueDepth: value.queueDepth,
    runningCount: value.runningCount,
    sources,
  };
};

export const chooseNewestSourceControlSnapshot = (
  current: SourceControlView | null | undefined,
  candidate: SourceControlView,
): SourceControlView => {
  if (!current || current.instanceId !== candidate.instanceId || candidate.generation >= current.generation) {
    return candidate;
  }
  return current;
};

export const parseSourceControlCommandResponse = (value: unknown): SourceControlCommandResponse => {
  assertSerializedBound(
    value,
    sourceControlBounds.maxSnapshotBytes + sourceControlBounds.maxEventBytes,
    'Command response',
  );
  if (!isRecordValue(value) || typeof value.ok !== 'boolean') {
    return parseFailure('Source control command response is invalid.');
  }
  if (value.ok) {
    if (
      !(
        hasOnlyRecordKeys(value, ['accepted', 'ok', 'snapshot']) &&
        (typeof value.accepted === 'boolean' ||
          (isNonNegativeSafeInteger(value.accepted) && value.accepted <= collectionSourceIds.length))
      )
    ) {
      return parseFailure('Source control command response is invalid.');
    }
    return { accepted: value.accepted, ok: true, snapshot: parseSourceControlSnapshot(value.snapshot) };
  }
  const error = value.error;
  if (
    !(
      hasOnlyRecordKeys(value, ['error', 'ok']) &&
      isRecordValue(error) &&
      hasOnlyRecordKeys(error, ['message', 'reason', 'tag'])
    ) ||
    error.tag !== 'SourceControlCommandError' ||
    !isBoundedString(error.message) ||
    !(typeof error.reason === 'string' && boundedCodePattern.test(error.reason))
  ) {
    return parseFailure('Source control command response is invalid.');
  }
  return {
    error: { message: error.message, reason: error.reason, tag: error.tag },
    ok: false,
  };
};

export const parseReportPublishedEvent = (value: unknown): ReportPublishedEvent => {
  assertSerializedBound(value, sourceControlBounds.maxEventBytes, 'Report publication event');
  if (
    !(
      isRecordValue(value) &&
      hasOnlyRecordKeys(value, ['instanceId', 'publishedAt', 'revision', 'sourceControlGeneration']) &&
      isBoundedString(value.instanceId, 160) &&
      isIsoTimestamp(value.publishedAt) &&
      typeof value.revision === 'string' &&
      revisionPattern.test(value.revision) &&
      isNonNegativeSafeInteger(value.sourceControlGeneration)
    )
  ) {
    return parseFailure('Report publication event is invalid.');
  }
  return {
    instanceId: value.instanceId,
    publishedAt: value.publishedAt,
    revision: value.revision,
    sourceControlGeneration: value.sourceControlGeneration,
  };
};
