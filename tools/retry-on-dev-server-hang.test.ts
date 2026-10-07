import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyHangLine, createLineClassifier, type HangSignature, MAX_ATTEMPTS } from './retry-on-dev-server-hang';

const WRAPPER_PATH = path.join(import.meta.dir, 'retry-on-dev-server-hang.ts');
const WRAPPER_RUN_DEADLINE_MS = 30_000;

/** Verbatim from PR Checks run 37612153241, attempt 1 (Vite logger formatting). */
const CI_TRANSPORT_HANG_VITE_LOGGER =
  '[WebServer] 1:13:54 PM [vite] (ssr) Error when evaluating SSR module /@fs/home/runner/work/ai-usage/ai-usage/node_modules/@sveltejs/kit/src/runtime/server/index.js: transport invoke timed out after 60000ms (data: {"type":"custom","event":"vite:invoke","data":{"name":"fetchModule","id":"send:Y4CXLA6JKlAXOqfMwovVi","data":["/@fs/home/runner/work/ai-usage/ai-usage/node_modules/@sveltejs/kit/src/runtime/server/page/serialize_data.js?v=c6aa7030","/home/runner/work/ai-usage/ai-usage/node_modules/@sveltejs/kit/src/runtime/server/page/render.js",{"cached":false,"startOffset":3}]}})';

/** Verbatim from the same run, attempt 2 (Bun uncaught-error formatting, no "Error when evaluating"). */
const CI_TRANSPORT_HANG_BUN_FORMATTER =
  '[WebServer] error: transport invoke timed out after 60000ms (data: {"type":"custom","event":"vite:invoke","data":{"name":"fetchModule","id":"send:d0Kd8PNBOgHrenZB_dH_r","data":["/@fs/home/runner/work/ai-usage/ai-usage/packages/usage-store/src/session-query-sqlite.ts","/home/runner/work/ai-usage/ai-usage/packages/usage-store/src/performance-testing.ts",{"cached":false,"startOffset":3}]}})';

/** Playwright's message when the dev server never announces its listener. */
const PLAYWRIGHT_STARTUP_HANG =
  'Error: Timed out waiting 20000ms from config.webServer.\n\n    at /home/runner/work/ai-usage/ai-usage/node_modules/playwright/lib/plugins/webServerPlugin.js:118:17';

const PLAYWRIGHT_ASSERTION = [
  '  1) e2e/demo-isolation.spec.ts:12:0 › explores Campaigns without local data',
  '    Error: expect(locator).toBeVisible() failed',
  '    Locator: locator(\'[data-app-navigation="desktop"][data-hydrated="true"]\')',
  '    Expected: visible',
  '    Error: element(s) not found',
].join('\n');

const APPLICATION_TIMEOUTS = [
  '  1) e2e/session-scroll.scale.ts:40:1 › keeps the session list responsive',
  '    Test timeout of 60000ms exceeded.',
  '    Error: page.goto: Timeout 30000ms exceeded.',
  '    Error: locator.click: Timeout 10000ms exceeded.',
  // A near miss: Vite's words without the invoke payload must not count.
  '    Error: request to engine control plane timed out after 60000ms',
  '    Error: transport invoke timed out after 60000ms (data: {"type":"ping"})',
].join('\n');

interface ScriptedAttempt {
  readonly exitCode: number;
  /** Write the line in two pieces with a pause so it crosses a chunk boundary. */
  readonly splitStdout?: readonly [string, string];
  readonly stderr?: string;
  readonly stdout?: string;
}

interface WrapperRun {
  readonly attemptsMade: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

/**
 * Run the wrapper around a scripted child. Each attempt reads a counter file,
 * so the child can behave differently on the retry, exactly like a hang that
 * clears on the second start would.
 */
const runWrapper = async (attempts: readonly ScriptedAttempt[]): Promise<WrapperRun> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retry-on-dev-server-hang-'));
  temporaryRoots.push(root);
  const scenarioPath = path.join(root, 'scenario.json');
  const counterPath = path.join(root, 'attempts.txt');
  const childPath = path.join(root, 'child.ts');
  await writeFile(scenarioPath, JSON.stringify(attempts));
  await writeFile(counterPath, '0');
  await writeFile(
    childPath,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `const scenario = JSON.parse(readFileSync(${JSON.stringify(scenarioPath)}, 'utf8'));`,
      `const made = Number(readFileSync(${JSON.stringify(counterPath)}, 'utf8')) + 1;`,
      `writeFileSync(${JSON.stringify(counterPath)}, String(made));`,
      'const step = scenario[made - 1] ?? { exitCode: 99, stderr: "scenario exhausted" };',
      'if (step.splitStdout) {',
      '  process.stdout.write(step.splitStdout[0]);',
      '  await new Promise((resolve) => setTimeout(resolve, 100));',
      "  process.stdout.write(step.splitStdout[1] + '\\n');",
      '}',
      "if (step.stdout) process.stdout.write(step.stdout + '\\n');",
      "if (step.stderr) process.stderr.write(step.stderr + '\\n');",
      'process.exit(step.exitCode);',
    ].join('\n'),
  );
  const child = Bun.spawn(['bun', WRAPPER_PATH, 'bun', childPath], {
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), WRAPPER_RUN_DEADLINE_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const attemptsMade = Number(await readFile(counterPath, 'utf8'));
    return { attemptsMade, exitCode, stderr, stdout };
  } finally {
    clearTimeout(timeout);
  }
};

const signatureName = (signature: HangSignature | null): string | null => signature?.name ?? null;

