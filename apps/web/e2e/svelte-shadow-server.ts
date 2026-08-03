import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const listenerPort = '4178';
const temporaryRoot = await mkdtemp(join(tmpdir(), 'ai-usage-svelte-shell-'));
const home = join(temporaryRoot, 'home');
const temporaryDirectory = join(temporaryRoot, 'tmp');
const xdgCache = join(temporaryRoot, 'cache');
const xdgConfig = join(temporaryRoot, 'config');
const xdgData = join(temporaryRoot, 'data');
await Promise.all(
  [home, temporaryDirectory, xdgCache, xdgConfig, xdgData].map(async (directory) => {
    await mkdir(directory, { mode: 0o700 });
  }),
);

const artifact = resolve('.output-svelte-shadow/build/index.js');
const child = Bun.spawn({
  cmd: ['bun', '--no-env-file', artifact],
  env: {
    AI_USAGE_SVELTEKIT_SHADOW_PRIVATE_E2E_OVERRIDES: '1',
    HOME: home,
    HOST: '127.0.0.1',
    ORIGIN: `http://127.0.0.1:${listenerPort}`,
    PATH: process.env.PATH ?? '',
    PORT: listenerPort,
    TMPDIR: temporaryDirectory,
    TZ: 'UTC',
    VITE_AI_USAGE_E2E: '1',
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
  },
  stderr: 'inherit',
  stdout: 'inherit',
});

let stopping = false;
const cleanup = async (): Promise<void> => {
  await rm(temporaryRoot, { force: true, recursive: true });
};
const stop = async (signal: NodeJS.Signals): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  child.kill(signal);
  const exitCode = await Promise.race([child.exited, Bun.sleep(7000).then(() => null)]);
  if (exitCode === null) {
    child.kill('SIGKILL');
    await child.exited;
  }
  await cleanup();
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stop(signal)
      .then(() => process.exit(0))
      .catch((cause: unknown) => {
        console.error(cause);
        process.exit(1);
      });
  });
}

const exitCode = await child.exited;
await cleanup();
process.exit(exitCode);
