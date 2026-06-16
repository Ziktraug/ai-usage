import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serializeForInlineScript } from '@ai-usage/core/html-export';
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/src/main.ts');
const PAYLOAD_TTL_MS = 60_000;
const PAYLOAD_ENDPOINT = '/__ai_usage_report_payload';

// Serve the dev dashboard with this machine's real usage data by injecting the
// CLI payload exactly like `--html` does. Collection takes seconds, so the
// payload is cached and refreshed stale-while-revalidate; when collection
// fails the app falls back to its demo payload (flagged in the UI).
const realUsagePayload = (): Plugin => {
  let cache: { at: number; script: string } | null = null;
  let inflight: Promise<void> | null = null;

  const refresh = (force = false) => {
    if (force) cache = null;
    inflight ??= execFileAsync('bun', [cliEntry, '--payload-json'], { maxBuffer: 64 * 1024 * 1024 })
      .then(({ stdout }) => {
        cache = { at: Date.now(), script: serializeForInlineScript(stdout.trim()) };
      })
      .catch((error: unknown) => {
        console.warn(
          '[ai-usage] real usage payload unavailable; dev server falls back to demo data:',
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    name: 'ai-usage:real-dev-payload',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(PAYLOAD_ENDPOINT, async (req, res) => {
        const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
        const force = url.searchParams.get('force') === '1';
        if (!cache || force || Date.now() - cache.at > PAYLOAD_TTL_MS) await refresh(force);
        if (!cache) {
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'usage payload unavailable' }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(cache.script);
      });
      void refresh();
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(): Promise<HtmlTagDescriptor[]> {
        if (!cache) await refresh();
        else if (Date.now() - cache.at > PAYLOAD_TTL_MS) void refresh();
        if (!cache) return [];
        return [
          {
            tag: 'script',
            children: `window.__AI_USAGE_REPORT__=${cache.script};`,
            injectTo: 'head',
          },
        ];
      },
    },
  };
};

export default defineConfig({
  plugins: [solid(), realUsagePayload()],
  build: {
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        format: 'iife',
      },
    },
  },
});
