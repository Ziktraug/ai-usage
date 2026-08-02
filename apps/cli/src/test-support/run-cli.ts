import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface CliRunResult {
  exitCode: number;
  signalCode: string | null;
  stderr: string;
  stdout: string;
}

export interface CliRunOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly interrupt?: {
    readonly afterMs: number;
    readonly signal: Extract<NodeJS.Signals, 'SIGINT' | 'SIGTERM'>;
  };
}

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
      env: {
        ...environment,
        ...options.env,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const interrupt = options.interrupt
      ? setTimeout(() => child.kill(options.interrupt?.signal), options.interrupt.afterMs)
      : undefined;
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, signalCode: child.signalCode, stderr, stdout };
    } finally {
      clearTimeout(timeout);
      if (interrupt !== undefined) {
        clearTimeout(interrupt);
      }
    }
  };
  try {
    return await run({ environment, root, runCli });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};
