/**
 * Cold-start the functional-browser dev server repeatedly to catch the known
 * `bun --bun vite` startup hang with full evidence.
 *
 * Each iteration wipes the Vite cache (a fresh CI checkout is always cold),
 * spawns the exact command the Playwright webServer uses, and polls the port
 * until the first HTTP response or the deadline. Output is
 * captured with per-line elapsed timestamps so a hang shows *where* startup
 * stopped, not just that it did. Logs land in .dev-server-stress/ at the repo
 * root (gitignored, uploaded by CI); they must NOT live under
 * apps/web/test-results, because Playwright wipes its outputDir at run start
 * and the playwright mode would delete the harness logs mid-run.
 *
 * `DEBUG=vite:*` is itself a timing perturbation, and the job that hangs runs
 * without it, so by default iterations alternate debug off/on: a hang that only
 * occurs in the no-debug arm identifies a heisenbug, and one with debug carries
 * its own forensics. Force one arm with --debug 0|1.
 *
 * Two modes, because 63 direct spawns across 9 runner VMs reproduced nothing
 * while the real job hung the same morning:
 * - direct: spawn `bun --bun vite` alone, the minimal server-only start.
 * - playwright: run one real spec through `bun --bun playwright test`, which is
 *   the exact production chain -- a second live Bun process (the Playwright
 *   runner) spawns a shell, `bun run dev`, then `bun --bun vite`. The repo's
 *   prior Bun 1.4 investigation recorded the hang as concurrency-dependent, and
 *   this is the concurrency the direct mode lacks.
 *
 * --runner selects the Playwright runner runtime in playwright mode. The repo
 * convention is `bun --bun playwright test` (runner under Bun), which is the
 * reproducing chain; `node` runs the same CLI under Node while the webServer
 * child still uses `bun --bun vite` (SSR needs bun:sqlite). If node reproduces
 * nothing, dropping `--bun` from the test scripts is a version-free fix.
 *
 * Usage: bun tools/stress-web-dev-start.ts [--iterations 15] [--debug 0|1|alternate] [--mode direct|playwright] [--runner bun|node]
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
const PLAYWRIGHT_ITERATION_DEADLINE_MS = 180_000;
const PLAYWRIGHT_SMOKE_SPEC = 'e2e/theme.spec.ts';

const rootDirectory = path.resolve(import.meta.dirname, '..');
const webDirectory = path.join(rootDirectory, 'apps', 'web');
const viteCacheDirectory = path.join(webDirectory, '.svelte-kit', 'dev', 'vite');
const logDirectory = path.join(rootDirectory, '.dev-server-stress');

type DebugMode = '0' | '1' | 'alternate';
type StressMode = 'direct' | 'playwright' | 'wrapped';
type RunnerRuntime = 'bun' | 'node';
type EnvProfile = 'minimal' | 'inherit' | 'color';

interface StressOptions {
  readonly debug: DebugMode;
  readonly envProfile: EnvProfile;
  readonly iterations: number;
  readonly loadWorkers: number;
  readonly mode: StressMode;
  readonly runner: RunnerRuntime;
}

const USAGE =
  'Usage: stress-web-dev-start.ts [--iterations <1-200>] [--debug 0|1|alternate] [--mode direct|playwright|wrapped] [--runner bun|node] [--env-profile minimal|inherit|color] [--load <0-8>]';

const parseOptions = (argumentList: readonly string[]): StressOptions => {
  let debug: DebugMode = 'alternate';
  let iterations = DEFAULT_ITERATIONS;
  let mode: StressMode = 'direct';
  let runner: RunnerRuntime = 'bun';
  let envProfile: EnvProfile = 'minimal';
  let loadWorkers = 0;
  for (let index = 0; index < argumentList.length; index += 2) {
    const flag = argumentList[index];
    const value = argumentList[index + 1];
    if (flag === '--iterations') {
      iterations = Number(value);
    } else if (flag === '--debug' && (value === '0' || value === '1' || value === 'alternate')) {
      debug = value;
    } else if (flag === '--mode' && (value === 'direct' || value === 'playwright' || value === 'wrapped')) {
      mode = value;
    } else if (flag === '--runner' && (value === 'bun' || value === 'node')) {
      runner = value;
    } else if (flag === '--env-profile' && (value === 'minimal' || value === 'inherit' || value === 'color')) {
      envProfile = value;
    } else if (flag === '--load') {
      loadWorkers = Number(value);
    } else {
      throw new Error(USAGE);
    }
  }
  if (!(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 200)) {
    throw new Error(USAGE);
  }
  if (!(Number.isSafeInteger(loadWorkers) && loadWorkers >= 0 && loadWorkers <= 8)) {
    throw new Error(USAGE);
  }
  return { debug, envProfile, iterations, loadWorkers, mode, runner };
};

/**
 * Synthetic CPU contention. During a real e2e start the Playwright runner is
 * collecting tests and launching Chromium beside the server on a two-core
 * runner; the wrapped harness idles, which may be why it hangs at ~4% where
 * the playwright chain hangs at ~35-60%. Busy shells approximate that load.
 */
