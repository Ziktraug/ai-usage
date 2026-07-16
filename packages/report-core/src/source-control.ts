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

export type SourcePolicyState = 'enabled' | 'disabled';
export type SourceAvailability = 'detected' | 'not-detected' | 'unsupported' | 'misconfigured';
export type SourceLifecycle = 'dormant' | 'scheduled' | 'queued' | 'running' | 'pausing';
export type SourceLastOutcome = 'not-run' | 'success' | 'warning' | 'failed' | 'skipped';

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
  readonly dirty: boolean;
  readonly lastDurationMs?: number;
  readonly lastPublishedAt?: string;
  readonly revision?: string;
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

export const sourceControlBounds = {
  maxMessageLength: 240,
  maxSnapshotBytes: 64 * 1024,
  maxWarningsPerSource: 8,
} as const;
