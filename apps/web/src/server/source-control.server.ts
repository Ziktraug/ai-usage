import type { WideEventResourceService, WideEventSink } from '@ai-usage/effect-runtime';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import { readAiUsageConfig, setSourcePolicyOverride } from '@ai-usage/local-collectors/machine-config';
import type { CollectionSourceId } from '@ai-usage/report-core/source-control';
import {
  createScheduledSourceRegistry,
  type ScheduledSource,
  type SourceAdapterOptions,
} from '@ai-usage/report-data/source-adapters';
import {
  createSourceControl,
  type ReportPublicationPort,
  SourceControl,
  type SourceControlOptions,
  type SourceControlService,
  type SourcePolicyStore,
} from '@ai-usage/report-data/source-control';
import { type Duration, Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect';
import { tryGetWebProcessRuntime, type WebProcessRuntime } from './web-process-runtime.server';

export interface WebProcessRuntimeOptions {
  readonly adapterOptions?: SourceAdapterOptions;
  readonly beforeInitialCollection?: Effect.Effect<void>;
  readonly initialPublicationOrder?: SourceControlOptions['initialPublicationOrder'];
  readonly instanceId?: string;
  readonly policyStore?: SourcePolicyStore;
  readonly publication: ReportPublicationPort;
  readonly sources?: ReadonlyMap<CollectionSourceId, ScheduledSource>;
  readonly sourceTimeout?: Duration.DurationInput;
  readonly storage?: LocalHistoryStorageService;
  readonly wideEventSinkLayer: Layer.Layer<WideEventResourceService | WideEventSink>;
  readonly workerCount?: number;
}

const createLivePolicyStore = (storage: LocalHistoryStorageService): SourcePolicyStore => ({
  load: readAiUsageConfig.pipe(
    Effect.map((config) => config.sourcePolicies ?? {}),
    Effect.provideService(LocalHistoryStorage, storage),
  ),
  setEnabled: (sourceId, enabled) =>
    setSourcePolicyOverride(sourceId, enabled).pipe(Effect.asVoid, Effect.provideService(LocalHistoryStorage, storage)),
});

const sourceControlOptionsEffect = (
  options: WebProcessRuntimeOptions,
): Effect.Effect<SourceControlOptions, never, import('effect').Scope.Scope> =>
  Effect.gen(function* () {
    const storage = options.storage ?? createLocalHistoryStorage();
    const sources =
      options.sources ??
      (yield* createScheduledSourceRegistry(options.adapterOptions).pipe(
        Effect.provideService(LocalHistoryStorage, storage),
        Effect.orDie,
      ));
    return {
      ...(options.beforeInitialCollection === undefined
        ? {}
        : { beforeInitialCollection: options.beforeInitialCollection }),
      ...(options.initialPublicationOrder === undefined
        ? {}
        : { initialPublicationOrder: options.initialPublicationOrder }),
      policyStore: options.policyStore ?? createLivePolicyStore(storage),
      publication: options.publication,
      sources,
      ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
      ...(options.sourceTimeout === undefined ? {} : { sourceTimeout: options.sourceTimeout }),
      ...(options.workerCount === undefined ? {} : { workerCount: options.workerCount }),
    };
  });

const sourceControlLayer = (
  options: WebProcessRuntimeOptions,
): Layer.Layer<SourceControl | WideEventResourceService | WideEventSink> => {
  const controlLayer = Layer.scoped(
    SourceControl,
    sourceControlOptionsEffect(options).pipe(Effect.flatMap(createSourceControl)),
  );
  return controlLayer.pipe(Layer.provideMerge(options.wideEventSinkLayer));
};

const withSourceControl = <A, E>(
  operation: (service: SourceControlService) => Effect.Effect<A, E>,
): Effect.Effect<A, E, SourceControl> => SourceControl.pipe(Effect.flatMap(operation));

export const createWebProcessRuntime = (options: WebProcessRuntimeOptions): WebProcessRuntime => {
  const managedRuntime = ManagedRuntime.make(sourceControlLayer(options));
  let disposal: Promise<void> | undefined;

  const run = <A, E>(operation: (service: SourceControlService) => Effect.Effect<A, E>): Promise<A> =>
    managedRuntime.runPromise(withSourceControl(operation));

  return {
    dispose: () => {
      disposal ??= managedRuntime.dispose();
      return disposal;
    },
    effects: {
      runEffect: (effect) => managedRuntime.runPromise(effect),
    },
    sourceControl: {
      detectAll: () => run((service) => service.detectAll),
      getSnapshot: () => run((service) => service.getSnapshot),
      requestPublication: () => run((service) => service.requestPublication),
      runAllEnabled: () => run((service) => service.runAllEnabled),
      runNow: (sourceId) => run((service) => service.runNow(sourceId)),
      setEnabled: (sourceId, enabled) => run((service) => service.setEnabled(sourceId, enabled)),
      start: () => run((service) => service.getSnapshot),
      subscribe: (listener) => {
        const fiber = managedRuntime.runFork(
          withSourceControl((service) =>
            Stream.runForEach(service.changes, (snapshot) => Effect.sync(() => listener(snapshot))),
          ),
        );
        return () => {
          managedRuntime.runFork(Fiber.interruptFork(fiber));
        };
      },
    },
  };
};

export const requestSourceControlPublicationForServer = async (): Promise<boolean> => {
  const runtime = tryGetWebProcessRuntime();
  if (!runtime) {
    return false;
  }
  await runtime.sourceControl.requestPublication();
  return true;
};
