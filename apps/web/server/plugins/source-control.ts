import { Effect } from 'effect';
import { definePlugin } from 'nitro';
import { registerPersistentSourceRuntimeHotReload } from '../../src/server/persistent-source-runtime';
import { publishStoredReportRevisionForSourceControl } from '../../src/server/report-payload.server';
import { createWebSourceControlRuntime, replaceWebSourceControlRuntime } from '../../src/server/source-control.server';
import { createSourceControlE2EFixture } from '../../src/server/source-control-e2e-fixture.server';

export default definePlugin(async (nitroApp) => {
  const fixtureRuntime = process.env.VITE_AI_USAGE_E2E === '1';
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
