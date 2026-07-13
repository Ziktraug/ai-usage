import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/solid-start/plugin/vite';
import { nitro } from 'nitro/vite';
import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { manualSyncImportDevPlugin } from './vite-manual-sync-import';
import { createRetryableWarmup } from './vite-warmup';

const serverFunctionEntrypoints = [
  './src/server/report-payload.ts',
  './src/server/skills.ts',
  './src/server/sync.ts',
] as const;

const solidDepScanPlugin = (): Plugin => ({
  name: 'ai-usage-solid-dep-scan',
  enforce: 'post',
  configEnvironment: {
    order: 'post',
    handler(_name, config) {
      config.optimizeDeps ??= {};
      config.optimizeDeps.rolldownOptions ??= {};
      config.optimizeDeps.rolldownOptions.transform ??= {};
      config.optimizeDeps.rolldownOptions.transform.jsx = 'preserve';
    },
  },
});

const tanStackServerFunctionWarmupPlugin = (): Plugin => ({
  name: 'ai-usage-tanstack-server-fn-warmup',
  apply: 'serve',
  configureServer(server) {
    const warmup = async () => {
      const ssrEnvironment = server.environments.ssr;
      if (!ssrEnvironment) {
        return;
      }

      for (const entrypoint of serverFunctionEntrypoints) {
        const filePath = fileURLToPath(new URL(entrypoint, import.meta.url));
        await ssrEnvironment.transformRequest(filePath);
      }
    };

    const ensureWarmup = createRetryableWarmup(warmup);

    server.middlewares.use(async (req, _res, next) => {
      if (!req.url?.startsWith('/_serverFn/')) {
        next();
        return;
      }

      try {
        await ensureWarmup();
        next();
      } catch (error) {
        next(error);
      }
    });

    server.httpServer?.once('listening', () => {
      ensureWarmup().catch((error: unknown) => {
        server.config.logger.warn(
          `[ai-usage] Failed to warm TanStack server functions: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  },
});

export default defineConfig({
  plugins: [
    manualSyncImportDevPlugin(),
    tanStackServerFunctionWarmupPlugin(),
    tanstackStart({
      router: {
        codeSplittingOptions: {
          defaultBehavior: [['component']],
          // Splitting the root route leaves the served app SSR-only: navigation
          // never hydrates. Keep this one route eager; nested routes still split.
          splitBehavior: ({ routeId }) => (routeId === '/' ? [] : undefined),
        },
      },
    }),
    solid({ ssr: true }),
    nitro({ preset: 'node-server' }),
    solidDepScanPlugin(),
  ],
  server: {
    watch: {
      // The design-system package writes Panda helpers in-place during check/build.
      // If a dev server watches those generated files, HMR can import them mid-write
      // and leave the client bundle unhydrated until a full restart.
      ignored: ['**/packages/design-system/styled-system/**'],
    },
  },
  resolve: {
    dedupe: ['solid-js', 'solid-js/web'],
  },
});
