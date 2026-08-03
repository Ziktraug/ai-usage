import { tanstackStart } from '@tanstack/solid-start/plugin/vite';
import { nitro } from 'nitro/vite';
import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { getServerRuntimeMode } from './src/server/runtime-mode.server.ts';
import { resolveViteRuntimePaths } from './vite-output-paths.ts';

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
            handler: './server/routes/rpc.ts',
            route: '/rpc/**',
          },
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
          {
            handler: './server/routes/api/manual-merge-download.post.ts',
            method: 'POST',
            route: '/api/manual-merge/download',
          },
          {
            handler: './server/routes/api/manual-merge-upload.post.ts',
            method: 'POST',
            route: '/api/manual-merge/upload',
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
