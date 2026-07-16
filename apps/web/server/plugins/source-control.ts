import { Effect } from 'effect';
import { definePlugin } from 'nitro';
import { publishStoredReportRevisionForSourceControl } from '../../src/server/report-payload.server';
import { createWebSourceControlRuntime, installWebSourceControlRuntime } from '../../src/server/source-control.server';

export default definePlugin((nitroApp) => {
  const fixtureRuntime = process.env.VITE_AI_USAGE_E2E === '1';
  const productionSmoke = process.env.AI_USAGE_PRODUCTION_SMOKE === '1';
  const runtime = createWebSourceControlRuntime({
    publication: {
      publish: fixtureRuntime
        ? Effect.succeed({ changed: false })
        : Effect.tryPromise({
            try: publishStoredReportRevisionForSourceControl,
            catch: (cause) => cause,
          }),
    },
    ...(fixtureRuntime ? { sources: new Map() } : {}),
  });
  const uninstall = installWebSourceControlRuntime(runtime);
  const startup = runtime.start();
  if (productionSmoke) {
    startup.then(
      () => {
        console.error('[ai-usage] Source control started.');
      },
      () => undefined,
    );
  }
  startup.catch((error: unknown) => {
    console.error(
      `[ai-usage] Source control startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  let shutdown: Promise<void> | undefined;
  const closeRuntime = (): Promise<void> => {
    shutdown ??= (async () => {
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
  const closeAfterSignal = (): void => {
    closeRuntime().catch((error: unknown) => {
      console.error(
        `[ai-usage] Source control shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  process.once('SIGINT', closeAfterSignal);
  process.once('SIGTERM', closeAfterSignal);
  nitroApp.hooks.hook('close', async () => {
    await closeRuntime();
  });
});