describe('hang signature classification', () => {
  test('recognises the historical startup hang on one line', () => {
    expect(signatureName(classifyHangLine('Error: Timed out waiting 20000ms from config.webServer.'))).toBe(
      'dev-server-startup',
    );
  });

  test('recognises both CI formattings of the module-runner transport hang', () => {
    expect(signatureName(classifyHangLine(CI_TRANSPORT_HANG_VITE_LOGGER))).toBe('module-runner-transport');
    expect(signatureName(classifyHangLine(CI_TRANSPORT_HANG_BUN_FORMATTER))).toBe('module-runner-transport');
  });

  test('rejects timeouts and assertions that lack the full signature', () => {
    for (const line of [...APPLICATION_TIMEOUTS.split('\n'), ...PLAYWRIGHT_ASSERTION.split('\n')]) {
      expect(classifyHangLine(line)).toBeNull();
    }
    // Markers spread over two lines are two unrelated lines, not a signature.
    expect(classifyHangLine('transport invoke timed out after 60000ms')).toBeNull();
    expect(classifyHangLine('"event":"vite:invoke" "name":"fetchModule"')).toBeNull();
  });

  test('reassembles a signature that straddles stream chunks', () => {
    const seen: string[] = [];
    const classifier = createLineClassifier((signature) => seen.push(signature.name));
    const cut = CI_TRANSPORT_HANG_BUN_FORMATTER.indexOf('"event"');
    classifier.push(`ready\n${CI_TRANSPORT_HANG_BUN_FORMATTER.slice(0, cut)}`);
    expect(seen).toEqual([]);
    classifier.push(CI_TRANSPORT_HANG_BUN_FORMATTER.slice(cut));
    expect(seen).toEqual([]);
    classifier.flush();
    expect(seen).toEqual(['module-runner-transport']);
  });
});

describe('retry-on-dev-server-hang wrapper', () => {
  test(
    'retries once after the historical startup hang and succeeds',
    async () => {
      const run = await runWrapper([
        { exitCode: 1, stdout: PLAYWRIGHT_STARTUP_HANG },
        { exitCode: 0, stdout: '2 passed' },
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.attemptsMade).toBe(2);
      expect(run.stderr).toContain('[dev-server-startup]. Retrying: attempt 2 of 2');
      expect(run.stdout).toContain('Timed out waiting 20000ms');
      expect(run.stdout).toContain('2 passed');
    },
    WRAPPER_RUN_DEADLINE_MS,
  );

  test(
    'retries once after the module-runner transport hang and succeeds',
    async () => {
      const run = await runWrapper([
        { exitCode: 1, stdout: `${CI_TRANSPORT_HANG_VITE_LOGGER}\n  2 failed` },
        { exitCode: 0, stdout: '2 passed' },
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.attemptsMade).toBe(2);
      expect(run.stderr).toContain('[module-runner-transport]. Retrying: attempt 2 of 2');
    },
    WRAPPER_RUN_DEADLINE_MS,
  );

  test(
    'retries when the transport hang line arrives split across chunks',
    async () => {
      const cut = CI_TRANSPORT_HANG_BUN_FORMATTER.indexOf('(data:');
      const run = await runWrapper([
        {
          exitCode: 1,
          splitStdout: [CI_TRANSPORT_HANG_BUN_FORMATTER.slice(0, cut), CI_TRANSPORT_HANG_BUN_FORMATTER.slice(cut)],
        },
        { exitCode: 0 },
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.attemptsMade).toBe(2);
    },
    WRAPPER_RUN_DEADLINE_MS,
  );

  test(
    'does not retry a Playwright assertion failure',
    async () => {
      const run = await runWrapper([{ exitCode: 1, stdout: PLAYWRIGHT_ASSERTION }, { exitCode: 0 }]);
      expect(run.exitCode).toBe(1);
      expect(run.attemptsMade).toBe(1);
      expect(run.stderr).toContain('no dev-server-hang signature; not retrying (attempt 1)');
    },
    WRAPPER_RUN_DEADLINE_MS,
  );

  test(
    'does not retry an application timeout without the signature',
    async () => {
      const run = await runWrapper([{ exitCode: 1, stderr: APPLICATION_TIMEOUTS }, { exitCode: 0 }]);
      expect(run.exitCode).toBe(1);
      expect(run.attemptsMade).toBe(1);
      expect(run.stderr).toContain('not retrying');
    },
    WRAPPER_RUN_DEADLINE_MS,
  );

  test(
    'fails with the child status when the hang repeats on the retry',
    async () => {
      const run = await runWrapper([
        { exitCode: 1, stdout: CI_TRANSPORT_HANG_VITE_LOGGER },
        { exitCode: 3, stdout: CI_TRANSPORT_HANG_BUN_FORMATTER },
        { exitCode: 0 },
      ]);
      expect(run.exitCode).toBe(3);
      expect(run.attemptsMade).toBe(MAX_ATTEMPTS);
      expect(run.stderr).toContain(`[module-runner-transport] on all ${MAX_ATTEMPTS} attempts; failing`);
    },
    WRAPPER_RUN_DEADLINE_MS,
  );

  test(
    'passes a clean success through untouched',
    async () => {
      const run = await runWrapper([{ exitCode: 0, stdout: '2 passed' }]);
      expect(run.exitCode).toBe(0);
      expect(run.attemptsMade).toBe(1);
      expect(run.stderr).toBe('');
    },
    WRAPPER_RUN_DEADLINE_MS,
  );
});
