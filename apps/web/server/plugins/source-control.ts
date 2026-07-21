import { definePlugin } from 'nitro';
import { getServerRuntimeMode } from '../../src/server/runtime-mode.server';
import { startSourceControlPluginOutsideDemo } from '../../src/server/source-control-plugin-boundary.server';

export default definePlugin(async (nitroApp) => {
  await startSourceControlPluginOutsideDemo(async () => {
    const [
      { Effect },
      { registerPersistentSourceRuntimeHotReload },
      { publishStoredReportRevisionForSourceControl },
      { createSourceControlE2EFixture },
      { createWebSourceControlRuntime, replaceWebSourceControlRuntime },
    ] = await Promise.all([
      import('effect'),
      import('../../src/server/persistent-source-runtime'),
      import('../../src/server/report-payload.server'),
      import('../../src/server/source-control-e2e-fixture.server'),
      import('../../src/server/source-control.server'),
    ]);
    const fixtureRuntime = getServerRuntimeMode() === 'e2e';
    const productionSmoke = process.env.AI_USAGE_PRODUCTION_SMOKE === '1';
    const fixture = fixtureRuntime ? createSourceControlE2EFixture() : undefined;
    const runtime = createWebSourceControlRuntime({
      policyStore: fixture?.policyStore,
      publication: fixture?.publication ?? {
        publish: Effect.tryPromise({
          try: publishStoredReportRevisionForSourceControl,
          catch: (cause) => cause,
        }),
      },
      sources: fixture?.sources,
    });
    let uninstall = () => undefined;
    let shutdown: Promise<void> | undefined;
    let unregisterHotReload = () => undefined;
    const closeRuntime = (): Promise<void> => {
      shutdown ??= (async () => {
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
