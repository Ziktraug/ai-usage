import {
  type CollectionSourceId,
  collectionSourceDefinitions,
  getCollectionSourceDefinition,
  resolveSourceEnabled,
  type SourceAvailability,
  type SourceControlEntryView,
  type SourceControlView,
  type SourceLastOutcome,
  type SourceLifecycle,
  type SourcePolicyOverrides,
  type SourceProgress,
  type SourceReason,
  type SourceRunResult,
  type SourceWarning,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';

export interface InternalSourceState {
  readonly availability: SourceAvailability;
  readonly durationMs?: number;
  readonly enabled: boolean;
  readonly inputCount?: number;
  readonly lastFinishedAt?: string;
  readonly lastOutcome: SourceLastOutcome;
  readonly lastStartedAt?: string;
  readonly lastSuccessAt?: string;
  readonly lifecycle: SourceLifecycle;
  readonly nextDueAt?: string;
  readonly outputCount?: number;
  readonly policyRevision: number;
  readonly progress?: SourceProgress;
  readonly queueDelayMs?: number;
  readonly queued: boolean;
  readonly reason: SourceReason;
  readonly running: boolean;
  readonly warnings: readonly SourceWarning[];
}

export interface InternalPublicationState {
  readonly acknowledgedRequestGeneration: number;
  readonly dirtyGeneration: number;
  readonly lastDurationMs?: number;
  readonly lastOutcome: 'not-run' | 'success' | 'failed';
  readonly lastPublishedAt?: string;
  readonly publishedGeneration: number;
  readonly queued: boolean;
  readonly requestedGeneration: number;
  readonly revision?: string;
  readonly running: boolean;
}

export interface InternalControlState {
  readonly generatedAt: string;
  readonly generation: number;
  readonly instanceId: string;
  readonly publication: InternalPublicationState;
  readonly queueDepth: number;
  readonly rtkCompletedGeneration: number;
  readonly rtkRequiredGeneration: number;
  readonly sources: Readonly<Record<CollectionSourceId, InternalSourceState>>;
}

export type SourceExecutionCompletion =
  | { readonly _tag: 'failed' }
  | { readonly _tag: 'success'; readonly result: SourceRunResult }
  | { readonly _tag: 'timed-out' };

export const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString();

export const lifecycleForIdleSource = (state: InternalSourceState): SourceLifecycle =>
  state.enabled && state.availability === 'detected' ? 'scheduled' : 'dormant';

export const lifecycleAfterDetection = (
  source: InternalSourceState,
  availability: SourceAvailability,
): SourceLifecycle => {
  if (source.running) {
    return source.enabled ? 'running' : 'pausing';
  }
  if (source.queued) {
    return source.lifecycle;
  }
  return source.enabled && availability === 'detected' ? 'scheduled' : 'dormant';
};

export const outcomeAfterRun = (
  completion: SourceExecutionCompletion,
  unavailable: SourceReason | undefined,
  warningCount: number,
): SourceLastOutcome => {
  if (completion._tag === 'timed-out') {
    return 'timed-out';
  }
  if (completion._tag === 'failed') {
    return 'failed';
  }
  if (unavailable) {
    return 'skipped';
  }
  return warningCount > 0 ? 'warning' : 'success';
};

const reasonAfterRun = (failed: boolean, unavailable: SourceReason | undefined, enabled: boolean): SourceReason => {
  if (failed) {
    return { code: 'run-failed', message: 'The source run failed; previously stored data was preserved.' };
  }
  if (unavailable) {
    return unavailable;
  }
  return enabled ? { code: 'none' } : { code: 'policy-disabled', message: 'Collection is disabled.' };
};

export const reasonAfterCompletion = (
  completion: SourceExecutionCompletion,
  unavailable: SourceReason | undefined,
  enabled: boolean,
): SourceReason => {
  if (completion._tag === 'timed-out') {
    return { code: 'timed-out', message: 'The source run timed out; previously stored data was preserved.' };
  }
  return reasonAfterRun(completion._tag === 'failed', unavailable, enabled);
};

export const lifecycleAfterPolicyChange = (source: InternalSourceState, enabled: boolean): SourceLifecycle => {
  if (source.running) {
    return enabled ? 'running' : 'pausing';
  }
  return enabled && source.availability === 'detected' && !source.queued ? 'scheduled' : 'dormant';
};

export const reasonForAvailability = (availability: SourceAvailability): SourceReason => {
  switch (availability) {
    case 'detected':
      return { code: 'none' };
    case 'misconfigured':
      return { code: 'misconfigured', message: 'The source configuration is invalid.' };
    case 'not-detected':
      return { code: 'input-missing', message: 'No supported local input was found.' };
    case 'unsupported':
      return { code: 'unsupported-platform', message: 'This source is not supported on the current platform.' };
    default:
      return { code: 'input-missing', message: 'Source availability is unknown.' };
  }
};

export const sanitizeCount = (value: number): number => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

export const sanitizeWarnings = (warnings: readonly SourceWarning[]): readonly SourceWarning[] =>
  warnings.slice(0, sourceControlBounds.maxWarningsPerSource).map((warning) => ({
    code: warning.code.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'source-warning',
    ...(warning.message === undefined
      ? {}
      : { message: warning.message.slice(0, sourceControlBounds.maxMessageLength) }),
  }));

export const sanitizeProgress = (progress: SourceProgress): SourceProgress => ({
  phase: progress.phase,
  ...(progress.completed === undefined ? {} : { completed: sanitizeCount(progress.completed) }),
  ...(progress.total === undefined ? {} : { total: sanitizeCount(progress.total) }),
  ...(progress.message === undefined
    ? {}
    : { message: progress.message.slice(0, sourceControlBounds.maxMessageLength) }),
});

const initialSourceState = (enabled: boolean): InternalSourceState => ({
  availability: 'not-detected',
  enabled,
  lastOutcome: 'not-run',
  lifecycle: 'dormant',
  policyRevision: 0,
  queued: false,
  reason: enabled
    ? { code: 'input-missing', message: 'Source detection has not completed.' }
    : { code: 'policy-disabled', message: 'Collection is disabled.' },
  running: false,
  warnings: [],
});

export const initialSourceControlState = (
  instanceId: string,
  sourceIds: readonly CollectionSourceId[],
  policies: SourcePolicyOverrides,
  now: number,
): InternalControlState => {
  const sources = Object.fromEntries(
    collectionSourceDefinitions.map(({ id }) => [
      id,
      initialSourceState(sourceIds.includes(id) && resolveSourceEnabled(id, policies)),
    ]),
  ) as Record<CollectionSourceId, InternalSourceState>;
  return {
    generatedAt: toIso(now),
    generation: 0,
    instanceId,
    publication: {
      acknowledgedRequestGeneration: 0,
      dirtyGeneration: 0,
      lastOutcome: 'not-run',
      publishedGeneration: 0,
      queued: false,
      requestedGeneration: 0,
      running: false,
    },
    queueDepth: 0,
    rtkCompletedGeneration: 0,
    rtkRequiredGeneration: 0,
    sources,
  };
};

const sourceEntryView = (sourceId: CollectionSourceId, state: InternalSourceState): SourceControlEntryView => {
  const definition = getCollectionSourceDefinition(sourceId);
  return {
    availability: state.availability,
    cadenceMs: definition.cadenceMs,
    id: sourceId,
    label: definition.label,
    lastOutcome: state.lastOutcome,
    lifecycle: state.lifecycle,
    policy: state.enabled ? 'enabled' : 'disabled',
    reason: state.reason,
    warnings: state.warnings,
    ...(state.durationMs === undefined ? {} : { durationMs: state.durationMs }),
    ...(state.inputCount === undefined ? {} : { inputCount: state.inputCount }),
    ...(state.lastFinishedAt === undefined ? {} : { lastFinishedAt: state.lastFinishedAt }),
    ...(state.lastStartedAt === undefined ? {} : { lastStartedAt: state.lastStartedAt }),
    ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
    ...(state.nextDueAt === undefined ? {} : { nextDueAt: state.nextDueAt }),
    ...(state.outputCount === undefined ? {} : { outputCount: state.outputCount }),
    ...(state.progress === undefined ? {} : { progress: state.progress }),
    ...(state.queueDelayMs === undefined ? {} : { queueDelayMs: state.queueDelayMs }),
  };
};

export const sourceControlView = (state: InternalControlState): SourceControlView => ({
  generatedAt: state.generatedAt,
  generation: state.generation,
  instanceId: state.instanceId,
  publication: {
    acknowledgedRequestGeneration: state.publication.acknowledgedRequestGeneration,
    dirty: state.publication.dirtyGeneration > state.publication.publishedGeneration,
    dirtyGeneration: state.publication.dirtyGeneration,
    lastOutcome: state.publication.lastOutcome,
    pendingDemand:
      state.publication.requestedGeneration > state.publication.acknowledgedRequestGeneration ||
      state.publication.dirtyGeneration > state.publication.publishedGeneration,
    publishedGeneration: state.publication.publishedGeneration,
    queued: state.publication.queued,
    requestedGeneration: state.publication.requestedGeneration,
    rtkCompletedGeneration: state.rtkCompletedGeneration,
    rtkRequiredGeneration: state.rtkRequiredGeneration,
    running: state.publication.running,
    ...(state.publication.lastDurationMs === undefined ? {} : { lastDurationMs: state.publication.lastDurationMs }),
    ...(state.publication.lastPublishedAt === undefined ? {} : { lastPublishedAt: state.publication.lastPublishedAt }),
    ...(state.publication.revision === undefined ? {} : { revision: state.publication.revision }),
  },
  queueDepth: state.queueDepth,
  runningCount: Object.values(state.sources).filter(({ running }) => running).length,
  sources: collectionSourceDefinitions.map(({ id }) => sourceEntryView(id, state.sources[id])),
});

export const withSourceState = (
  state: InternalControlState,
  sourceId: CollectionSourceId,
  update: (source: InternalSourceState) => InternalSourceState,
): InternalControlState => ({
  ...state,
  sources: { ...state.sources, [sourceId]: update(state.sources[sourceId]) },
});

export const sourceNeedsRtk = (sourceId: CollectionSourceId): boolean =>
  sourceId === 'claude.sessions' ||
  sourceId === 'codex.sessions' ||
  sourceId === 'opencode.sessions' ||
  sourceId === 'cursor.sessions';
