import { definePlugin } from 'nitro';
import { getServerRuntimeMode } from '../../src/server/runtime-mode.server';
import { startSourceControlPluginOutsideDemo } from '../../src/server/source-control-plugin-boundary.server';

const INITIAL_COLLECTION_FALLBACK_MS = 30_000;

export default definePlugin(async (nitroApp) => {
  await startSourceControlPluginOutsideDemo(async () => {
    const [
      { Effect },
      { makeAiUsageWideEventResource },
      { makeSilentWideEventSinkLayer, makeWebWideEventSinkLayer },
      { getPersistentWebWideEventInstanceId, registerPersistentSourceRuntimeHotReload },
      { publishStoredReportRevisionForSourceControl },
      { createSourceControlE2EFixture },
      { createWebSourceControlRuntime, replaceWebSourceControlRuntime },
      { projectWebWideEvent },
    ] = await Promise.all([
      import('effect'),
      import('@ai-usage/effect-runtime'),
      import('@ai-usage/effect-runtime/node'),
      import('../../src/server/persistent-source-runtime'),
      import('../../src/server/report-payload.server'),
      import('../../src/server/source-control-e2e-fixture.server'),
      import('../../src/server/source-control.server'),
      import('../../src/server/wide-event-presentation.server'),
    ]);
    const serverRuntimeMode = getServerRuntimeMode();
    const fixtureRuntime = serverRuntimeMode === 'e2e';
    const productionSmoke = process.env.AI_USAGE_PRODUCTION_SMOKE === '1';
    const fixture = fixtureRuntime ? createSourceControlE2EFixture() : undefined;
    let releaseInitialCollectionPromise: (() => void) | undefined;
    const initialCollectionReady = new Promise<void>((resolve) => {
      releaseInitialCollectionPromise = resolve;
    });
    let initialCollectionReleased = false;
    let scheduledResponseRelease: ReturnType<typeof setImmediate> | undefined;
    let unregisterResponseHook: () => void = () => undefined;
    const fallbackRelease = globalThis.setTimeout(() => {
      releaseInitialCollection();
    }, INITIAL_COLLECTION_FALLBACK_MS);
    function releaseInitialCollection(): void {
      if (initialCollectionReleased) {
        return;
      }
      initialCollectionReleased = true;
      globalThis.clearTimeout(fallbackRelease);
      if (scheduledResponseRelease !== undefined) {
        clearImmediate(scheduledResponseRelease);
      }
      unregisterResponseHook();
      releaseInitialCollectionPromise?.();
    }
    unregisterResponseHook = nitroApp.hooks.hook('response', (response) => {
      if (
        initialCollectionReleased ||
        scheduledResponseRelease !== undefined ||
        !response.headers.get('content-type')?.startsWith('text/html')
      ) {
        return;
      }
      scheduledResponseRelease = setImmediate(releaseInitialCollection);
    });
    const wideEventResource = makeAiUsageWideEventResource({
      instanceId: fixtureRuntime ? 'e2e-fixture-process' : getPersistentWebWideEventInstanceId(),
      nodeEnvironment: process.env.NODE_ENV,
      surface: 'web',
      testRuntime: fixtureRuntime,
    });
    const runtime = createWebSourceControlRuntime({
      beforeInitialCollection: Effect.promise(() => initialCollectionReady),
      initialPublicationOrder: 'before-collection',
      ...(fixture === undefined ? {} : { policyStore: fixture.policyStore, sources: fixture.sources }),
      publication: fixture?.publication ?? {
        publish: Effect.tryPromise({
          try: publishStoredReportRevisionForSourceControl,
          catch: (cause) => cause,
        }),
      },
      wideEventSinkLayer: fixtureRuntime
        ? makeSilentWideEventSinkLayer(wideEventResource)
        : makeWebWideEventSinkLayer({
            projector: projectWebWideEvent,
            resource: wideEventResource,
          }),
    });
    let uninstall: () => void = () => undefined;
    let shutdown: Promise<void> | undefined;
    let unregisterHotReload: () => void = () => undefined;
    const closeRuntime = (): Promise<void> => {
      shutdown ??= (async () => {
        releaseInitialCollection();
        unregisterHotReload();
        process.off('SIGINT', closeAfterSignal);
        process.off('SIGTERM', closeAfterSignal);
        uninstall();
        await runtime.dispose();
        if (productionSmoke) {
          console.error('[ai-usage] Source control stopped.');
        }
      })();
      return shutdown;
    };
    const closeAfterSignal = async (): Promise<void> => {
      try {
        await closeRuntime();
      } catch (error) {
        console.error(
          `[ai-usage] Source control shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    uninstall = await replaceWebSourceControlRuntime(runtime, closeRuntime);
    unregisterHotReload = registerPersistentSourceRuntimeHotReload(import.meta.hot, closeRuntime);

    process.once('SIGINT', closeAfterSignal);
    process.once('SIGTERM', closeAfterSignal);
    nitroApp.hooks.hook('close', async () => {
      await closeRuntime();
    });

    try {
      await runtime.start();
      if (productionSmoke) {
        console.error('[ai-usage] Source control started.');
      }
    } catch (error) {
      console.error(
        `[ai-usage] Source control startup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
});
