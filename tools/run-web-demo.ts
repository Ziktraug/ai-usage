import { rmSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DEMO_HOST = '127.0.0.1';
export const DEMO_PORT = 4176;

const rootDirectory = path.resolve(import.meta.dirname, '..');
const webDirectory = path.join(rootDirectory, 'apps', 'web');

export const createDemoEnvironment = (
  temporaryHome: string,
  executablePath: string = process.env.PATH ?? '',
): Record<string, string> => ({
  AI_USAGE_ROOT_DIR: temporaryHome,
  BROWSER: 'none',
  HOME: temporaryHome,
  NITRO_DEV_RUNNER: 'self',
  NO_COLOR: '1',
  PATH: executablePath,
  TMPDIR: path.join(temporaryHome, 'tmp'),
  TZ: 'Europe/Paris',
  VITE_AI_USAGE_DEMO: '1',
  VITE_AI_USAGE_E2E: '0',
  XDG_CACHE_HOME: path.join(temporaryHome, '.cache'),
  XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
  XDG_DATA_HOME: path.join(temporaryHome, '.local', 'share'),
});

export const runWebDemo = async (): Promise<number> => {
  const temporaryHome = await mkdtemp(path.join(tmpdir(), 'ai-usage-demo-'));
  let homeRemoved = false;
  const cleanupHome = (): void => {
    if (homeRemoved) {
      return;
    }
    homeRemoved = true;
    rmSync(temporaryHome, { force: true, recursive: true });
  };
  const environment = createDemoEnvironment(temporaryHome);
  let activeChild: Bun.Subprocess | undefined;
  let forceKillTimer: Timer | undefined;
  let stopping = false;
  const terminateChild = (child: Bun.Subprocess): void => {
    if (child.exitCode !== null) {
      return;
    }
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 3000);
    forceKillTimer.unref();
  };
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (activeChild) {
      terminateChild(activeChild);
    }
  };
  const runOwnedChild = async (command: string[], cwd: string, phase: string): Promise<number> => {
    const child = Bun.spawn(command, {
      cwd,
      env: environment,
      stderr: 'inherit',
      stdout: 'inherit',
    });
    activeChild = child;
    if (stopping) {
      terminateChild(child);
    }
    const exitCode = await child.exited;
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
    if (activeChild === child) {
      activeChild = undefined;
    }
    if (exitCode !== 0 && !stopping) {
      throw new Error(`${phase} failed with exit code ${exitCode}.`);
    }
    return exitCode;
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', cleanupHome);

  try {
    await Promise.all([
      mkdir(environment.TMPDIR, { recursive: true }),
      mkdir(environment.XDG_CACHE_HOME, { recursive: true }),
      mkdir(environment.XDG_CONFIG_HOME, { recursive: true }),
      mkdir(environment.XDG_DATA_HOME, { recursive: true }),
    ]);
    if (stopping) {
      return 0;
    }
    await runOwnedChild(
      ['bun', '--no-env-file', 'run', '--filter', '@ai-usage/design-system', 'build'],
      rootDirectory,
      'Demo design-system preparation',
    );
    if (stopping) {
      return 0;
    }
    await runOwnedChild(
      ['bun', '--no-env-file', 'run', '--cwd', 'apps/web', 'dev:prepare'],
      rootDirectory,
      'Demo web preparation',
    );
    if (stopping) {
      return 0;
    }
    return await runOwnedChild(
      ['bun', '--no-env-file', '--bun', 'vite', '--host', DEMO_HOST, '--port', String(DEMO_PORT), '--strictPort'],
      webDirectory,
      'Demo server',
    );
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    stop();
    if (activeChild?.exitCode === null) {
      await activeChild.exited;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    cleanupHome();
    process.removeListener('exit', cleanupHome);
  }
};

if (import.meta.main) {
  process.exitCode = await runWebDemo();
}
