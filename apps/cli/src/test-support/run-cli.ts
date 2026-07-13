import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface CliRunResult {
  exitCode: number;
  signalCode: string | null;
  stderr: string;
  stdout: string;
}

const cliRoot = path.resolve(import.meta.dir, '../..');

const processEnvironment = (): Record<string, string> => {
  const names = process.platform === 'win32' ? ['ComSpec', 'PATH', 'PATHEXT', 'SystemRoot'] : ['PATH'];
  return Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));
};

export const withCliSandbox = async <Value>(
  run: (input: { root: string; runCli: (argv: string[]) => Promise<CliRunResult> }) => Promise<Value>,
): Promise<Value> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-cli-'));
  const profile = path.join(root, 'profile');
  const runCli = async (argv: string[]): Promise<CliRunResult> => {
    const child = Bun.spawn(['bun', path.join(cliRoot, 'src', 'main.ts'), ...argv], {
      cwd: root,
      env: {
        ...processEnvironment(),
        APPDATA: profile,
        HOME: profile,
        LOCALAPPDATA: profile,
        TEMP: path.join(root, 'tmp'),
        TMP: path.join(root, 'tmp'),
        USERPROFILE: profile,
        XDG_CACHE_HOME: path.join(profile, '.cache'),
        XDG_CONFIG_HOME: path.join(profile, '.config'),
        XDG_DATA_HOME: path.join(profile, '.local', 'share'),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 20_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, signalCode: child.signalCode, stderr, stdout };
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    return await run({ root, runCli });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};