const spawnLoadWorkers = (count: number): Bun.Subprocess[] =>
  Array.from({ length: count }, () =>
    Bun.spawn(['bash', '-c', 'while :; do :; done'], { stderr: 'ignore', stdout: 'ignore' }),
  );

interface IterationResult {
  readonly debugEnabled: boolean;
  readonly elapsedMs: number;
  readonly iteration: number;
  readonly outcome: 'ready' | 'hang' | `http-${number}` | `exit-${number}`;
}

interface CapturedChild {
  readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  readonly drained: Promise<unknown>;
  readonly lines: string[];
}

const captureChild = (
  command: readonly string[],
  environment: Record<string, string | undefined>,
  startedAt: number,
): CapturedChild => {
  const lines: string[] = [];
  const child = Bun.spawn([...command], {
    cwd: webDirectory,
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  });
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
  return { child, drained, lines };
};

const terminateChild = async (child: Bun.Subprocess): Promise<void> => {
  child.kill('SIGTERM');
  const forceKill = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_AFTER_MS);
  await child.exited;
  clearTimeout(forceKill);
};

const writeIterationLog = async (
  iteration: number,
  debugEnabled: boolean,
  outcome: IterationResult['outcome'],
  lines: readonly string[],
): Promise<void> => {
  const debugSuffix = debugEnabled ? 'debug' : 'nodebug';
  const logFile = path.join(
    logDirectory,
    `iteration-${String(iteration).padStart(3, '0')}-${debugSuffix}-${outcome}.log`,
  );
  await writeFile(logFile, `${lines.join('\n')}\n`, 'utf8');
};

/**
 * The production chain: Playwright (itself under Bun) owns the webServer and
 * runs one real spec. The controlled env of the direct mode cannot apply here
 * -- Playwright needs HOME, the browser path, and CI detection -- so the full
 * environment is inherited and only DEBUG is toggled. A webServer hang
 * surfaces as Playwright's own timeout message, which is the classifier.
 */
const runPlaywrightIteration = async (
  iteration: number,
  debugEnabled: boolean,
  runner: RunnerRuntime,
): Promise<IterationResult> => {
  await rm(viteCacheDirectory, { force: true, recursive: true });
  const startedAt = Date.now();
  const runnerCommand =
    runner === 'node'
      ? ['node', path.join(rootDirectory, 'node_modules', '.bin', 'playwright')]
      : ['bun', '--bun', 'playwright'];
  const { child, drained, lines } = captureChild(
    [...runnerCommand, 'test', PLAYWRIGHT_SMOKE_SPEC, '--workers', '1'],
    { ...process.env, ...(debugEnabled ? { DEBUG: 'vite:*' } : {}) },
    startedAt,
  );
  const deadline = setTimeout(() => child.kill('SIGKILL'), PLAYWRIGHT_ITERATION_DEADLINE_MS);
  const exitCode = await child.exited;
  clearTimeout(deadline);
  await drained;
  const elapsedMs = Date.now() - startedAt;

  let outcome: IterationResult['outcome'] = `exit-${exitCode}`;
  if (exitCode === 0) {
    outcome = 'ready';
  } else if (lines.some((line) => line.includes('Timed out waiting') && line.includes('config.webServer'))) {
    outcome = 'hang';
  }
  await writeIterationLog(iteration, debugEnabled, outcome, lines);
  return { debugEnabled, elapsedMs, iteration, outcome };
};

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

/**
 * The node-runner experiment (22/48 hangs) eliminated the parent's runtime as
 * the trigger, leaving exactly two differences between the never-hanging
 * direct mode and the hanging playwright chain: the `bun run dev` wrapper
 * process (a Bun script-runner that is Vite's direct parent, alive throughout
 * startup) and the full inherited environment. Wrapped mode isolates the
 * wrapper: same minimal env as direct, but through `bun run dev` like the
 * real webServer command. Hangs here indict the wrapper; a clean run indicts
 * the environment.
 */
