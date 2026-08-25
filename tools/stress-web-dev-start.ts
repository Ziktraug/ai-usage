/**
 * Cold-start the functional-browser dev server repeatedly to catch the known
 * `bun --bun vite` startup hang with full evidence.
 *
 * Each iteration wipes the Vite cache (a fresh CI checkout is always cold),
 * spawns the exact command the Playwright webServer uses, and polls the port
 * until the first HTTP response or the deadline. Output is
 * captured with per-line elapsed timestamps so a hang shows *where* startup
 * stopped, not just that it did. Logs land in apps/web/test-results/, which is
 * gitignored and what CI uploads as an artifact.
 *
 * `DEBUG=vite:*` is itself a timing perturbation, and the job that hangs runs
 * without it, so by default iterations alternate debug off/on: a hang that only
 * occurs in the no-debug arm identifies a heisenbug, and one with debug carries
 * its own forensics. Force one arm with --debug 0|1.
 *
 * Usage: bun --no-env-file tools/stress-web-dev-start.ts [--iterations 15] [--debug 0|1|alternate]
 * Requires `bun --filter @ai-usage/design-system build` and
 * `bun run --cwd apps/web dev:prepare` to have run first, like test:e2e.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 4174;
const READINESS_DEADLINE_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const FORCE_KILL_AFTER_MS = 5000;
const DEFAULT_ITERATIONS = 15;

const rootDirectory = path.resolve(import.meta.dirname, '..');
const webDirectory = path.join(rootDirectory, 'apps', 'web');
const viteCacheDirectory = path.join(webDirectory, '.svelte-kit', 'dev', 'vite');
const logDirectory = path.join(webDirectory, 'test-results', 'dev-server-stress');

type DebugMode = '0' | '1' | 'alternate';

interface StressOptions {
  readonly debug: DebugMode;
  readonly iterations: number;
}

const parseOptions = (argumentList: readonly string[]): StressOptions => {
  let debug: DebugMode = 'alternate';
  let iterations = DEFAULT_ITERATIONS;
  for (let index = 0; index < argumentList.length; index += 2) {
    const flag = argumentList[index];
    const value = argumentList[index + 1];
    if (flag === '--iterations') {
      iterations = Number(value);
    } else if (flag === '--debug' && (value === '0' || value === '1' || value === 'alternate')) {
      debug = value;
    } else {
      throw new Error('Usage: stress-web-dev-start.ts [--iterations <1-200>] [--debug 0|1|alternate]');
    }
  }
  if (!(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 200)) {
    throw new Error('Usage: stress-web-dev-start.ts [--iterations <1-200>] [--debug 0|1|alternate]');
  }
  return { debug, iterations };
};

interface IterationResult {
  readonly debugEnabled: boolean;
  readonly elapsedMs: number;
  readonly iteration: number;
  readonly outcome: 'ready' | 'hang' | `http-${number}`;
}

const pollUntilResponse = async (deadlineAt: number): Promise<{ status: number | undefined; at: number }> => {
  let lastStatus: number | undefined;
  while (Date.now() < deadlineAt) {
    try {
      const response = await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(POLL_INTERVAL_MS * 4) });
      lastStatus = response.status;
      await response.arrayBuffer();
      if (response.ok) {
        return { at: Date.now(), status: response.status };
      }
    } catch {
      // Connection refused or timed out: the server is not listening yet.
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return { at: Date.now(), status: lastStatus };
};

const runIteration = async (iteration: number, debugEnabled: boolean): Promise<IterationResult> => {
  await rm(viteCacheDirectory, { force: true, recursive: true });
  const startedAt = Date.now();
  const lines: string[] = [];
  const child = Bun.spawn(
    ['bun', '--no-env-file', '--bun', 'vite', '--host', HOST, '--port', String(PORT), '--strictPort'],
    {
      cwd: webDirectory,
      env: {
        AI_USAGE_SVELTEKIT_PHASE: 'dev',
        AI_USAGE_SVELTEKIT_PRIVATE_E2E_OVERRIDES: '1',
        BROWSER: 'none',
        ...(debugEnabled ? { DEBUG: 'vite:*' } : {}),
        NO_COLOR: '1',
        PATH: process.env.PATH ?? '',
        TZ: 'UTC',
        VITE_AI_USAGE_E2E: '1',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const drain = async (stream: ReadableStream<Uint8Array>, label: 'stdout' | 'stderr'): Promise<void> => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) {
        lines.push(`${String(Date.now() - startedAt).padStart(6)}ms ${label} ${part}`);
      }
    }
    if (pending.length > 0) {
      lines.push(`${String(Date.now() - startedAt).padStart(6)}ms ${label} ${pending}`);
    }
  };
  const drained = Promise.all([drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr')]);

  const { at, status } = await pollUntilResponse(startedAt + READINESS_DEADLINE_MS);
  const elapsedMs = at - startedAt;
  let outcome: IterationResult['outcome'] = 'hang';
  if (status !== undefined) {
    outcome = status >= 200 && status < 400 ? 'ready' : `http-${status}`;
  }

  child.kill('SIGTERM');
  const forceKill = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_AFTER_MS);
  await child.exited;
  clearTimeout(forceKill);
  await drained;

  const debugSuffix = debugEnabled ? 'debug' : 'nodebug';
  const logFile = path.join(
    logDirectory,
    `iteration-${String(iteration).padStart(3, '0')}-${debugSuffix}-${outcome}.log`,
  );
  await writeFile(logFile, `${lines.join('\n')}\n`, 'utf8');
  return { debugEnabled, elapsedMs, iteration, outcome };
};

const { debug, iterations } = parseOptions(process.argv.slice(2));
await rm(logDirectory, { force: true, recursive: true });
await mkdir(logDirectory, { recursive: true });

const results: IterationResult[] = [];
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const debugEnabled = debug === 'alternate' ? iteration % 2 === 0 : debug === '1';
  const result = await runIteration(iteration, debugEnabled);
  results.push(result);
  console.log(
    `iteration ${result.iteration}/${iterations} (${debugEnabled ? 'debug' : 'no debug'}): ${result.outcome} in ${result.elapsedMs}ms`,
  );
}

const hangs = results.filter((result) => result.outcome !== 'ready');
await writeFile(
  path.join(logDirectory, 'summary.json'),
  `${JSON.stringify({ iterations, results }, null, 2)}\n`,
  'utf8',
);
console.log(`\n${hangs.length}/${iterations} starts did not become ready. Logs: ${logDirectory}`);
