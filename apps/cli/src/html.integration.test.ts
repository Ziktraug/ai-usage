import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const skipIntegrationTest = process.env.RUN_HTML_EXPORT_INTEGRATION !== '1';
const workspaceDir = path.resolve(import.meta.dir, '../../..');
const reportsDir = path.join(workspaceDir, 'ai-usage-reports');
const cliEntry = path.join(import.meta.dir, 'main.ts');
const htmlEntry = path.join(import.meta.dir, 'html.ts');
const EXTERNAL_ASSET_PATTERN = /<(?:link|script)\b[^>]+(?:href|src)=["']\/assets\//;
const OUTPUT_PATH_PATTERN = /Wrote (ai-usage-reports\/[^\n]+\.html)/;
const SERVER_ONLY_NAVIGATION_PATTERN = /href=["']\/(?:skills|sync)(?:[?"'])/;

let isolatedHome: string;

beforeAll(async () => {
  isolatedHome = await mkdtemp(path.join(tmpdir(), 'ai-usage-html-export-'));
});

afterAll(async () => {
  if (isolatedHome) {
    await rm(isolatedHome, { force: true, recursive: true });
  }
});

const runBun = async (args: string[], env: Record<string, string> = {}) => {
  const inheritedEnvironment = { ...Bun.env };
  inheritedEnvironment.AI_USAGE_REPORT_APP_DIR = undefined;
  const process = Bun.spawn(['bun', ...args], {
    cwd: workspaceDir,
    env: {
      ...inheritedEnvironment,
      HOME: isolatedHome,
      ...env,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const inspectSelfContainedReport = (html: string) => ({
  hasDoctype: html.includes('<!DOCTYPE html>'),
  hasExternalAsset: EXTERNAL_ASSET_PATTERN.test(html),
  hasFallback: html.includes('report app not built'),
  hasServerOnlyNavigation: SERVER_ONLY_NAVIGATION_PATTERN.test(html),
  hasStaticPayload: html.includes('window.__AI_USAGE_REPORT_STATIC__=true'),
});

test.skipIf(skipIntegrationTest)('CLI renders the built report app as self-contained HTML', async () => {
  const result = await runBun([cliEntry, '--html', '--harness', 'codex', '--no-cursor']);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  expect(inspectSelfContainedReport(result.stdout)).toEqual({
    hasDoctype: true,
    hasExternalAsset: false,
    hasFallback: false,
    hasServerOnlyNavigation: false,
    hasStaticPayload: true,
  });
});

test.skipIf(skipIntegrationTest)('CLI fails loudly when report app build artifacts are missing', async () => {
  const missingAppDir = path.join(isolatedHome, 'missing-report-app');
  const result = await runBun([cliEntry, '--html', '--harness', 'codex', '--no-cursor'], {
    AI_USAGE_REPORT_APP_DIR: missingAppDir,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(`Report app build artifact is missing: ${missingAppDir}/.output/server/_ssr/ssr.mjs`);
});

test.skipIf(skipIntegrationTest)('CLI fails loudly when client build artifacts are missing', async () => {
  const incompleteAppDir = path.join(isolatedHome, 'server-only-report-app');
  const serverDir = path.join(incompleteAppDir, '.output/server/_ssr');
  await mkdir(serverDir, { recursive: true });
  await writeFile(
    path.join(serverDir, 'ssr.mjs'),
    `export default { fetch: () => new Response('<!DOCTYPE html><html><head></head><body></body></html>') };`,
  );

  const result = await runBun([cliEntry, '--html', '--harness', 'codex', '--no-cursor'], {
    AI_USAGE_REPORT_APP_DIR: incompleteAppDir,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(
    `Report app client build artifact is missing. Expected ${incompleteAppDir}/.output/public`,
  );
});

test.skipIf(skipIntegrationTest)('CLI fails loudly when report app SSR fails', async () => {
  const failingAppDir = path.join(isolatedHome, 'failing-report-app');
  const serverDir = path.join(failingAppDir, '.output/server/_ssr');
  await mkdir(path.join(failingAppDir, '.output/public'), { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await writeFile(
    path.join(serverDir, 'ssr.mjs'),
    `export default { fetch: () => new Response('<h1>SSR failed</h1>', { status: 500 }) };`,
  );

  const result = await runBun([cliEntry, '--html', '--harness', 'codex', '--no-cursor'], {
    AI_USAGE_REPORT_APP_DIR: failingAppDir,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Report app SSR failed with 500');
});

test.skipIf(skipIntegrationTest)('CLI fails loudly when a referenced client artifact is missing', async () => {
  const incompleteAppDir = path.join(isolatedHome, 'incomplete-report-app');
  const serverDir = path.join(incompleteAppDir, '.output/server/_ssr');
  await mkdir(path.join(incompleteAppDir, '.output/public/assets'), { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await writeFile(
    path.join(serverDir, 'ssr.mjs'),
    `export default { fetch: () => new Response('<!DOCTYPE html><html><head></head><body><script src="/assets/missing.js"></script></body></html>') };`,
  );

  const result = await runBun([cliEntry, '--html', '--harness', 'codex', '--no-cursor'], {
    AI_USAGE_REPORT_APP_DIR: incompleteAppDir,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(
    `Report app client artifact is missing: ${incompleteAppDir}/.output/public/assets/missing.js`,
  );
});

test.skipIf(skipIntegrationTest)(
  'html export writes a real self-contained report artifact',
  async () => {
    const reportsBefore = new Set(await readdir(reportsDir).catch(() => []));
    const result = await runBun([htmlEntry, 'export', '--harness', 'codex', '--no-cursor']);
    const outputMatch = OUTPUT_PATH_PATTERN.exec(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(outputMatch?.[1]).toBeDefined();

    const relativeOutputPath = outputMatch?.[1];
    if (!relativeOutputPath) {
      return;
    }

    const outputPath = path.join(workspaceDir, relativeOutputPath);
    try {
      const outputStats = await stat(outputPath);
      expect(outputStats.size).toBeGreaterThan(100_000);
      expect(inspectSelfContainedReport(await readFile(outputPath, 'utf8'))).toEqual({
        hasDoctype: true,
        hasExternalAsset: false,
        hasFallback: false,
        hasServerOnlyNavigation: false,
        hasStaticPayload: true,
      });
    } finally {
      if (!reportsBefore.has(path.basename(outputPath))) {
        await rm(outputPath, { force: true });
      }
    }
  },
  120_000,
);
