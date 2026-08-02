import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/solid-start/plugin/vite';
import { nitro } from 'nitro/vite';
import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { getServerRuntimeMode } from './src/server/runtime-mode.server.ts';
import { resolveViteRuntimePaths } from './vite-output-paths.ts';
import { createRetryableWarmup } from './vite-warmup.ts';

const serverFunctionEntrypoints = [
  './src/server/report-payload.ts',
  './src/server/skills.ts',
  './src/server/sync.ts',
] as const;

const clientOptimizeDeps = [
  '@pandacss/dev',
  '@solid-primitives/refs',
  '@tanstack/history',
  '@tanstack/query-core',
  '@tanstack/router-core',
  '@tanstack/router-core/isServer',
  '@tanstack/router-core/scroll-restoration-script',
  '@tanstack/router-core/ssr/client',
  '@tanstack/solid-query',
  'effect',
  'seroval',
  'solid-js',
  'solid-js/h',
  'solid-js/html',
  'solid-js/store',
  'solid-js/web',
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
    const runtimeMode = getServerRuntimeMode();
    const warmup = async () => {
      if (runtimeMode === 'demo') {
        return;
      }
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

      if (runtimeMode === 'demo') {
        _res.statusCode = 404;
        _res.setHeader('cache-control', 'no-store');
        _res.end();
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
      if (runtimeMode === 'demo') {
        return;
      }
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

export default defineConfig((configEnvironment) => {
  const { nitroBuildDirectory, nitroOutputDirectory, viteCacheDirectory } = resolveViteRuntimePaths(configEnvironment);

  return {
    ...(getServerRuntimeMode() === 'demo' ? { envDir: false } : {}),
    cacheDir: viteCacheDirectory,
    optimizeDeps: {
      entries: ['src/routes/**/*.tsx'],
      include: [...clientOptimizeDeps],
    },
    plugins: [
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
      nitro({
        buildDir: nitroBuildDirectory,
        handlers: [
          {
            handler: './server/routes/api/source-control.get.ts',
            method: 'GET',
            route: '/api/source-control',
          },
          {
            handler: './server/routes/api/source-control.post.ts',
            method: 'POST',
            route: '/api/source-control/command',
          },
        ],
        output: {
          dir: nitroOutputDirectory,
        },
        plugins: ['./server/plugins/web-read-observability.ts'],
        preset: 'bun',
      }),
      solidDepScanPlugin(),
    ],
    server: {
      watch: {
        // Panda and Nitro write these generated trees during check/build/dev.
        // Watching them can import partial output or turn a production build
        // into a development HMR/reload loop.
        ignored: ['**/styled-system/**', '**/.output-build/**', '**/.output-dev/**', '**/dist/**'],
      },
    },
    resolve: {
      dedupe: ['solid-js', 'solid-js/web'],
    },
  };
});
