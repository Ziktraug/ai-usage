import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serializeForInlineScript } from '@ai-usage/core/html-export';

const execFileAsync = promisify(execFile);

const distDir = path.resolve(import.meta.dir, 'dist');
const cliEntry = path.resolve(import.meta.dir, '../cli/src/main.ts');
const PAYLOAD_TTL_MS = 60_000;

let cache: { at: number; script: string } | null = null;
let inflight: Promise<void> | null = null;

const refresh = (force = false) => {
  if (force) cache = null;
  inflight ??= execFileAsync('bun', [cliEntry, '--payload-json'], { maxBuffer: 64 * 1024 * 1024 })
    .then(({ stdout }) => {
      cache = { at: Date.now(), script: serializeForInlineScript(stdout.trim()) };
    })
    .catch((error: unknown) => {
      console.warn('[ai-usage] payload unavailable:', error instanceof Error ? error.message : error);
    })
    .finally(() => { inflight = null; });
  return inflight;
};

const indexHTML = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

const server = Bun.serve({
  port: 4173,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/__ai_usage_report_payload') {
      const force = url.searchParams.get('force') === '1';
      if (!cache || force || Date.now() - cache.at > PAYLOAD_TTL_MS) await refresh(force);
      if (!cache) return new Response(JSON.stringify({ error: 'payload unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
      return new Response(cache.script, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!cache || Date.now() - cache.at > PAYLOAD_TTL_MS) void refresh();
      const payloadScript = cache ? `<script>window.__AI_USAGE_REPORT__=${cache.script};</script>` : '';
      const html = payloadScript && indexHTML.includes('</head>')
        ? indexHTML.replace('</head>', `${payloadScript}</head>`)
        : indexHTML;
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }

    const filePath = path.join(distDir, url.pathname);
    const file = Bun.file(filePath);
    return file.size > 0 ? new Response(file) : new Response('Not found', { status: 404 });
  },
});

void refresh();
console.log(`ai-usage report → http://localhost:${server.port}`);
