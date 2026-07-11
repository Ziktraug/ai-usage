import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/solid-start/plugin/vite';
import { nitro } from 'nitro/vite';
import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { createRetryableWarmup } from './vite-warmup';

type ManualMergeServerModule = typeof import('./src/server/lan-merge.server');
const manualMergeServerModuleUrl = new URL('./src/server/lan-merge.server.ts', import.meta.url).href;
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

const requestText = async (request: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const manualSyncImportDevPlugin = (): Plugin => ({
  name: 'ai-usage-manual-sync-import-dev',
  enforce: 'pre',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.method !== 'POST' || (request.url?.split('?', 1)[0] ?? '') !== '/sync') {
        return next();
      }

      try {
        const text = await requestText(request);
        const { importManualMergeBundleForServer } = (await import(
          manualMergeServerModuleUrl
        )) as ManualMergeServerModule;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(await importManualMergeBundleForServer({ text })));
      } catch (error) {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              tag: 'Error',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
    });
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
          defaultBehavior: [],
        },
      },
    }),
    solid({ ssr: true }),
    nitro(),
    solidDepScanPlugin(),
  ],
  build: {
    cssCodeSplit: false,
  },
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
