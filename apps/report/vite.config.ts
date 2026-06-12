import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import solid from 'vite-plugin-solid';

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/src/main.ts');
const PAYLOAD_TTL_MS = 60_000;

// Keep in sync with serializeForInlineScript in apps/cli/src/render/html.ts.
const escapeForInlineScript = (json: string) =>
  json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

// Serve the dev dashboard with this machine's real usage data by injecting the
// CLI payload exactly like `--html` does. Collection takes seconds, so the
// payload is cached and refreshed stale-while-revalidate; when collection
// fails the app falls back to its demo payload (flagged in the UI).
const realUsagePayload = (): Plugin => {
  let cache: { at: number; script: string } | null = null;
  let inflight: Promise<void> | null = null;

  const refresh = () => {
    inflight ??= execFileAsync('bun', [cliEntry, '--payload-json'], { maxBuffer: 64 * 1024 * 1024 })
      .then(({ stdout }) => {
        cache = { at: Date.now(), script: escapeForInlineScript(stdout.trim()) };
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
    configureServer() {
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
  plugins: [solid(), viteSingleFile(), realUsagePayload()],
  build: {
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
});
