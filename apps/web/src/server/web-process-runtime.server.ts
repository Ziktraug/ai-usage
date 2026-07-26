import type { WideEventResourceService, WideEventSink } from '@ai-usage/effect-runtime';
import type { CollectionSourceId, SourceControlView } from '@ai-usage/report-core/source-control';
import type { Effect } from 'effect';

export interface WebEffectExecutor {
  readonly runEffect: <A, E>(effect: Effect.Effect<A, E, WideEventResourceService | WideEventSink>) => Promise<A>;
}

export interface WebSourceControlPort {
  readonly detectAll: () => Promise<void>;
  readonly getSnapshot: () => Promise<SourceControlView>;
  readonly requestPublication: () => Promise<boolean>;
  readonly runAllEnabled: () => Promise<number>;
  readonly runNow: (sourceId: CollectionSourceId) => Promise<boolean>;
  readonly setEnabled: (sourceId: CollectionSourceId, enabled: boolean) => Promise<void>;
  readonly start: () => Promise<SourceControlView>;
  readonly subscribe: (listener: (snapshot: SourceControlView) => void) => () => void;
}

export interface WebProcessRuntime {
  readonly dispose: () => Promise<void>;
  readonly effects: WebEffectExecutor;
  readonly sourceControl: WebSourceControlPort;
}

const runtimeRegistry = globalThis as typeof globalThis & {
  __aiUsageWebProcessRuntime: WebProcessRuntime | undefined;
  __aiUsageWebProcessRuntimeReplacement: Promise<void> | undefined;
  __aiUsageWebProcessRuntimeTeardown: (() => Promise<void>) | undefined;
};

const uninstallRuntime =
  (runtime: WebProcessRuntime): (() => void) =>
  () => {
    if (runtimeRegistry.__aiUsageWebProcessRuntime === runtime) {
      runtimeRegistry.__aiUsageWebProcessRuntime = undefined;
      runtimeRegistry.__aiUsageWebProcessRuntimeTeardown = undefined;
    }
  };

const disposeRuntime =
  (runtime: WebProcessRuntime): (() => Promise<void>) =>
  () =>
    runtime.dispose();

export const installWebProcessRuntime = (runtime: WebProcessRuntime): (() => void) => {
  if (runtimeRegistry.__aiUsageWebProcessRuntime !== undefined) {
    throw new Error('A source-control runtime is already installed in this process.');
  }
  runtimeRegistry.__aiUsageWebProcessRuntime = runtime;
  runtimeRegistry.__aiUsageWebProcessRuntimeTeardown = disposeRuntime(runtime);
  return uninstallRuntime(runtime);
};

export const replaceWebProcessRuntime = async (
  runtime: WebProcessRuntime,
  teardown: () => Promise<void> = disposeRuntime(runtime),
): Promise<() => void> => {
  const previousReplacement = runtimeRegistry.__aiUsageWebProcessRuntimeReplacement ?? Promise.resolve();
  const replacement = previousReplacement.then(async () => {
    const previousRuntime = runtimeRegistry.__aiUsageWebProcessRuntime;
    if (previousRuntime && previousRuntime !== runtime) {
      const previousTeardown = runtimeRegistry.__aiUsageWebProcessRuntimeTeardown ?? disposeRuntime(previousRuntime);
      runtimeRegistry.__aiUsageWebProcessRuntime = undefined;
      runtimeRegistry.__aiUsageWebProcessRuntimeTeardown = undefined;
      await previousTeardown();
    }
    runtimeRegistry.__aiUsageWebProcessRuntime = runtime;
    runtimeRegistry.__aiUsageWebProcessRuntimeTeardown = teardown;
  });
  runtimeRegistry.__aiUsageWebProcessRuntimeReplacement = replacement;
  try {
    await replacement;
  } finally {
    if (runtimeRegistry.__aiUsageWebProcessRuntimeReplacement === replacement) {
      runtimeRegistry.__aiUsageWebProcessRuntimeReplacement = undefined;
    }
  }
  return uninstallRuntime(runtime);
};

export const tryGetWebProcessRuntime = (): WebProcessRuntime | undefined => runtimeRegistry.__aiUsageWebProcessRuntime;

export const getWebProcessRuntime = (): WebProcessRuntime => {
  const runtime = tryGetWebProcessRuntime();
  if (!runtime) {
    throw new Error('The source-control runtime has not started.');
  }
  return runtime;
};
