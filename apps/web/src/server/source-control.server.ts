import type { WideEventResourceService, WideEventSink } from '@ai-usage/effect-runtime';
import {
  createLocalHistoryStorage,
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-collectors/local-history';
import { readAiUsageConfig, setSourcePolicyOverride } from '@ai-usage/local-collectors/machine-config';
import type { CollectionSourceId, SourceControlView } from '@ai-usage/report-core/source-control';
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

export interface WebSourceControlRuntime {
  readonly detectAll: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly getSnapshot: () => Promise<SourceControlView>;
  readonly requestPublication: () => Promise<boolean>;
  readonly runAllEnabled: () => Promise<number>;
  readonly runEffect: <A, E>(
    effect: Effect.Effect<A, E, SourceControl | WideEventResourceService | WideEventSink>,
  ) => Promise<A>;
  readonly runNow: (sourceId: CollectionSourceId) => Promise<boolean>;
  readonly setEnabled: (sourceId: CollectionSourceId, enabled: boolean) => Promise<void>;
  readonly start: () => Promise<SourceControlView>;
  readonly subscribe: (listener: (snapshot: SourceControlView) => void) => () => void;
}

export interface WebSourceControlRuntimeOptions {
  readonly adapterOptions?: SourceAdapterOptions;
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
  options: WebSourceControlRuntimeOptions,
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
      policyStore: options.policyStore ?? createLivePolicyStore(storage),
      publication: options.publication,
      sources,
      ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
      ...(options.sourceTimeout === undefined ? {} : { sourceTimeout: options.sourceTimeout }),
      ...(options.workerCount === undefined ? {} : { workerCount: options.workerCount }),
    };
  });

const sourceControlLayer = (
  options: WebSourceControlRuntimeOptions,
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

export const createWebSourceControlRuntime = (options: WebSourceControlRuntimeOptions): WebSourceControlRuntime => {
  const managedRuntime = ManagedRuntime.make(sourceControlLayer(options));
  let disposal: Promise<void> | undefined;

  const run = <A, E>(operation: (service: SourceControlService) => Effect.Effect<A, E>): Promise<A> =>
    managedRuntime.runPromise(withSourceControl(operation));

  return {
    detectAll: () => run((service) => service.detectAll),
    dispose: () => {
      disposal ??= managedRuntime.dispose();
      return disposal;
    },
    getSnapshot: () => run((service) => service.getSnapshot),
    requestPublication: () => run((service) => service.requestPublication),
    runAllEnabled: () => run((service) => service.runAllEnabled),
    runEffect: (effect) => managedRuntime.runPromise(effect),
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
  };
};

const runtimeRegistry = globalThis as typeof globalThis & {
  __aiUsageSourceControlRuntime: WebSourceControlRuntime | undefined;
  __aiUsageSourceControlRuntimeReplacement: Promise<void> | undefined;
  __aiUsageSourceControlRuntimeTeardown: (() => Promise<void>) | undefined;
};

const uninstallRuntime =
  (runtime: WebSourceControlRuntime): (() => void) =>
  () => {
    if (runtimeRegistry.__aiUsageSourceControlRuntime === runtime) {
      runtimeRegistry.__aiUsageSourceControlRuntime = undefined;
      runtimeRegistry.__aiUsageSourceControlRuntimeTeardown = undefined;
    }
  };

const disposeRuntime =
  (runtime: WebSourceControlRuntime): (() => Promise<void>) =>
  () =>
    runtime.dispose();

export const installWebSourceControlRuntime = (runtime: WebSourceControlRuntime): (() => void) => {
  if (runtimeRegistry.__aiUsageSourceControlRuntime !== undefined) {
    throw new Error('A source-control runtime is already installed in this process.');
  }
  runtimeRegistry.__aiUsageSourceControlRuntime = runtime;
  runtimeRegistry.__aiUsageSourceControlRuntimeTeardown = disposeRuntime(runtime);
  return uninstallRuntime(runtime);
};

export const replaceWebSourceControlRuntime = async (
  runtime: WebSourceControlRuntime,
  teardown: () => Promise<void> = disposeRuntime(runtime),
): Promise<() => void> => {
  const previousReplacement = runtimeRegistry.__aiUsageSourceControlRuntimeReplacement ?? Promise.resolve();
  const replacement = previousReplacement.then(async () => {
    const previousRuntime = runtimeRegistry.__aiUsageSourceControlRuntime;
    if (previousRuntime && previousRuntime !== runtime) {
      const previousTeardown = runtimeRegistry.__aiUsageSourceControlRuntimeTeardown ?? disposeRuntime(previousRuntime);
      runtimeRegistry.__aiUsageSourceControlRuntime = undefined;
      runtimeRegistry.__aiUsageSourceControlRuntimeTeardown = undefined;
      await previousTeardown();
    }
    runtimeRegistry.__aiUsageSourceControlRuntime = runtime;
    runtimeRegistry.__aiUsageSourceControlRuntimeTeardown = teardown;
  });
  runtimeRegistry.__aiUsageSourceControlRuntimeReplacement = replacement;
  try {
    await replacement;
  } finally {
    if (runtimeRegistry.__aiUsageSourceControlRuntimeReplacement === replacement) {
      runtimeRegistry.__aiUsageSourceControlRuntimeReplacement = undefined;
    }
  }
  return uninstallRuntime(runtime);
};

export const getWebSourceControlRuntime = (): WebSourceControlRuntime => {
  const runtime = runtimeRegistry.__aiUsageSourceControlRuntime;
  if (!runtime) {
    throw new Error('The source-control runtime has not started.');
  }
  return runtime;
};

export const requestSourceControlPublicationForServer = async (): Promise<boolean> => {
  const runtime = runtimeRegistry.__aiUsageSourceControlRuntime;
  if (!runtime) {
    return false;
  }
  await runtime.requestPublication();
  return true;
};