const runServerIteration = async (
  iteration: number,
  debugEnabled: boolean,
  wrapped: boolean,
  envProfile: EnvProfile,
  loadWorkers: number,
): Promise<IterationResult> => {
  await rm(viteCacheDirectory, { force: true, recursive: true });
  const load = spawnLoadWorkers(loadWorkers);
  const startedAt = Date.now();
  const command = wrapped
    ? ['bun', 'run', 'dev', '--', '--port', String(PORT), '--strictPort']
    : ['bun', '--no-env-file', '--bun', 'vite', '--host', HOST, '--port', String(PORT), '--strictPort'];
  const overrides = {
    AI_USAGE_SVELTEKIT_PHASE: 'dev',
    AI_USAGE_SVELTEKIT_PRIVATE_E2E_OVERRIDES: '1',
    BROWSER: 'none',
    ...(debugEnabled ? { DEBUG: 'vite:*' } : {}),
    TZ: 'UTC',
    VITE_AI_USAGE_E2E: '1',
  };
  // 'inherit' reproduces the Playwright webServer child env: the full process
  // environment plus FORCE_COLOR=1, which Playwright always sets on webServer
  // children (and which is why [WebServer] lines carry ANSI codes in CI logs).
  // It reproduced 2 hangs/40 on the wrapped chain (run 32885776033).
  // 'color' bisects one variable: the minimal env with only FORCE_COLOR added.
  // 'minimal' is the controlled env the never-hanging baselines used.
  let environment: Record<string, string | undefined> = { ...overrides, NO_COLOR: '1', PATH: process.env.PATH ?? '' };
  if (envProfile === 'inherit') {
    environment = { ...process.env, ...overrides, FORCE_COLOR: '1' };
  } else if (envProfile === 'color') {
    environment = { ...overrides, FORCE_COLOR: '1', PATH: process.env.PATH ?? '' };
  }
  const { child, drained, lines } = captureChild(command, environment, startedAt);

  const { at, status } = await pollUntilResponse(startedAt + READINESS_DEADLINE_MS);
  const elapsedMs = at - startedAt;
  let outcome: IterationResult['outcome'] = 'hang';
  if (status !== undefined) {
    outcome = status >= 200 && status < 400 ? 'ready' : `http-${status}`;
  }
  for (const worker of load) {
    worker.kill('SIGKILL');
  }

  await terminateChild(child);
  // A fully wedged Vite never runs its SIGTERM handler and survives the
  // wrapper's death (run 32885776033: two orphaned grandchildren held the
  // pipes open, the unbounded drain never resolved, and both jobs burned to
  // the 20-minute timeout). Bound the drain and shoot any orphan explicitly.
  const drainResult = await Promise.race([
    drained.then(() => 'drained' as const),
    Bun.sleep(10_000).then(() => 'stuck' as const),
  ]);
  if (drainResult === 'stuck') {
    lines.push('harness: pipes still open after kill; killing orphaned vite');
    Bun.spawnSync(['pkill', '-9', '-f', `vite --host ${HOST} --port ${PORT}`]);
    await Promise.race([drained, Bun.sleep(5000)]);
  }
  if (wrapped) {
    // `bun run` forwards SIGTERM to the script child, but give the port time
    // to actually free before the next --strictPort start.
    const portFreeDeadline = Date.now() + FORCE_KILL_AFTER_MS;
    while (Date.now() < portFreeDeadline) {
      try {
        await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(POLL_INTERVAL_MS) });
      } catch {
        break;
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }
  await writeIterationLog(iteration, debugEnabled, outcome, lines);
  return { debugEnabled, elapsedMs, iteration, outcome };
};

const { debug, envProfile, iterations, loadWorkers, mode, runner } = parseOptions(process.argv.slice(2));
await rm(logDirectory, { force: true, recursive: true });
await mkdir(logDirectory, { recursive: true });

const results: IterationResult[] = [];
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const debugEnabled = debug === 'alternate' ? iteration % 2 === 0 : debug === '1';
  const result =
    mode === 'playwright'
      ? await runPlaywrightIteration(iteration, debugEnabled, runner)
      : await runServerIteration(iteration, debugEnabled, mode === 'wrapped', envProfile, loadWorkers);
  results.push(result);
  console.log(
    `iteration ${result.iteration}/${iterations} (${mode}/${runner}/${envProfile}, ${debugEnabled ? 'debug' : 'no debug'}): ${result.outcome} in ${result.elapsedMs}ms`,
  );
}

const hangs = results.filter((result) => result.outcome !== 'ready');
await writeFile(
  path.join(logDirectory, 'summary.json'),
  `${JSON.stringify({ envProfile, iterations, loadWorkers, mode, results, runner }, null, 2)}\n`,
  'utf8',
);
console.log(`\n${hangs.length}/${iterations} starts did not become ready. Logs: ${logDirectory}`);
