import {
  type CollectionSourceId,
  collectionSourceDefinitions,
  getCollectionSourceDefinition,
  resolveSourceEnabled,
  type SourceAvailability,
  type SourceControlEntryView,
  type SourceControlView,
  type SourceDetectionResult,
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

export interface SourceJob {
  readonly _tag: 'source';
  readonly policyRevision: number;
  readonly queuedAt: number;
  readonly sourceId: CollectionSourceId;
}

export interface PublicationJob {
  readonly _tag: 'publication';
  readonly queuedAt: number;
}

export interface SourceStartDecision {
  readonly rtkTargetGeneration: number;
  readonly run: boolean;
  readonly staleRequeue: boolean;
  readonly startedAt: number;
}

export type PublicationStartDecision =
  | { readonly ready: false }
  | {
      readonly dataTarget: number;
      readonly ready: true;
      readonly requestTarget: number;
      readonly startedAt: number;
    };

export interface SourceFinishDecision {
  readonly changed: boolean;
  readonly detected: boolean;
  readonly enabled: boolean;
  readonly needsPublicationRequest: boolean;
  readonly needsPublicationWake: boolean;
  readonly needsRtk: boolean;
  readonly needsRtkRerun: boolean;
}

export interface StateTransition<Decision> {
  readonly decision: Decision;
  readonly state: InternalControlState;
}

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

export const sanitizeCount = (value: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, sourceControlBounds.maxCount) : 0;

const sanitizeDuration = (value: number, maximum: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;

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

const transition = <Decision>(
  state: InternalControlState,
  next: InternalControlState,
  decision: Decision,
  modifiedAt: number,
): StateTransition<Decision> => {
  if (next === state) {
    return { decision, state };
  }
  return {
    decision,
    state: {
      ...next,
      generatedAt: toIso(modifiedAt),
      generation: state.generation + 1,
    },
  };
};

export const admitSourceJob = (
  state: InternalControlState,
  sourceId: CollectionSourceId,
  sourceExists: boolean,
  queuedAt: number,
): StateTransition<SourceJob | undefined> => {
  const source = state.sources[sourceId];
  if (!(sourceExists && source.enabled) || source.availability !== 'detected' || source.queued || source.running) {
    return transition(state, state, undefined, queuedAt);
  }
  const job: SourceJob = {
    _tag: 'source',
    policyRevision: source.policyRevision,
    queuedAt,
    sourceId,
  };
  const next = withSourceState({ ...state, queueDepth: state.queueDepth + 1 }, sourceId, (current) => {
    const { nextDueAt: _nextDueAt, ...rest } = current;
    return {
      ...rest,
      lifecycle: 'queued',
      queued: true,
      reason: { code: 'none' },
    };
  });
  return transition(state, next, job, queuedAt);
};

export const admitPublicationJob = (
  state: InternalControlState,
  queuedAt: number,
): StateTransition<PublicationJob | undefined> => {
  if (state.publication.queued || state.publication.running) {
    return transition(state, state, undefined, queuedAt);
  }
  return transition(
    state,
    {
      ...state,
      publication: { ...state.publication, queued: true },
      queueDepth: state.queueDepth + 1,
    },
    { _tag: 'publication', queuedAt },
    queuedAt,
  );
};

export const requestPublicationTransition = (
  state: InternalControlState,
  requestedAt: number,
): StateTransition<{ readonly shouldQueue: boolean }> =>
  transition(
    state,
    {
      ...state,
      publication: {
        ...state.publication,
        requestedGeneration: state.publication.requestedGeneration + 1,
      },
    },
    { shouldQueue: !(state.publication.queued || state.publication.running) },
    requestedAt,
  );

export const scheduleSourceTransition = (
  state: InternalControlState,
  sourceId: CollectionSourceId,
  dueAt: number,
  modifiedAt: number,
): StateTransition<boolean> => {
  const source = state.sources[sourceId];
  if (!source.enabled || source.availability !== 'detected' || source.queued || source.running) {
    return transition(state, state, false, modifiedAt);
  }
  return transition(
    state,
    withSourceState(state, sourceId, (entry) => ({
      ...entry,
      lifecycle: 'scheduled',
      nextDueAt: toIso(dueAt),
    })),
    true,
    modifiedAt,
  );
};

export const applyDetectionTransition = (
  state: InternalControlState,
  sourceId: CollectionSourceId,
  detection: SourceDetectionResult,
  modifiedAt: number,
): StateTransition<{ readonly cancelTimer: boolean; readonly shouldQueue: boolean }> => {
  const current = state.sources[sourceId];
  const cancelTimer = detection.availability !== 'detected';
  const lifecycle = lifecycleAfterDetection(current, detection.availability);
  const next = withSourceState(state, sourceId, (entry) => {
    const { nextDueAt: _nextDueAt, ...entryWithoutDueAt } = entry;
    return {
      ...(cancelTimer ? entryWithoutDueAt : entry),
      availability: detection.availability,
      lifecycle,
      reason: entry.enabled ? detection.reason : { code: 'policy-disabled', message: 'Collection is disabled.' },
    };
  });
  return transition(
    state,
    next,
    {
      cancelTimer,
      shouldQueue: current.enabled && detection.availability === 'detected' && !current.queued && !current.running,
    },
    modifiedAt,
  );
};

export const startSourceJobTransition = (
  state: InternalControlState,
  job: SourceJob,
  startedAt: number,
): StateTransition<SourceStartDecision> => {
  const source = state.sources[job.sourceId];
  const valid =
    source.queued &&
    source.enabled &&
    source.availability === 'detected' &&
    source.policyRevision === job.policyRevision;
  const queueDepth = Math.max(0, state.queueDepth - 1);
  if (!valid) {
    const staleRequeue =
      source.enabled && source.availability === 'detected' && source.policyRevision !== job.policyRevision;
    const next = withSourceState({ ...state, queueDepth }, job.sourceId, (entry) => ({
      ...entry,
      lastOutcome: 'skipped',
      lifecycle: lifecycleForIdleSource(entry),
      queued: false,
      reason: entry.enabled
        ? { code: 'stale-policy', message: 'A stale queued job was skipped.' }
        : { code: 'policy-disabled', message: 'Collection is disabled.' },
    }));
    return transition(
      state,
      next,
      { rtkTargetGeneration: state.rtkRequiredGeneration, run: false, staleRequeue, startedAt },
      startedAt,
    );
  }
  const next = withSourceState({ ...state, queueDepth }, job.sourceId, (entry) => {
    const { progress: _progress, ...rest } = entry;
    return {
      ...rest,
      lastStartedAt: toIso(startedAt),
      lifecycle: 'running',
      queueDelayMs: sanitizeDuration(startedAt - job.queuedAt, sourceControlBounds.maxQueueDelayMs),
      queued: false,
      reason: { code: 'none' },
      running: true,
      warnings: [],
    };
  });
  return transition(
    state,
    next,
    { rtkTargetGeneration: state.rtkRequiredGeneration, run: true, staleRequeue: false, startedAt },
    startedAt,
  );
};

export const updateSourceProgressTransition = (
  state: InternalControlState,
  sourceId: CollectionSourceId,
  progress: SourceProgress,
  modifiedAt: number,
): StateTransition<void> => {
  if (!state.sources[sourceId].running) {
    return transition(state, state, undefined, modifiedAt);
  }
  return transition(
    state,
    withSourceState(state, sourceId, (entry) => ({ ...entry, progress: sanitizeProgress(progress) })),
    undefined,
    modifiedAt,
  );
};

export const finishSourceJobTransition = (
  state: InternalControlState,
  job: SourceJob,
  startedAt: number,
  rtkTargetGeneration: number,
  completion: SourceExecutionCompletion,
  finishedAt: number,
): StateTransition<SourceFinishDecision> => {
  const source = state.sources[job.sourceId];
  const result = completion._tag === 'success' ? completion.result : undefined;
  const failed = completion._tag === 'failed';
  const unavailable = result?.unavailable;
  const warnings = result ? sanitizeWarnings(result.warnings) : [];
  const availability = unavailable ? 'not-detected' : source.availability;
  const lastOutcome = outcomeAfterRun(completion, unavailable, warnings.length);
  const changed = result?.changed === true && !unavailable;
  let dirtyGeneration = state.publication.dirtyGeneration;
  let rtkRequiredGeneration = state.rtkRequiredGeneration;
  let rtkCompletedGeneration = state.rtkCompletedGeneration;
  const rtkAvailable = state.sources['rtk.savings'];
  const needsRtk =
    changed && sourceNeedsRtk(job.sourceId) && rtkAvailable.enabled && rtkAvailable.availability === 'detected';
  if (changed) {
    dirtyGeneration++;
    if (needsRtk) {
      rtkRequiredGeneration = dirtyGeneration;
    }
  }
  if (job.sourceId === 'rtk.savings') {
    rtkCompletedGeneration = Math.max(rtkCompletedGeneration, rtkTargetGeneration);
  }
  const releasedRtkDependency =
    job.sourceId === 'rtk.savings' &&
    state.rtkRequiredGeneration > state.rtkCompletedGeneration &&
    rtkCompletedGeneration >= state.rtkRequiredGeneration;
  const { progress: _progress, ...sourceWithoutProgress } = source;
  const nextSource: InternalSourceState = {
    ...sourceWithoutProgress,
    availability,
    durationMs: sanitizeDuration(finishedAt - startedAt, sourceControlBounds.maxDurationMs),
    lastFinishedAt: toIso(finishedAt),
    lastOutcome,
    lifecycle: source.enabled && availability === 'detected' ? 'scheduled' : 'dormant',
    reason: reasonAfterCompletion(completion, unavailable, source.enabled),
    running: false,
    warnings,
    ...(result === undefined
      ? {}
      : { inputCount: sanitizeCount(result.inputCount), outputCount: sanitizeCount(result.outputCount) }),
    ...(failed || unavailable ? {} : { lastSuccessAt: toIso(finishedAt) }),
  };
  const nextState = withSourceState(
    {
      ...state,
      publication: { ...state.publication, dirtyGeneration },
      rtkCompletedGeneration,
      rtkRequiredGeneration,
    },
    job.sourceId,
    () => nextSource,
  );
  return transition(
    state,
    nextState,
    {
      changed,
      detected: availability === 'detected',
      enabled: source.enabled,
      needsPublicationRequest: changed,
      needsPublicationWake: releasedRtkDependency,
      needsRtk,
      needsRtkRerun: job.sourceId === 'rtk.savings' && rtkRequiredGeneration > rtkCompletedGeneration,
    },
    finishedAt,
  );
};

export const startPublicationJobTransition = (
  state: InternalControlState,
  startedAt: number,
): StateTransition<PublicationStartDecision> => {
  const queueDepth = Math.max(0, state.queueDepth - 1);
  const rtk = state.sources['rtk.savings'];
  const waitingForRtk =
    rtk.enabled && rtk.availability === 'detected' && state.rtkRequiredGeneration > state.rtkCompletedGeneration;
  if (waitingForRtk) {
    return transition(
      state,
      { ...state, publication: { ...state.publication, queued: false }, queueDepth },
      { ready: false },
      startedAt,
    );
  }
  return transition(
    state,
    { ...state, publication: { ...state.publication, queued: false, running: true }, queueDepth },
    {
      dataTarget: state.publication.dirtyGeneration,
      ready: true,
      requestTarget: state.publication.requestedGeneration,
      startedAt,
    },
    startedAt,
  );
};

export const finishPublicationJobTransition = (
  state: InternalControlState,
  startedAt: number,
  requestTarget: number,
  dataTarget: number,
  result: { readonly revision?: string } | undefined,
  finishedAt: number,
): StateTransition<boolean> => {
  const publishedGeneration = result
    ? Math.max(state.publication.publishedGeneration, dataTarget)
    : state.publication.publishedGeneration;
  const acknowledgedRequestGeneration = result
    ? Math.max(state.publication.acknowledgedRequestGeneration, requestTarget)
    : state.publication.acknowledgedRequestGeneration;
  const pending =
    state.publication.dirtyGeneration > publishedGeneration ||
    state.publication.requestedGeneration > acknowledgedRequestGeneration;
  const next = {
    ...state,
    publication: {
      ...state.publication,
      acknowledgedRequestGeneration,
      lastDurationMs: sanitizeDuration(finishedAt - startedAt, sourceControlBounds.maxDurationMs),
      lastOutcome: result ? ('success' as const) : ('failed' as const),
      publishedGeneration,
      running: false,
      ...(result
        ? {
            lastPublishedAt: toIso(finishedAt),
            ...(result.revision === undefined ? {} : { revision: result.revision }),
          }
        : {}),
    },
  };
  return transition(state, next, pending, finishedAt);
};

export const setSourcePolicyTransition = (
  state: InternalControlState,
  sourceId: CollectionSourceId,
  enabled: boolean,
  modifiedAt: number,
): StateTransition<{ readonly shouldQueue: boolean }> => {
  const current = state.sources[sourceId];
  if (current.enabled === enabled) {
    return transition(state, state, { shouldQueue: false }, modifiedAt);
  }
  const next = withSourceState(state, sourceId, (entry) => {
    const { nextDueAt: _nextDueAt, ...entryWithoutDueAt } = entry;
    return {
      ...(enabled ? entry : entryWithoutDueAt),
      enabled,
      lifecycle: lifecycleAfterPolicyChange(entry, enabled),
      policyRevision: entry.policyRevision + 1,
      reason: enabled
        ? reasonForAvailability(entry.availability)
        : { code: 'policy-disabled', message: 'Collection is disabled.' },
    };
  });
  return transition(
    state,
    next,
    { shouldQueue: enabled && current.availability === 'detected' && !current.queued && !current.running },
    modifiedAt,
  );
};
