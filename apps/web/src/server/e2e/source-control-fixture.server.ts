import {
  collectionSourceDefinitions,
  parseSourceControlSnapshot,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import {
  parseUsageEngineCommandResult,
  parseUsageEngineEvent,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommand,
  type UsageEngineCommandResult,
  type UsageEngineReplicationStatusOutput,
  type UsageEngineStatus,
} from '@ai-usage/usage-engine-control';
import type { UsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import {
  createInMemoryUsageEngineControlClient,
  type InMemoryUsageEngineControlAdapter,
} from '@ai-usage/usage-engine-control/testing';
import { USAGE_STORE_SCHEMA_VERSION } from '@ai-usage/usage-store/reader';
import { confirmSyncE2EHandoff, previewSyncE2EHandoff } from './sync-fixture.server';

const INSTANCE_ID = 'e2e-usage-engine';
const REVISION_SUFFIX = '3142669549a734c6e527c1a0522e89d2';
const PAUSE_SETTLE_MS = 250;

let fixture: InMemoryUsageEngineControlAdapter | undefined;
let snapshotGeneration = 1;
let eventSequence = 0;
let publicationGeneration = 1;
let runTimer: ReturnType<typeof setTimeout> | undefined;

const initialSnapshot = (): SourceControlView =>
  parseSourceControlSnapshot({
    generatedAt: new Date().toISOString(),
    generation: snapshotGeneration,
    instanceId: INSTANCE_ID,
    publication: {
      acknowledgedRequestGeneration: publicationGeneration,
      dirty: false,
      dirtyGeneration: publicationGeneration,
      lastOutcome: 'success',
      lastPublishedAt: new Date().toISOString(),
      pendingDemand: false,
      publishedGeneration: publicationGeneration,
      queued: false,
      requestedGeneration: publicationGeneration,
      revision: `e2e-revision-${publicationGeneration}-${REVISION_SUFFIX}`,
      rtkCompletedGeneration: publicationGeneration,
      rtkRequiredGeneration: publicationGeneration,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources: collectionSourceDefinitions.map((definition) => ({
      availability: 'detected',
      cadenceMs: definition.cadenceMs,
      id: definition.id,
      label: definition.label,
      lastOutcome: 'success',
      lifecycle: 'scheduled',
      nextDueAt: new Date(Date.now() + definition.cadenceMs).toISOString(),
      policy: 'enabled',
      reason: { code: 'none' },
      warnings: [],
    })),
  });

let currentSnapshot = initialSnapshot();

const statusFor = (sourceControl: SourceControlView): UsageEngineStatus =>
  parseUsageEngineStatus({
    currentPublication: {
      publishedAt: sourceControl.publication.lastPublishedAt,
      revision: sourceControl.publication.revision,
    },
    degradedReason: null,
    generatedAt: new Date().toISOString(),
    generation: sourceControl.generation,
    instanceId: INSTANCE_ID,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    readiness: 'ready',
    sourceControl,
    storeSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
  });

const publishSnapshot = (next: SourceControlView): void => {
  currentSnapshot = parseSourceControlSnapshot(next);
  fixture?.setStatus(statusFor(currentSnapshot));
  eventSequence += 1;
  fixture?.publish(
    parseUsageEngineEvent({
      event: 'source-control',
      eventId: `e2e:${eventSequence}`,
      instanceId: INSTANCE_ID,
      sequence: eventSequence,
      snapshot: currentSnapshot,
    }),
  );
};

const updateSnapshot = (
  update: (snapshot: SourceControlView) => Omit<SourceControlView, 'generatedAt' | 'generation'>,
): void => {
  snapshotGeneration += 1;
  publishSnapshot(
    parseSourceControlSnapshot({
      ...update(currentSnapshot),
      generatedAt: new Date().toISOString(),
      generation: snapshotGeneration,
    }),
  );
};

const replaceSource = (
  sourceId: UsageEngineCommand extends infer Command
    ? Command extends { readonly sourceId: infer SourceId }
      ? SourceId
      : never
    : never,
  update: (source: SourceControlView['sources'][number]) => SourceControlView['sources'][number],
): SourceControlView['sources'] =>
  currentSnapshot.sources.map((source) => (source.id === sourceId ? update(source) : source));

const publishRevision = (): void => {
  publicationGeneration += 1;
  const publishedAt = new Date().toISOString();
  const revision = `e2e-revision-${publicationGeneration}-${REVISION_SUFFIX}`;
  updateSnapshot((snapshot) => ({
    ...snapshot,
    publication: {
      ...snapshot.publication,
      acknowledgedRequestGeneration: publicationGeneration,
      dirty: false,
      dirtyGeneration: publicationGeneration,
      lastOutcome: 'success',
      lastPublishedAt: publishedAt,
      pendingDemand: false,
      publishedGeneration: publicationGeneration,
      queued: false,
      requestedGeneration: publicationGeneration,
      revision,
      rtkCompletedGeneration: publicationGeneration,
      rtkRequiredGeneration: publicationGeneration,
      running: false,
    },
  }));
  eventSequence += 1;
  fixture?.publish(
    parseUsageEngineEvent({
      event: 'report-published',
      eventId: `e2e:${eventSequence}`,
      instanceId: INSTANCE_ID,
      publication: {
        instanceId: INSTANCE_ID,
        publishedAt,
        revision,
        sourceControlGeneration: currentSnapshot.generation,
      },
      sequence: eventSequence,
    }),
  );
};

const finishSourceRun = (sourceId: SourceControlView['sources'][number]['id']): void => {
  runTimer = undefined;
  updateSnapshot((snapshot) => ({
    ...snapshot,
    runningCount: 0,
    sources: replaceSource(sourceId, (source) => {
      const { progress: _progress, ...rest } = source;
      const finishedAt = new Date().toISOString();
      return {
        ...rest,
        durationMs: PAUSE_SETTLE_MS,
        lastFinishedAt: finishedAt,
        lastOutcome: 'success',
        lastSuccessAt: finishedAt,
        lifecycle: source.policy === 'enabled' ? 'scheduled' : 'dormant',
      };
    }),
  }));
  publishRevision();
};

const runSource = (sourceId: SourceControlView['sources'][number]['id']): void => {
  if (runTimer !== undefined) {
    clearTimeout(runTimer);
  }
  updateSnapshot((snapshot) => ({
    ...snapshot,
    runningCount: 1,
    sources: replaceSource(sourceId, (source) => ({
      ...source,
      lastStartedAt: new Date().toISOString(),
      lifecycle: 'running',
      progress: { message: 'Reading isolated fixture history', phase: 'reading' },
    })),
  }));
};

const lifecycleForPolicyChange = (
  running: boolean,
  enabled: boolean,
): SourceControlView['sources'][number]['lifecycle'] => {
  if (running && !enabled) {
    return 'pausing';
  }
  return enabled ? 'scheduled' : 'dormant';
};

const executeFixtureCommand = (command: UsageEngineCommand, commandId: string): UsageEngineCommandResult => {
  let output:
    | { readonly kind: 'none' }
    | ReturnType<typeof previewSyncE2EHandoff>
    | UsageEngineReplicationStatusOutput = {
    kind: 'none',
  };
  if (command.command === 'run-source') {
    runSource(command.sourceId);
  } else if (command.command === 'set-source-enabled') {
    const running = currentSnapshot.sources.find(({ id }) => id === command.sourceId)?.lifecycle === 'running';
    updateSnapshot((snapshot) => ({
      ...snapshot,
      ...(running && !command.enabled ? {} : { runningCount: snapshot.runningCount }),
      sources: replaceSource(command.sourceId, (source) => ({
        ...source,
        lifecycle: lifecycleForPolicyChange(running, command.enabled),
        policy: command.enabled ? 'enabled' : 'disabled',
        reason: command.enabled ? { code: 'none' } : { code: 'policy-disabled' },
      })),
    }));
    if (running && !command.enabled) {
      if (runTimer !== undefined) {
        clearTimeout(runTimer);
      }
      runTimer = setTimeout(() => finishSourceRun(command.sourceId), PAUSE_SETTLE_MS);
    }
  } else if (command.command === 'run-all-enabled') {
    const firstEnabled = currentSnapshot.sources.find(({ policy }) => policy === 'enabled');
    if (firstEnabled) {
      runSource(firstEnabled.id);
      runTimer = setTimeout(() => finishSourceRun(firstEnabled.id), PAUSE_SETTLE_MS);
    }
  } else if (command.command === 'detect-all') {
    updateSnapshot((snapshot) => ({ ...snapshot }));
  } else if (command.command === 'replication-status') {
    output = {
      kind: 'replication-status',
      lastDiagnostic: { code: 'idle', problemCode: null, streamId: 'memory-v1' },
      memory: {
        acknowledged: 2,
        acknowledgedThroughGeneration: 2,
        blocked: 0,
        inFlight: 0,
        lastAcknowledgedAt: '2026-07-16T10:00:00.000Z',
        lastErrorCode: null,
        nextRetryAt: null,
        oldestUnacknowledgedAt: '2026-07-16T10:01:00.000Z',
        pending: 1,
        streamId: 'memory-v1',
      },
      mode: 'connected',
      runtimeState: 'waiting',
      usage: {
        acknowledged: 4,
        acknowledgedThroughGeneration: 4,
        blocked: 0,
        inFlight: 0,
        lastAcknowledgedAt: '2026-07-16T10:00:30.000Z',
        lastErrorCode: null,
        nextRetryAt: null,
        oldestUnacknowledgedAt: null,
        pending: 0,
        streamId: 'usage-v1',
      },
    };
  } else if (command.command === 'preview-merge') {
    output = previewSyncE2EHandoff(command.input);
  } else if (command.command === 'confirm-merge') {
    confirmSyncE2EHandoff({
      confirmationToken: command.confirmationToken,
      documentDigest: command.documentDigest,
      fileInput: command.input,
    });
    publishRevision();
  }
  eventSequence += 1;
  fixture?.publish(
    parseUsageEngineEvent({
      completion: {
        command: command.command,
        commandId,
        completedAt: new Date().toISOString(),
        output,
        state: 'succeeded',
      },
      event: 'command-completed',
      eventId: `e2e:${eventSequence}`,
      instanceId: INSTANCE_ID,
      sequence: eventSequence,
    }),
  );
  return parseUsageEngineCommandResult({
    admission: 'accepted',
    commandId,
    instanceId: INSTANCE_ID,
    ok: true,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
  });
};

const getFixture = (): InMemoryUsageEngineControlAdapter => {
  fixture ??= createInMemoryUsageEngineControlClient({
    execute: executeFixtureCommand,
    status: statusFor(currentSnapshot),
  });
  return fixture;
};

export const getSourceControlE2EClient = (): UsageEngineControlClient => getFixture().client;
