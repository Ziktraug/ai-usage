import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface CliRunResult {
  exitCode: number;
  signalCode: NodeJS.Signals | number | null;
  stderr: string;
  stdout: string;
}

export interface RunningCli {
  readonly exited: Promise<number>;
  readonly pid: number;
}

export interface CliInterruption {
  readonly signal: Extract<NodeJS.Signals, 'SIGINT' | 'SIGTERM'>;
  /**
   * `cli` (the default) signals the CLI process alone. `process-group` starts the CLI as the
   * leader of its own process group and signals the whole group, as a terminal does on Ctrl-C:
   * every process the CLI left in its group receives the signal alongside it.
   */
  readonly target?: 'cli' | 'process-group';
  /**
   * Resolves once the running CLI has reached the state the test interrupts, and rejects when it
   * cannot. The signal is sent only after it resolves, so the interruption follows an observed state
   * rather than elapsed time.
   */
  readonly when: (cli: RunningCli) => Promise<void>;
}

export interface CliRunOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly interrupt?: CliInterruption;
}

type InterruptionOutcome = { readonly error: unknown; readonly ok: false } | { readonly ok: true };

const interruptWhenReached = async (
  child: { readonly kill: (signal: NodeJS.Signals) => void } & RunningCli,
  interruption: CliInterruption,
): Promise<InterruptionOutcome> => {
  try {
    await interruption.when({ exited: child.exited, pid: child.pid });
  } catch (error) {
    // The awaited state never arrived. Stop the CLI through its own graceful shutdown so a failing
    // test does not strand a foreground engine, then report why.
    child.kill('SIGTERM');
    return { error, ok: false };
  }
  if (interruption.target === 'process-group') {
    // The CLI was spawned detached, so it leads its own group and the test runner is outside it.
    process.kill(-child.pid, interruption.signal);
  } else {
    child.kill(interruption.signal);
  }
  return { ok: true };
};

const cliRoot = path.resolve(import.meta.dir, '../..');

const processEnvironment = (): Record<string, string> => {
  const names = process.platform === 'win32' ? ['ComSpec', 'PATH', 'PATHEXT', 'SystemRoot'] : ['PATH'];
  return Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));
};

export const withCliSandbox = async <Value>(
  run: (input: {
    environment: Readonly<Record<string, string>>;
    root: string;
    runCli: (argv: string[], options?: CliRunOptions) => Promise<CliRunResult>;
  }) => Promise<Value>,
): Promise<Value> => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan052-cli-'));
  const profile = path.join(root, 'profile');
  await Promise.all([
    mkdir(profile, { mode: 0o700, recursive: true }),
    mkdir(path.join(root, 'tmp'), { mode: 0o700, recursive: true }),
  ]);
  const temporaryRoot = path.join(root, 'tmp');
  const environment = {
    ...processEnvironment(),
    AI_USAGE_DATABASE_PATH: path.join(root, 'store', 'usage.sqlite'),
    AI_USAGE_ENGINE_STATE_DIR: path.join(root, 'state'),
    AI_USAGE_HOME: profile,
    AI_USAGE_LOG_DIR: path.join(root, 'logs'),
    AI_USAGE_ROOT_DIR: root,
    AI_USAGE_TEMP_ROOT: temporaryRoot,
    APPDATA: profile,
    CODEX_HOME: path.join(profile, '.codex'),
    HOME: profile,
    LOCALAPPDATA: profile,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    USERPROFILE: profile,
    XDG_CACHE_HOME: path.join(profile, '.cache'),
    XDG_CONFIG_HOME: path.join(profile, '.config'),
    XDG_DATA_HOME: path.join(profile, '.local', 'share'),
    XDG_STATE_HOME: path.join(profile, '.local', 'state'),
  };
  const runCli = async (argv: string[], options: CliRunOptions = {}): Promise<CliRunResult> => {
    const child = Bun.spawn(['bun', path.join(cliRoot, 'src', 'main.ts'), ...argv], {
      cwd: root,
      detached: options.interrupt?.target === 'process-group',
      env: {
        ...environment,
        ...options.env,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const interruption = options.interrupt === undefined ? undefined : interruptWhenReached(child, options.interrupt);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const interruptionOutcome = await interruption;
      if (interruptionOutcome?.ok === false) {
        const { error } = interruptionOutcome;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`The CLI was not interrupted (exit ${exitCode}): ${reason}\nstderr: ${stderr}`, {
          cause: error,
        });
      }
      return { exitCode, signalCode: child.signalCode, stderr, stdout };
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    return await run({ environment, root, runCli });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};
