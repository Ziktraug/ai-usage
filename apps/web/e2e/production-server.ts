import { rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL,
  seedHarnessHome,
} from '@ai-usage/local-machine/testing/harness-home';
import { CLOCK_EPOCH_ENVIRONMENT_KEY } from './production-clock';
import { SESSION_SCROLL_EXPECTED_COUNT } from './session-scroll-fixture';

const DEFAULT_CODEX_SESSION_COUNT = 205;
const DEFAULT_LISTENER_PORT = '4175';
const SCALE_FIXTURE_ENVIRONMENT_KEY = 'AI_USAGE_SESSION_SCALE_E2E';
const LISTENER_PORT_ENVIRONMENT_KEY = 'AI_USAGE_PRODUCTION_E2E_PORT';
const LISTENER_PORT_PATTERN = /^\d{1,5}$/;
const PRODUCTION_FIXTURE_EPOCH = '2026-07-03T12:00:00.000Z';
const rootDirectory = path.resolve(import.meta.dirname, '../../..');
const productionClockUrl = pathToFileURL(path.join(import.meta.dirname, 'production-clock.ts')).href;
const scaleFixture = process.env[SCALE_FIXTURE_ENVIRONMENT_KEY] === '1';
const listenerPort = process.env[LISTENER_PORT_ENVIRONMENT_KEY] ?? DEFAULT_LISTENER_PORT;

if (!(LISTENER_PORT_PATTERN.test(listenerPort) && Number(listenerPort) <= 65_535)) {
  throw new Error(`${LISTENER_PORT_ENVIRONMENT_KEY} must be a valid TCP port`);
}

const temporaryHome = await realpath(await mkdtemp(path.join(tmpdir(), 'plan052-production-browser-')));
const fixtureBinDirectory = path.join(temporaryHome, 'fixture-bin');
const configDirectory = path.join(temporaryHome, 'config');
const engineStateDirectory = path.join(temporaryHome, 'engine-state');
const logDirectory = path.join(temporaryHome, 'logs');
const temporaryDirectory = path.join(temporaryHome, 'tmp');
const databasePath = path.join(temporaryHome, 'store', 'usage.sqlite');
const machineConfigPath = path.join(temporaryHome, '.config', 'ai-usage', 'machine.json');

const cleanupHome = (): void => {
  rmSync(temporaryHome, { force: true, recursive: true });
};

try {
  await Promise.all(
    [
      fixtureBinDirectory,
      configDirectory,
      engineStateDirectory,
      logDirectory,
      temporaryDirectory,
      path.dirname(databasePath),
      path.dirname(machineConfigPath),
    ].map(async (directory) => await mkdir(directory, { mode: 0o700, recursive: true })),
  );
  const fakeGhPath = path.join(fixtureBinDirectory, 'gh');
  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env bun\nprocess.stderr.write(${JSON.stringify(HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL)});\nprocess.stdout.write(JSON.stringify([{ number: 42, url: "https://github.com/fixture/ai-usage/pull/42" }]));\n`,
  );
  await chmod(fakeGhPath, 0o700);
  await seedHarnessHome(temporaryHome, {
    codexSessionCount: scaleFixture ? SESSION_SCROLL_EXPECTED_COUNT : DEFAULT_CODEX_SESSION_COUNT,
    harnesses: scaleFixture ? ['codex'] : ['claude', 'codex'],
  });
  await writeFile(
    machineConfigPath,
    `${JSON.stringify({ id: 'production-e2e-machine', label: 'Production fixture machine' })}\n`,
    { mode: 0o600 },
  );
  const child = Bun.spawn(['bun', '--no-env-file', 'run', 'start'], {
    cwd: rootDirectory,
    env: {
      AI_USAGE_DATABASE_PATH: databasePath,
      AI_USAGE_ENGINE_PORT: '0',
      AI_USAGE_ENGINE_STATE_DIR: engineStateDirectory,
      AI_USAGE_HOME: temporaryHome,
      AI_USAGE_LOG_DIR: logDirectory,
      AI_USAGE_ROOT_DIR: configDirectory,
      AI_USAGE_TEMP_ROOT: temporaryDirectory,
      [CLOCK_EPOCH_ENVIRONMENT_KEY]: PRODUCTION_FIXTURE_EPOCH,
      HOME: temporaryHome,
      HOST: '127.0.0.1',
      IDLE_TIMEOUT: '45',
      NO_COLOR: '1',
      BUN_OPTIONS: `--preload=${productionClockUrl}`,
      PATH: `${fixtureBinDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      PORT: listenerPort,
      TMPDIR: temporaryDirectory,
      TZ: 'Europe/Paris',
      XDG_CACHE_HOME: path.join(temporaryHome, '.cache'),
      XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
      XDG_DATA_HOME: path.join(temporaryHome, '.local', 'share'),
      ...(process.env.CI === undefined ? {} : { CI: process.env.CI }),
      ...(process.env.AI_USAGE_PERF === undefined ? {} : { AI_USAGE_PERF: process.env.AI_USAGE_PERF }),
    },
    stderr: 'inherit',
    stdout: 'inherit',
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 12_000);
      forceKill.unref();
    }
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const exitCode = await child.exited;
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.exitCode = exitCode;
} finally {
  // The child's exit is awaited above before its HOME is removed. This keeps
  // shutdown from racing revision-registry and SQLite cleanup.
  cleanupHome();
}
