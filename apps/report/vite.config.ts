import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tanstackStart } from '@tanstack/solid-start/plugin/vite';
import { nitro } from 'nitro/vite';
import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = path.join(rootDir, 'apps/cli/src/main.ts');
const payloadTtlMs = 60_000;

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

const devPayloadPlugin = (): Plugin => {
  let cache: { at: number; payload: string } | null = null;
  let inflight: Promise<void> | null = null;

  const refresh = (force = false) => {
    if (force) cache = null;
    inflight ??= execFileAsync('bun', [cliEntry, '--payload-json'], {
      cwd: rootDir,
      maxBuffer: 64 * 1024 * 1024,
    })
      .then(({ stdout }) => {
        cache = { at: Date.now(), payload: stdout.trim() };
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    name: 'ai-usage-dev-payload',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__ai_usage_report_payload', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const force = url.searchParams.get('force') === '1';
        try {
          if (!cache || force || Date.now() - cache.at > payloadTtlMs) await refresh(force);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(cache?.payload ?? '{}');
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
    },
  };
};

export default defineConfig({
  plugins: [
    devPayloadPlugin(),
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
  resolve: {
    dedupe: ['solid-js', 'solid-js/web'],
  },
});
