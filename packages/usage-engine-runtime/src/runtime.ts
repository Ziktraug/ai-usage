import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  type CollectionSourceId,
  collectionSourceDefinitions,
  parseSourceControlSnapshot,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import {
  parseUsageEngineInstanceId,
  parseUsageEnginePublicationRevision,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommand,
  type UsageEngineCommandCancellationResult,
  type UsageEngineCommandCompletion,
  type UsageEngineCommandName,
  type UsageEngineCommandResult,
  type UsageEngineCursorImportOutput,
  type UsageEngineEvent,
  type UsageEngineInstanceId,
  type UsageEngineMergePreviewOutput,
  type UsageEngineReplicationStatusOutput,
  type UsageEngineStatus,
} from '@ai-usage/usage-engine-control';
import { createRuntimeCommandCoordinator, type RuntimeCommandCoordinator } from './runtime-command-coordinator';
import { createRuntimeCommandExecutor } from './runtime-command-executor';
import { createRuntimeEventHub } from './runtime-event-hub';
import { createRuntimeLifecycle, type RuntimeLifecycle } from './runtime-lifecycle';

export {
  UsageEngineCommandError,
  type UsageEngineCommandErrorCode,
  UsageEngineFatalConsistencyError,
  UsageEngineSoftSourceError,
  type UsageEngineSoftSourceErrorReason,
} from './runtime-errors';

export interface UsageEngineRuntime {
  readonly changes: () => AsyncIterable<UsageEngineEvent>;
  readonly dispose: () => Promise<void>;
  readonly execute: (command: UsageEngineCommand) => Promise<UsageEngineCommandResult>;
  readonly start: () => Promise<void>;
  readonly status: () => Promise<UsageEngineStatus>;
}

export interface UsageEngineRuntimeHost extends UsageEngineRuntime {
  readonly cancelCommand: (commandId: string) => Promise<UsageEngineCommandCancellationResult>;
  readonly disposeRetainingWriterLease: () => Promise<void>;
  readonly executeCommand: (command: UsageEngineCommand, commandId: string) => Promise<UsageEngineCommandResult>;
  readonly waitForCommand: (commandId: string) => Promise<UsageEngineCommandCompletion>;
  readonly waitForIdle: () => Promise<void>;
}

export type UsageEngineRuntimeFactory = () => Promise<UsageEngineRuntime>;

export const defineUsageEngineRuntimeFactory = (factory: UsageEngineRuntimeFactory): UsageEngineRuntimeFactory =>
  factory;

export interface UsageEngineWriterLease {
  readonly release: () => Promise<void>;
}

export interface UsageEngineSourceControlPort {
  readonly changes: (signal: AbortSignal) => AsyncIterable<SourceControlView>;
  readonly detectAll: (signal?: AbortSignal) => Promise<void>;
  readonly dispose: () => Promise<void>;
  /** Resolves only after the requested publication is terminal. */
  readonly publish: (signal?: AbortSignal) => Promise<SourceControlView>;
  /** Redetects only this source, admits or joins one run, and awaits its dependent publication. */
  readonly redetectAndRunSource: (sourceId: CollectionSourceId, signal?: AbortSignal) => Promise<SourceControlView>;
  /** Resolves after every source admitted by this command and its dependent publication are terminal. */
  readonly runAllEnabled: (signal?: AbortSignal) => Promise<void>;
  /** Resolves after this source and its dependent publication are terminal. */
  readonly runSource: (sourceId: CollectionSourceId, signal?: AbortSignal) => Promise<SourceControlView>;
  readonly setSourceEnabled: (sourceId: CollectionSourceId, enabled: boolean, signal?: AbortSignal) => Promise<void>;
  readonly start: () => Promise<SourceControlView>;
  readonly stopAutonomousCollection: () => Promise<void>;
}

