import { rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  HARNESS_FIXTURE_PROVIDER_STDERR_SENTINEL,
  seedHarnessHome,
} from '@ai-usage/local-collectors/test-fixtures/harness-home';
import { SESSION_SCROLL_EXPECTED_COUNT } from './session-scroll-fixture';

const DEFAULT_CODEX_SESSION_COUNT = 205;
const DEFAULT_LISTENER_PORT = '4175';
const SCALE_FIXTURE_ENVIRONMENT_KEY = 'AI_USAGE_SESSION_SCALE_E2E';
const LISTENER_PORT_ENVIRONMENT_KEY = 'AI_USAGE_PRODUCTION_E2E_PORT';
const LISTENER_PORT_PATTERN = /^\d{1,5}$/;
const rootDirectory = path.resolve(import.meta.dirname, '../../..');
const scaleFixture = process.env[SCALE_FIXTURE_ENVIRONMENT_KEY] === '1';
const listenerPort = process.env[LISTENER_PORT_ENVIRONMENT_KEY] ?? DEFAULT_LISTENER_PORT;

if (!(LISTENER_PORT_PATTERN.test(listenerPort) && Number(listenerPort) <= 65_535)) {
  throw new Error(`${LISTENER_PORT_ENVIRONMENT_KEY} must be a valid TCP port`);
}

const temporaryHome = await mkdtemp(path.join(tmpdir(), 'ai-usage-production-browser-'));
const fixtureBinDirectory = path.join(temporaryHome, 'fixture-bin');

const cleanupHome = (): void => {
  rmSync(temporaryHome, { force: true, recursive: true });
};

try {
  await mkdir(fixtureBinDirectory, { recursive: true });
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
  const child = Bun.spawn(['bun', 'run', '--cwd', 'apps/web', 'start'], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      AI_USAGE_ROOT_DIR: rootDirectory,
      HOME: temporaryHome,
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: listenerPort,
      PATH: `${fixtureBinDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      PORT: listenerPort,
      TZ: 'Europe/Paris',
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
      }, 3000);
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
