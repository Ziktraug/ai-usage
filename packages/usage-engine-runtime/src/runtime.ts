import { randomUUID } from 'node:crypto';
import type { UsageMachine } from '@ai-usage/report-core/snapshot';
import {
  type CollectionSourceId,
  collectionSourceDefinitions,
  parseSourceControlSnapshot,
  type SourceControlEntryView,
  type SourceControlView,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';
import {
  parseUsageEngineCommand,
  parseUsageEngineCommandCancellationResult,
  parseUsageEngineCommandId,
  parseUsageEngineCommandResult,
  parseUsageEngineEvent,
  parseUsageEngineInstanceId,
  parseUsageEnginePublicationRevision,
  parseUsageEngineStatus,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCollectionOutput,
  type UsageEngineCommand,
  type UsageEngineCommandCancellationDisposition,
  type UsageEngineCommandCancellationResult,
  type UsageEngineCommandCompletion,
  type UsageEngineCommandId,
  type UsageEngineCommandName,
  type UsageEngineCommandResult,
  type UsageEngineCursorImportOutput,
  type UsageEngineErrorCode,
  type UsageEngineEvent,
  type UsageEngineInstanceId,
  type UsageEngineMachineOutput,
  type UsageEngineMergePreviewOutput,
  type UsageEnginePublicationOutput,
  type UsageEngineStatus,
  usageEngineReportSourceIdsFor,
} from '@ai-usage/usage-engine-control';

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

export class UsageEngineFatalConsistencyError extends AggregateError {
  override readonly name = 'UsageEngineFatalConsistencyError';
}

export type UsageEngineCommandErrorCode = Extract<
  UsageEngineErrorCode,
  | 'command-rejected'
  | 'merge-invalid-input'
  | 'merge-invalid-json'
  | 'merge-self-merge'
  | 'merge-store-failed'
  | 'preview-stale'
>;

export class UsageEngineCommandError extends Error {
  readonly code: UsageEngineCommandErrorCode;
  override readonly name = 'UsageEngineCommandError';

  constructor(code: UsageEngineCommandErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export type UsageEngineSoftSourceErrorReason = 'disabled' | 'failed' | 'not-admitted' | 'not-detected' | 'timed-out';

export class UsageEngineSoftSourceError extends Error {
  override readonly name = 'UsageEngineSoftSourceError';
  readonly reason: UsageEngineSoftSourceErrorReason;
  readonly snapshot: SourceControlView;
  readonly sourceId: CollectionSourceId;

  constructor(input: {
    readonly reason: UsageEngineSoftSourceErrorReason;
    readonly snapshot: SourceControlView;
    readonly sourceId: CollectionSourceId;
  }) {
    super(`Usage source ${input.sourceId} completed with ${input.reason}.`);
    this.reason = input.reason;
    this.snapshot = input.snapshot;
    this.sourceId = input.sourceId;
  }
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

interface QueuedCommand {
  readonly command: UsageEngineCommand;
  readonly commandId: UsageEngineCommandId;
}

interface ActiveCommand {
  readonly controller: AbortController;
  readonly job: QueuedCommand;
}

interface CommandIdentity {
  completion: UsageEngineCommandCompletion | undefined;
  readonly fileInputFingerprint: string | undefined;
  readonly fingerprint: string;
  readonly waiters: Set<(completion: UsageEngineCommandCompletion) => void>;
}

interface EventSubscriber {
  closed: boolean;
  pending: ((result: IteratorResult<UsageEngineEvent>) => void) | undefined;
  readonly queue: UsageEngineEvent[];
}

type UsageEngineRuntimeEventPayload = UsageEngineEvent extends infer Event
  ? Event extends UsageEngineEvent
    ? Omit<Event, 'eventId' | 'instanceId' | 'sequence'>
    : never
  : never;

const MAX_RUNTIME_EVENT_QUEUE = 64;
const MAX_COMMAND_IDENTITIES = 256;

const commandFingerprint = (command: UsageEngineCommand): string => JSON.stringify(command);

const commandIsSafelyInterruptible = (command: UsageEngineCommand): boolean => {
  switch (command.command) {
    case 'collect-fresh-report':
    case 'collect-fresh-quota':
    case 'detect-all':
    case 'preview-merge':
    case 'run-all-enabled':
    case 'run-source':
      return true;
    case 'confirm-merge':
    case 'import-cursor':
    case 'publish':
    case 'replace-project-aliases':
    case 'replace-project-groups':
    case 'replace-project-groups-by-reference':
    case 'set-machine-label':
    case 'set-campaign-label-override':
    case 'set-source-enabled':
      return false;
    default: {
      const unsupportedCommand: never = command;
      throw new Error(`Unsupported usage engine command: ${JSON.stringify(unsupportedCommand)}`);
    }
  }
};

const commandHasFileInput = (command: UsageEngineCommand): command is FileInputCommand =>
  command.command === 'confirm-merge' || command.command === 'import-cursor' || command.command === 'preview-merge';

const commandFileInputFingerprint = (command: UsageEngineCommand): string | undefined =>
  commandHasFileInput(command) ? JSON.stringify(command.input) : undefined;

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

const failedResult = (
  instanceId: UsageEngineInstanceId,
  commandId: UsageEngineCommandId,
  code: UsageEngineErrorCode,
  message: string,
): UsageEngineCommandResult =>
  parseUsageEngineCommandResult({
    commandId,
    error: { code, message },
    instanceId,
    ok: false,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
  });

const acceptedResult = (
  instanceId: UsageEngineInstanceId,
  commandId: UsageEngineCommandId,
  admission: 'accepted' | 'coalesced',
): UsageEngineCommandResult =>
  parseUsageEngineCommandResult({
    admission,
    commandId,
    instanceId,
    ok: true,
    protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
  });

const commandFailureMessage = 'The usage engine command could not be completed.';

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
  let eventSequence = 0;
  let writerLease: UsageEngineWriterLease | undefined;
  let startPromise: Promise<void> | undefined;
  let disposalPromise: Promise<void> | undefined;
  let sourceChangesTask: Promise<void> | undefined;
  let drainPromise: Promise<void> | undefined;
  let policyDrainPromise: Promise<void> | undefined;
  let sourceAdmissionClosePromise: Promise<void> | undefined;
  let sourceAdmissionCloseFailure: unknown;
  let ownedCleanupPromise: Promise<void> | undefined;
  let activeCommand: ActiveCommand | undefined;
  let activePolicyCommand: ActiveCommand | undefined;
  let releaseWriterLeaseDuringCleanup = true;
  let shutdownBegun = false;
  let sourceStartAttempted = false;
  let storeInitializationAttempted = false;
  const lifecycleAbort = new AbortController();
  const commandQueue: QueuedCommand[] = [];
  const policyCommandQueue: QueuedCommand[] = [];
  const commandIdentities = new Map<string, CommandIdentity>();
  const preCancelledCommandIds = new Set<UsageEngineCommandId>();
  const subscribers = new Set<EventSubscriber>();
  const idleWaiters = new Set<() => void>();
  const pendingFileInputCleanups = new Set<Promise<void>>();

  const scheduleFileInputCleanup = (command: UsageEngineCommand): void => {
    if (!commandHasFileInput(command)) {
      return;
    }
    const cleanup = (async () => {
      try {
        await dependencies.mutation.discardFileInput(command);
      } catch {
        // The live mutation port reports cleanup failures at their bounded boundary.
      }
    })();
    pendingFileInputCleanups.add(cleanup);
    cleanup.finally(() => pendingFileInputCleanups.delete(cleanup));
  };

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

  const closeSubscriber = (subscriber: EventSubscriber): void => {
    if (subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    subscriber.queue.length = 0;
    subscriber.pending?.({ done: true, value: undefined });
    subscriber.pending = undefined;
    subscribers.delete(subscriber);
  };

  const publishEvent = (eventValue: UsageEngineRuntimeEventPayload): void => {
    eventSequence += 1;
    const event = parseUsageEngineEvent({
      ...eventValue,
      eventId: `engine:${eventSequence}`,
      instanceId,
      sequence: eventSequence,
    });
    for (const subscriber of subscribers) {
      if (subscriber.pending) {
        const resolve = subscriber.pending;
        subscriber.pending = undefined;
        resolve({ done: false, value: event });
        continue;
      }
      if (subscriber.queue.length >= MAX_RUNTIME_EVENT_QUEUE) {
        subscriber.queue.shift();
      }
      subscriber.queue.push(event);
    }
  };

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

  const changes = (): AsyncIterable<UsageEngineEvent> => ({
    [Symbol.asyncIterator]: () => {
      const subscriber: EventSubscriber = { closed: false, pending: undefined, queue: [] };
      subscribers.add(subscriber);
      return {
        next: () => {
          const event = subscriber.queue.shift();
          if (event) {
            return Promise.resolve({ done: false as const, value: event });
          }
          if (subscriber.closed) {
            return Promise.resolve({ done: true as const, value: undefined });
          }
          return new Promise<IteratorResult<UsageEngineEvent>>((resolve) => {
            subscriber.pending = resolve;
          });
        },
        return: () => {
          closeSubscriber(subscriber);
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  });

  const runCommandWithoutObservation = async (
    command: UsageEngineCommand,
    signal: AbortSignal,
  ): Promise<
    | UsageEngineCollectionOutput
    | UsageEngineCursorImportOutput
    | UsageEngineMachineOutput
    | UsageEngineMergePreviewOutput
    | UsageEnginePublicationOutput
    | undefined
  > => {
    const runSourceSoftly = async (sourceId: CollectionSourceId): Promise<SourceControlView> => {
      try {
        return withCurrentPublication(await dependencies.sourceControl.runSource(sourceId, signal));
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        if (error instanceof UsageEngineSoftSourceError && error.sourceId === sourceId) {
          return withCurrentPublication(error.snapshot);
        }
        throw error;
      }
    };
    const collectSources = async (sourceIds: readonly CollectionSourceId[]): Promise<UsageEngineCollectionOutput> => {
      const sources: SourceControlEntryView[] = [];
      let finalSnapshot = sourceControl;
      for (const sourceId of sourceIds) {
        const snapshot = await runSourceSoftly(sourceId);
        const source = snapshot.sources.find(({ id }) => id === sourceId);
        if (!source) {
          throw new Error(`Source-control snapshot omitted ${sourceId}.`);
        }
        sources.push(source);
        finalSnapshot = snapshot;
      }
      const publication = currentPublicationFor(finalSnapshot);
      if (!publication) {
        throw new Error('A fresh collection command completed without a durable publication.');
      }
      return { kind: 'collection', publication, sources };
    };
    switch (command.command) {
      case 'detect-all':
        await dependencies.sourceControl.detectAll(signal);
        return;
      case 'collect-fresh-report':
        return await collectSources(usageEngineReportSourceIdsFor(command));
      case 'run-all-enabled':
        await dependencies.sourceControl.runAllEnabled(signal);
        return;
      case 'run-source':
        await dependencies.sourceControl.runSource(command.sourceId, signal);
        return;
      case 'publish': {
        const publication = currentPublicationFor(await dependencies.sourceControl.publish(signal));
        if (!publication) {
          throw new Error('A publication command completed without a durable revision.');
        }
        return { kind: 'publication', publication };
      }
      case 'set-source-enabled':
        await dependencies.sourceControl.setSourceEnabled(command.sourceId, command.enabled, signal);
        return;
      case 'replace-project-groups':
        await dependencies.mutation.replaceProjectGroups(command, signal);
        await dependencies.sourceControl.publish(signal);
        return;
      case 'replace-project-groups-by-reference':
        await dependencies.mutation.replaceProjectGroupsByReference(command, signal);
        await dependencies.sourceControl.publish(signal);
        return;
      case 'replace-project-aliases':
        await dependencies.mutation.replaceProjectAliases(command, signal);
        await dependencies.sourceControl.publish(signal);
        return;
      case 'set-machine-label': {
        const machine = await dependencies.mutation.setMachineLabel(command.label, signal);
        await dependencies.sourceControl.publish(signal);
        return { kind: 'machine', machine };
      }
      case 'set-campaign-label-override':
        await dependencies.mutation.setCampaignLabelOverride(command, signal);
        return;
      case 'collect-fresh-quota':
        return await collectSources(['codex.usage-limits']);
      case 'import-cursor': {
        const output = await dependencies.mutation.importCursor(command, signal);
        try {
          await dependencies.sourceControl.redetectAndRunSource('cursor.sessions', signal);
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
        }
        return output;
      }
      case 'preview-merge':
        return await dependencies.mutation.previewMerge(command, signal);
      case 'confirm-merge': {
        await dependencies.mutation.confirmMerge(command, signal);
        try {
          await dependencies.sourceControl.publish(signal);
        } catch {
          // The durable merge succeeded. Publication demand remains durable and retries independently.
        }
        return;
      }
      default: {
        const unsupportedCommand: never = command;
        throw new Error(`Unsupported usage engine command: ${JSON.stringify(unsupportedCommand)}`);
      }
    }
  };
  const runCommand = async (
    command: UsageEngineCommand,
    signal: AbortSignal,
  ): Promise<
    | UsageEngineCollectionOutput
    | UsageEngineCursorImportOutput
    | UsageEngineMachineOutput
    | UsageEngineMergePreviewOutput
    | UsageEnginePublicationOutput
    | undefined
  > =>
    dependencies.observeCommand
      ? await dependencies.observeCommand(
          command.command,
          async () => await runCommandWithoutObservation(command, signal),
        )
      : await runCommandWithoutObservation(command, signal);

  const completionFor = (
    job: QueuedCommand,
    result:
      | UsageEngineCollectionOutput
      | UsageEngineCursorImportOutput
      | UsageEngineMachineOutput
      | UsageEngineMergePreviewOutput
      | UsageEnginePublicationOutput
      | undefined,
  ): UsageEngineCommandCompletion => {
    const completedAt = now().toISOString();
    if (job.command.command === 'preview-merge') {
      if (result?.kind !== 'merge-preview') {
        throw new Error('A successful merge preview must return its bounded preview output.');
      }
      return {
        command: 'preview-merge',
        commandId: job.commandId,
        completedAt,
        output: result,
        state: 'succeeded',
      };
    }
    if (job.command.command === 'import-cursor') {
      if (result?.kind !== 'cursor-import') {
        throw new Error('A successful Cursor import must return its bounded import output.');
      }
      return {
        command: 'import-cursor',
        commandId: job.commandId,
        completedAt,
        output: result,
        state: 'succeeded',
      };
    }
    if (job.command.command === 'collect-fresh-report' || job.command.command === 'collect-fresh-quota') {
      if (result?.kind !== 'collection') {
        throw new Error('A successful fresh collection must return its bounded collection output.');
      }
      return {
        command: job.command.command,
        commandId: job.commandId,
        completedAt,
        output: result,
        state: 'succeeded',
      };
    }
    if (job.command.command === 'set-machine-label') {
      if (result?.kind !== 'machine') {
        throw new Error('A successful machine label mutation must return its bounded machine output.');
      }
      return {
        command: 'set-machine-label',
        commandId: job.commandId,
        completedAt,
        output: result,
        state: 'succeeded',
      };
    }
    if (job.command.command === 'publish') {
      if (result?.kind !== 'publication') {
        throw new Error('A successful publication command must return its bounded publication output.');
      }
      return {
        command: 'publish',
        commandId: job.commandId,
        completedAt,
        output: result,
        state: 'succeeded',
      };
    }
    return {
      command: job.command.command as Exclude<
        UsageEngineCommandName,
        | 'collect-fresh-quota'
        | 'collect-fresh-report'
        | 'import-cursor'
        | 'preview-merge'
        | 'publish'
        | 'set-machine-label'
      >,
      commandId: job.commandId,
      completedAt,
      output: { kind: 'none' },
      state: 'succeeded',
    };
  };

  const resolveIdle = (): void => {
    if (
      commandQueue.length !== 0 ||
      policyCommandQueue.length !== 0 ||
      drainPromise !== undefined ||
      policyDrainPromise !== undefined
    ) {
      return;
    }
    for (const resolve of idleWaiters) {
      resolve();
    }
    idleWaiters.clear();
  };

  const publishCompletion = (completion: UsageEngineCommandCompletion): void => {
    const identity = commandIdentities.get(completion.commandId);
    if (identity) {
      identity.completion = completion;
      for (const resolve of identity.waiters) {
        resolve(completion);
      }
      identity.waiters.clear();
    }
    publishEvent({ completion, event: 'command-completed' });
  };

  const failedCompletionFor = (
    job: QueuedCommand,
    code: 'aborted' | 'command-failed' | 'command-rejected' | 'engine-busy' | UsageEngineCommandErrorCode,
    message = commandFailureMessage,
  ): UsageEngineCommandCompletion => ({
    command: job.command.command,
    commandId: job.commandId,
    completedAt: now().toISOString(),
    error: { code, message },
    state: 'failed',
  });

  const cancellationResult = (
    commandId: UsageEngineCommandId,
    disposition: UsageEngineCommandCancellationDisposition,
  ): UsageEngineCommandCancellationResult =>
    parseUsageEngineCommandCancellationResult({
      commandId,
      disposition,
      instanceId,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    });

  const removeQueuedCommand = (queue: QueuedCommand[], commandId: UsageEngineCommandId): QueuedCommand | undefined => {
    const index = queue.findIndex((job) => job.commandId === commandId);
    if (index < 0) {
      return;
    }
    return queue.splice(index, 1)[0];
  };

  const rememberPreCancelledCommand = (commandId: UsageEngineCommandId): void => {
    if (preCancelledCommandIds.has(commandId)) {
      return;
    }
    if (preCancelledCommandIds.size >= MAX_COMMAND_IDENTITIES) {
      const oldest = preCancelledCommandIds.values().next().value;
      if (oldest !== undefined) {
        preCancelledCommandIds.delete(oldest);
      }
    }
    preCancelledCommandIds.add(commandId);
  };

  const cancelCommand = (commandIdValue: string): Promise<UsageEngineCommandCancellationResult> => {
    const commandId = parseUsageEngineCommandId(commandIdValue);
    const identity = commandIdentities.get(commandId);
    if (identity?.completion) {
      return Promise.resolve(cancellationResult(commandId, 'already-completed'));
    }
    const queued = removeQueuedCommand(commandQueue, commandId) ?? removeQueuedCommand(policyCommandQueue, commandId);
    if (queued) {
      scheduleFileInputCleanup(queued.command);
      publishCompletion(failedCompletionFor(queued, 'aborted', 'The usage engine command was cancelled.'));
      resolveIdle();
      return Promise.resolve(cancellationResult(commandId, 'cancelled'));
    }
    let active: ActiveCommand | undefined;
    if (activeCommand?.job.commandId === commandId) {
      active = activeCommand;
    } else if (activePolicyCommand?.job.commandId === commandId) {
      active = activePolicyCommand;
    }
    if (active) {
      if (!commandIsSafelyInterruptible(active.job.command)) {
        return Promise.resolve(cancellationResult(commandId, 'finishing'));
      }
      active.controller.abort();
      return Promise.resolve(cancellationResult(commandId, 'cancelling'));
    }
    if (identity) {
      return Promise.resolve(cancellationResult(commandId, 'finishing'));
    }
    rememberPreCancelledCommand(commandId);
    return Promise.resolve(cancellationResult(commandId, 'cancelled'));
  };

  const closeAutonomousSourceAdmission = (): void => {
    if (!(sourceStartAttempted && sourceAdmissionClosePromise === undefined)) {
      return;
    }
    sourceAdmissionClosePromise = dependencies.sourceControl.stopAutonomousCollection().catch((error: unknown) => {
      sourceAdmissionCloseFailure = error;
    });
  };

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
    closeAutonomousSourceAdmission();
  };

  const rejectQueuedCommandsAfterFatalConsistency = (): void => {
    for (const queuedJob of [...commandQueue.splice(0), ...policyCommandQueue.splice(0)]) {
      scheduleFileInputCleanup(queuedJob.command);
      publishCompletion(
        failedCompletionFor(
          queuedJob,
          'engine-busy',
          'The usage engine requires restart recovery before another command can run.',
        ),
      );
    }
  };

  interface CommandDrain {
    readonly abortOnShutdown: boolean;
    readonly active: () => ActiveCommand | undefined;
    readonly drain: () => Promise<void> | undefined;
    readonly queue: QueuedCommand[];
    readonly setActive: (active: ActiveCommand | undefined) => void;
    readonly setDrain: (drain: Promise<void> | undefined) => void;
  }

  const drainCommandQueue = (commandDrain: CommandDrain): void => {
    if (commandDrain.drain() !== undefined) {
      return;
    }
    const drain = (async () => {
      while (commandDrain.queue.length > 0) {
        const job = commandDrain.queue.shift();
        if (!job) {
          continue;
        }
        const controller = new AbortController();
        const currentCommand = { controller, job };
        commandDrain.setActive(currentCommand);
        if (commandDrain.abortOnShutdown && shutdownBegun && commandIsSafelyInterruptible(job.command)) {
          controller.abort();
        }
        try {
          const result = await runCommand(job.command, controller.signal);
          if (controller.signal.aborted) {
            throw new Error('Usage engine command was aborted.');
          }
          publishCompletion(completionFor(job, result));
        } catch (error) {
          const typedCommandError = error instanceof UsageEngineCommandError ? error : undefined;
          publishCompletion(
            failedCompletionFor(
              job,
              controller.signal.aborted || lifecycleAbort.signal.aborted
                ? 'aborted'
                : (typedCommandError?.code ?? 'command-failed'),
              typedCommandError?.message ?? commandFailureMessage,
            ),
          );
          if (error instanceof UsageEngineFatalConsistencyError) {
            enterFatalConsistencyState();
            rejectQueuedCommandsAfterFatalConsistency();
            break;
          }
        } finally {
          if (commandDrain.active() === currentCommand) {
            commandDrain.setActive(undefined);
          }
        }
      }
    })().finally(() => {
      commandDrain.setDrain(undefined);
      resolveIdle();
      if (commandDrain.queue.length > 0) {
        drainCommandQueue(commandDrain);
      }
    });
    commandDrain.setDrain(drain);
  };

  const ordinaryCommandDrain: CommandDrain = {
    abortOnShutdown: true,
    active: () => activeCommand,
    drain: () => drainPromise,
    queue: commandQueue,
    setActive: (active) => {
      activeCommand = active;
    },
    setDrain: (drain) => {
      drainPromise = drain;
    },
  };
  const policyCommandDrain: CommandDrain = {
    abortOnShutdown: false,
    active: () => activePolicyCommand,
    drain: () => policyDrainPromise,
    queue: policyCommandQueue,
    setActive: (active) => {
      activePolicyCommand = active;
    },
    setDrain: (drain) => {
      policyDrainPromise = drain;
    },
  };

  const drainCommands = (): void => drainCommandQueue(ordinaryCommandDrain);
  const drainPolicyCommands = (): void => drainCommandQueue(policyCommandDrain);

  const sourcePolicyMustPreemptActiveCollection = (command: SetSourceEnabledCommand): boolean => {
    if (command.enabled || !activeCommand) {
      return false;
    }
    const active = activeCommand.job.command;
    switch (active.command) {
      case 'collect-fresh-report':
        return usageEngineReportSourceIdsFor(active).includes(command.sourceId);
      case 'run-source':
        return active.sourceId === command.sourceId;
      case 'run-all-enabled':
        return true;
      case 'collect-fresh-quota':
        return command.sourceId === 'codex.usage-limits';
      case 'import-cursor':
        return command.sourceId === 'cursor.sessions';
      default:
        return false;
    }
  };

  const executeCommand = (
    commandValue: UsageEngineCommand,
    commandIdValue: string,
  ): Promise<UsageEngineCommandResult> => {
    try {
      const commandId = parseUsageEngineCommandId(commandIdValue);
      const command = parseUsageEngineCommand(commandValue);
      if (preCancelledCommandIds.has(commandId)) {
        scheduleFileInputCleanup(command);
        return Promise.resolve(
          failedResult(instanceId, commandId, 'aborted', 'The usage engine command was cancelled.'),
        );
      }
      const fingerprint = commandFingerprint(command);
      const existing = commandIdentities.get(commandId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          if (commandFileInputFingerprint(command) !== existing.fileInputFingerprint) {
            scheduleFileInputCleanup(command);
          }
          return Promise.resolve(
            failedResult(
              instanceId,
              commandId,
              'command-rejected',
              'A command ID cannot be reused for another command.',
            ),
          );
        }
        return Promise.resolve(acceptedResult(instanceId, commandId, 'coalesced'));
      }
      if (
        readiness !== 'ready' ||
        commandQueue.length + policyCommandQueue.length >= sourceControlBounds.maxQueueDepth
      ) {
        scheduleFileInputCleanup(command);
        return Promise.resolve(
          failedResult(instanceId, commandId, 'engine-busy', 'The usage engine is not accepting commands.'),
        );
      }
      if (commandIdentities.size >= MAX_COMMAND_IDENTITIES) {
        for (const [oldestCommandId, identity] of commandIdentities) {
          if (identity.completion) {
            commandIdentities.delete(oldestCommandId);
            break;
          }
        }
      }
      if (commandIdentities.size >= MAX_COMMAND_IDENTITIES) {
        scheduleFileInputCleanup(command);
        return Promise.resolve(
          failedResult(instanceId, commandId, 'engine-busy', 'The usage engine command identity cache is full.'),
        );
      }
      commandIdentities.set(commandId, {
        completion: undefined,
        fileInputFingerprint: commandFileInputFingerprint(command),
        fingerprint,
        waiters: new Set(),
      });
      if (command.command === 'set-source-enabled' && sourcePolicyMustPreemptActiveCollection(command)) {
        policyCommandQueue.push({ command, commandId });
        drainPolicyCommands();
      } else {
        commandQueue.push({ command, commandId });
        drainCommands();
      }
      return Promise.resolve(acceptedResult(instanceId, commandId, 'accepted'));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const execute = (command: UsageEngineCommand): Promise<UsageEngineCommandResult> =>
    executeCommand(command, randomUUID());

  const waitForCommand = async (commandIdValue: string): Promise<UsageEngineCommandCompletion> => {
    const commandId = parseUsageEngineCommandId(commandIdValue);
    const identity = commandIdentities.get(commandId);
    if (!identity) {
      throw new Error('The usage engine command identity is not available.');
    }
    if (identity.completion) {
      return identity.completion;
    }
    return await new Promise<UsageEngineCommandCompletion>((resolve) => identity.waiters.add(resolve));
  };

  const waitForIdle = async (): Promise<void> => {
    if (
      commandQueue.length === 0 &&
      policyCommandQueue.length === 0 &&
      drainPromise === undefined &&
      policyDrainPromise === undefined
    ) {
      return;
    }
    await new Promise<void>((resolve) => idleWaiters.add(resolve));
  };

  const watchSourceChanges = async (): Promise<void> => {
    try {
      for await (const snapshot of dependencies.sourceControl.changes(lifecycleAbort.signal)) {
        if (lifecycleAbort.signal.aborted) {
          break;
        }
        publishSourceControl(snapshot);
      }
    } catch {
      if (!lifecycleAbort.signal.aborted) {
        readiness = 'degraded';
        degradedReason = {
          code: 'source-control-unavailable',
          message: 'Usage source status updates are unavailable.',
        };
        statusGeneration += 1;
        publishEvent({ event: 'status', status: currentStatus() });
      }
    }
  };

  const assertStartupActive = (): void => {
    if (shutdownBegun || lifecycleAbort.signal.aborted) {
      throw new Error('Usage engine startup was aborted.');
    }
  };

  const beginShutdown = (): void => {
    if (shutdownBegun) {
      return;
    }
    shutdownBegun = true;
    readiness = 'stopping';
    degradedReason = null;
    statusGeneration += 1;
    publishEvent({ event: 'status', status: currentStatus() });
    for (const job of commandQueue.splice(0)) {
      scheduleFileInputCleanup(job.command);
      publishCompletion(failedCompletionFor(job, 'aborted'));
    }
    for (const job of policyCommandQueue.splice(0)) {
      scheduleFileInputCleanup(job.command);
      publishCompletion(failedCompletionFor(job, 'aborted'));
    }
    if (activeCommand && commandIsSafelyInterruptible(activeCommand.job.command)) {
      activeCommand.controller.abort();
    }
    if (activePolicyCommand && commandIsSafelyInterruptible(activePolicyCommand.job.command)) {
      activePolicyCommand.controller.abort();
    }
    closeAutonomousSourceAdmission();
  };

  const cleanupOwnedResources = (releaseWriterLease: boolean): Promise<void> => {
    if (!releaseWriterLease) {
      releaseWriterLeaseDuringCleanup = false;
    }
    ownedCleanupPromise ??= (async () => {
      const failures: unknown[] = [];
      try {
        await sourceAdmissionClosePromise;
      } catch (error) {
        failures.push(error);
      }
      if (sourceAdmissionCloseFailure !== undefined) {
        failures.push(sourceAdmissionCloseFailure);
      }
      try {
        await drainPromise;
      } catch (error) {
        failures.push(error);
      }
      try {
        await policyDrainPromise;
      } catch (error) {
        failures.push(error);
      }
      await Promise.all([...pendingFileInputCleanups]);
      lifecycleAbort.abort();
      if (sourceStartAttempted) {
        try {
          await dependencies.sourceControl.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await sourceChangesTask;
      } catch (error) {
        failures.push(error);
      }
      if (storeInitializationAttempted) {
        try {
          await dependencies.quiesceStore();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 0 && releaseWriterLeaseDuringCleanup) {
        const lease = writerLease;
        if (lease) {
          try {
            await lease.release();
            writerLease = undefined;
          } catch (error) {
            failures.push(error);
          }
        }
      }
      for (const subscriber of [...subscribers]) {
        closeSubscriber(subscriber);
      }
      resolveIdle();
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'The usage engine could not safely release its writer lease during shutdown.',
        );
      }
    })();
    return ownedCleanupPromise;
  };

  const start = (): Promise<void> => {
    if (startPromise) {
      return startPromise;
    }
    if (lifecycleAbort.signal.aborted) {
      return Promise.reject(new Error('Usage engine startup was aborted.'));
    }
    startPromise = (async () => {
      try {
        writerLease = await dependencies.acquireWriterLease();
        assertStartupActive();
        storeInitializationAttempted = true;
        storeSchemaVersion = await dependencies.initializeStore();
        assertStartupActive();
        await dependencies.validateConfig();
        assertStartupActive();
        await dependencies.recover();
        assertStartupActive();
        currentPublication = await dependencies.publishInitialRevision();
        sourceControl = withCurrentPublication(sourceControl);
        assertStartupActive();
        sourceStartAttempted = true;
        const startedSourceControl = withCurrentPublication(await dependencies.sourceControl.start());
        assertStartupActive();
        if (startedSourceControl.instanceId !== instanceId) {
          throw new Error('Usage engine source-control startup returned another instance identity.');
        }
        sourceControl = startedSourceControl;
        readiness = 'ready';
        degradedReason = null;
        statusGeneration += 1;
        publishEvent({ event: 'status', status: currentStatus() });
        sourceChangesTask = watchSourceChanges();
      } catch (error) {
        beginShutdown();
        try {
          await cleanupOwnedResources(true);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'The usage engine failed to start and could not safely clean up.',
          );
        }
        throw error;
      }
    })();
    return startPromise;
  };

  const disposeRuntime = (releaseWriterLease: boolean): Promise<void> => {
    if (!releaseWriterLease) {
      releaseWriterLeaseDuringCleanup = false;
    }
    if (disposalPromise) {
      return disposalPromise;
    }
    disposalPromise = (async () => {
      beginShutdown();
      try {
        await startPromise;
      } catch {
        // The startup caller owns its failure; disposal must still finish cleanup.
      }
      await cleanupOwnedResources(releaseWriterLease);
    })();
    return disposalPromise;
  };

  const dispose = (): Promise<void> => disposeRuntime(true);
  const disposeRetainingWriterLease = (): Promise<void> => disposeRuntime(false);

  return {
    cancelCommand,
    changes,
    dispose,
    disposeRetainingWriterLease,
    execute,
    executeCommand,
    start,
    status,
    waitForCommand,
    waitForIdle,
  };
};