type RunSourceCommand = Extract<UsageEngineCommand, { readonly command: 'run-source' }>;
type SetSourceEnabledCommand = Extract<UsageEngineCommand, { readonly command: 'set-source-enabled' }>;
type SetCampaignLabelOverrideCommand = Extract<UsageEngineCommand, { readonly command: 'set-campaign-label-override' }>;
type ReplaceProjectAliasesCommand = Extract<UsageEngineCommand, { readonly command: 'replace-project-aliases' }>;
type ReplaceProjectGroupsCommand = Extract<UsageEngineCommand, { readonly command: 'replace-project-groups' }>;
type ReplaceProjectGroupsByReferenceCommand = Extract<
  UsageEngineCommand,
  { readonly command: 'replace-project-groups-by-reference' }
>;
type ImportCursorCommand = Extract<UsageEngineCommand, { readonly command: 'import-cursor' }>;
type PreviewMergeCommand = Extract<UsageEngineCommand, { readonly command: 'preview-merge' }>;
type ConfirmMergeCommand = Extract<UsageEngineCommand, { readonly command: 'confirm-merge' }>;
type FileInputCommand = ConfirmMergeCommand | ImportCursorCommand | PreviewMergeCommand;

export interface UsageEngineMutationPort {
  readonly confirmMerge: (command: ConfirmMergeCommand, signal?: AbortSignal) => Promise<void>;
  readonly discardFileInput: (command: FileInputCommand) => Promise<void>;
  readonly importCursor: (command: ImportCursorCommand, signal?: AbortSignal) => Promise<UsageEngineCursorImportOutput>;
  readonly previewMerge: (command: PreviewMergeCommand, signal?: AbortSignal) => Promise<UsageEngineMergePreviewOutput>;
  readonly replaceProjectAliases: (command: ReplaceProjectAliasesCommand, signal?: AbortSignal) => Promise<void>;
  readonly replaceProjectGroups: (command: ReplaceProjectGroupsCommand, signal?: AbortSignal) => Promise<void>;
  readonly replaceProjectGroupsByReference: (
    command: ReplaceProjectGroupsByReferenceCommand,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly setCampaignLabelOverride: (command: SetCampaignLabelOverrideCommand, signal?: AbortSignal) => Promise<void>;
  readonly setMachineLabel: (label: string, signal?: AbortSignal) => Promise<UsageMachine>;
}

export interface UsageEngineRuntimeDependencies {
  readonly acquireWriterLease: () => Promise<UsageEngineWriterLease>;
  readonly initializeStore: () => Promise<number>;
  readonly initialSourceControl: SourceControlView;
  readonly instanceId: UsageEngineInstanceId | string;
  readonly mutation: UsageEngineMutationPort;
  readonly now?: () => Date;
  readonly observeCommand?: <Result>(
    command: UsageEngineCommandName,
    operation: () => Promise<Result>,
  ) => Promise<Result>;
  readonly publishInitialRevision: () => Promise<NonNullable<UsageEngineStatus['currentPublication']>>;
  readonly quiesceStore: () => Promise<void>;
  readonly readReplicationStatus?: () => Promise<UsageEngineReplicationStatusOutput>;
  readonly recover: () => Promise<void>;
  readonly sourceControl: Omit<UsageEngineSourceControlPort, 'runSource' | 'setSourceEnabled'> & {
    readonly runSource: (sourceId: RunSourceCommand['sourceId'], signal?: AbortSignal) => Promise<SourceControlView>;
    readonly setSourceEnabled: (
      sourceId: SetSourceEnabledCommand['sourceId'],
      enabled: boolean,
      signal?: AbortSignal,
    ) => Promise<void>;
  };
  readonly validateConfig: () => Promise<void>;
}

type RuntimeReadiness = UsageEngineStatus['readiness'];

const currentPublicationFor = (sourceControl: SourceControlView): UsageEngineStatus['currentPublication'] => {
  const { lastPublishedAt, revision } = sourceControl.publication;
  if (!(lastPublishedAt && revision)) {
    return null;
  }
  return { publishedAt: lastPublishedAt, revision: parseUsageEnginePublicationRevision(revision) };
};

export const createInitialUsageEngineSourceControlView = (
  instanceIdValue: string,
  generatedAt = new Date(),
): SourceControlView => {
  const instanceId = parseUsageEngineInstanceId(instanceIdValue);
  return parseSourceControlSnapshot({
    generatedAt: generatedAt.toISOString(),
    generation: 0,
    instanceId,
    publication: {
      acknowledgedRequestGeneration: 0,
      dirty: false,
      dirtyGeneration: 0,
      lastOutcome: 'not-run',
      pendingDemand: false,
      publishedGeneration: 0,
      queued: false,
      requestedGeneration: 0,
      rtkCompletedGeneration: 0,
      rtkRequiredGeneration: 0,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources: collectionSourceDefinitions.map((definition) => ({
      availability: 'not-detected',
      cadenceMs: definition.cadenceMs,
      id: definition.id,
      label: definition.label,
      lastOutcome: 'not-run',
      lifecycle: 'dormant',
      policy: definition.defaultEnabled ? 'enabled' : 'disabled',
      reason: { code: definition.defaultEnabled ? 'input-missing' : 'policy-disabled' },
      warnings: [],
    })),
  });
};

export const createUsageEngineRuntime = (dependencies: UsageEngineRuntimeDependencies): UsageEngineRuntimeHost => {
  const instanceId = parseUsageEngineInstanceId(dependencies.instanceId);
  const now = dependencies.now ?? (() => new Date());
  let sourceControl = parseSourceControlSnapshot(dependencies.initialSourceControl);
  if (sourceControl.instanceId !== instanceId) {
    throw new Error('Usage engine runtime and source-control instance identities differ.');
  }

  let readiness: RuntimeReadiness = 'starting';
  let currentPublication = currentPublicationFor(sourceControl);
  let degradedReason: UsageEngineStatus['degradedReason'] = null;
  let storeSchemaVersion: number | null = null;
  let statusGeneration = 0;
  let commandCoordinator: RuntimeCommandCoordinator;
  let lifecycle: RuntimeLifecycle;
  const eventHub = createRuntimeEventHub(instanceId);

  const currentStatus = (): UsageEngineStatus =>
    parseUsageEngineStatus({
      currentPublication,
      degradedReason,
      generatedAt: now().toISOString(),
      generation: statusGeneration,
      instanceId,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
      readiness,
      sourceControl,
      storeSchemaVersion,
    });

  const status = async (): Promise<UsageEngineStatus> => currentStatus();

  const publishEvent = eventHub.publish;

  const withCurrentPublication = (snapshotValue: SourceControlView): SourceControlView => {
    const snapshot = parseSourceControlSnapshot(snapshotValue);
    if (!currentPublication || snapshot.publication.revision) {
      return snapshot;
    }
    return parseSourceControlSnapshot({
      ...snapshot,
      publication: {
        ...snapshot.publication,
        lastPublishedAt: currentPublication.publishedAt,
        revision: currentPublication.revision,
      },
    });
  };

  const publishSourceControl = (next: SourceControlView): void => {
    const parsed = withCurrentPublication(next);
    if (parsed.instanceId !== instanceId) {
      throw new Error('Usage engine received a source-control snapshot for another instance.');
    }
    if (parsed.generation <= sourceControl.generation) {
      return;
    }
    const previousRevision = currentPublication?.revision;
    sourceControl = parsed;
    currentPublication = currentPublicationFor(parsed) ?? currentPublication;
    statusGeneration += 1;
    publishEvent({ event: 'source-control', snapshot: parsed });
    const { lastPublishedAt, revision } = parsed.publication;
    if (revision && lastPublishedAt && revision !== previousRevision) {
      publishEvent({
        event: 'report-published',
        publication: {
          instanceId,
          publishedAt: lastPublishedAt,
          revision,
          sourceControlGeneration: parsed.generation,
        },
      });
    }
  };

  const runCommand = createRuntimeCommandExecutor(dependencies, {
    currentPublicationFor,
    sourceControl: () => sourceControl,
    withCurrentPublication,
  });

  const enterFatalConsistencyState = (): void => {
    if (readiness !== 'degraded') {
      readiness = 'degraded';
      degradedReason = {
        code: 'mutation-consistency-unknown',
        message: 'A usage mutation could not be reconciled; restart recovery is required.',
      };
      statusGeneration += 1;
      publishEvent({ event: 'status', status: currentStatus() });
    }
    lifecycle.closeAutonomousSourceAdmission();
  };

  const markSourceControlUnavailable = (signal: AbortSignal): void => {
    if (signal.aborted || readiness !== 'ready') {
      return;
    }
    readiness = 'degraded';
    degradedReason = {
      code: 'source-control-unavailable',
      message: 'Usage source status updates are unavailable.',
    };
    statusGeneration += 1;
    publishEvent({ event: 'status', status: currentStatus() });
    lifecycle.closeAutonomousSourceAdmission();
  };

  const watchSourceChanges = async (signal: AbortSignal): Promise<void> => {
    try {
      for await (const snapshot of dependencies.sourceControl.changes(signal)) {
        if (signal.aborted) {
          break;
        }
        publishSourceControl(snapshot);
      }
      markSourceControlUnavailable(signal);
    } catch {
      markSourceControlUnavailable(signal);
    }
  };

  lifecycle = createRuntimeLifecycle({
    acquireWriterLease: async () => await dependencies.acquireWriterLease(),
    closeEvents: eventHub.close,
    disposeSourceControl: async () => await dependencies.sourceControl.dispose(),
    initializeStore: async () => await dependencies.initializeStore(),
    onBeginShutdown: () => {
      readiness = 'stopping';
      degradedReason = null;
      statusGeneration += 1;
      publishEvent({ event: 'status', status: currentStatus() });
      commandCoordinator.beginShutdown();
    },
    onInitialPublication: (publication) => {
      currentPublication = publication;
      sourceControl = withCurrentPublication(sourceControl);
    },
    onReady: () => {
      readiness = 'ready';
      degradedReason = null;
      statusGeneration += 1;
      publishEvent({ event: 'status', status: currentStatus() });
    },
    onSourceStarted: (snapshot) => {
      const startedSourceControl = withCurrentPublication(snapshot);
      if (startedSourceControl.instanceId !== instanceId) {
        throw new Error('Usage engine source-control startup returned another instance identity.');
      }
      sourceControl = startedSourceControl;
    },
    onStoreInitialized: (schemaVersion) => {
      storeSchemaVersion = schemaVersion;
    },
    publishInitialRevision: async () => await dependencies.publishInitialRevision(),
    quiesceStore: async () => await dependencies.quiesceStore(),
    recover: async () => await dependencies.recover(),
    settleCommands: async () => await commandCoordinator.settle(),
    startSourceControl: async () => await dependencies.sourceControl.start(),
    stopAutonomousCollection: async () => await dependencies.sourceControl.stopAutonomousCollection(),
    validateConfig: async () => await dependencies.validateConfig(),
    watchSourceChanges,
  });

  commandCoordinator = createRuntimeCommandCoordinator({
    canAcceptCommands: () => readiness === 'ready',
    discardFileInput: async (command) => await dependencies.mutation.discardFileInput(command),
    instanceId,
    lifecycleSignal: lifecycle.signal,
    now,
    onCompletion: (completion) => publishEvent({ completion, event: 'command-completed' }),
    onFatalConsistency: enterFatalConsistencyState,
    runCommand,
  });

  return {
    cancelCommand: commandCoordinator.cancelCommand,
    changes: eventHub.changes,
    dispose: lifecycle.dispose,
    disposeRetainingWriterLease: lifecycle.disposeRetainingWriterLease,
    execute: commandCoordinator.execute,
    executeCommand: commandCoordinator.executeCommand,
    start: lifecycle.start,
    status,
    waitForCommand: commandCoordinator.waitForCommand,
    waitForIdle: commandCoordinator.waitForIdle,
  };
};
