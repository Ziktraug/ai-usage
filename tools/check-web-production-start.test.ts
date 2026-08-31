import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import path from 'node:path';
import {
  assertSyntheticSkillsProductionPrivacy,
  SKILLS_PRODUCTION_SMOKE_PATH,
  withOwnedProcess,
} from './check-web-production-start';

const DELAYED_RUNTIME_CLEANUP_MS = 75;
const SHORT_GRACEFUL_SHUTDOWN_MS = 100;

test('uses the canonical Skills worktable route for the production smoke', () => {
  expect(SKILLS_PRODUCTION_SMOKE_PATH).toBe('/skills');
});

test('rejects synthetic private paths in the canonical Skills HTML', () => {
  expect(() =>
    assertSyntheticSkillsProductionPrivacy('<div data-skills-workspace></div>', ['/synthetic/private']),
  ).not.toThrow();
  expect(() =>
    assertSyntheticSkillsProductionPrivacy('<div>/synthetic/private/project</div>', ['/synthetic/private']),
  ).toThrow('/skills embedded synthetic private data in its initial HTML.');
});

const reservePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to reserve test port.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

test('cleans up the owned listener and drains its pipes after an assertion failure', async () => {
  const port = await reservePort();
  let childPid = 0;
  await expect(
    withOwnedProcess(
      {
        command: [
          process.execPath,
          path.join(import.meta.dir, 'fixtures', 'production-smoke-listener.mjs'),
          String(port),
        ],
        cwd: import.meta.dir,
        deadlines: { forceExitMs: 500, gracefulShutdownMs: 1000, logDrainMs: 500 },
        env: { PATH: process.env.PATH ?? '', PORT: String(port) },
        port,
      },
      async (child, logs) => {
        childPid = child.pid;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}`);
            if ((await response.text()) === 'fixture-ready') {
              expect(logs.stdout).toContain('listening');
              expect(logs.stderr).toContain('fixture diagnostic');
              throw new Error('deliberate HTTP assertion failure');
            }
          } catch (error) {
            if (error instanceof Error && error.message === 'deliberate HTTP assertion failure') {
              throw error;
            }
          }
          await Bun.sleep(10);
        }
        throw new Error('fixture did not listen');
      },
    ),
  ).rejects.toThrow('deliberate HTTP assertion failure');

  expect(childPid).toBeGreaterThan(0);
  expect(() => process.kill(childPid, 0)).toThrow();
});

test('waits for detached runtime cleanup within the existing graceful deadline', async () => {
  const port = await reservePort();
  let cleanupComplete = false;
  let cleanupChecks = 0;

  await withOwnedProcess(
    {
      command: [
        process.execPath,
        path.join(import.meta.dir, 'fixtures', 'production-smoke-listener.mjs'),
        String(port),
      ],
      cwd: import.meta.dir,
      deadlines: { forceExitMs: 500, gracefulShutdownMs: 1000, logDrainMs: 500 },
      env: { PATH: process.env.PATH ?? '', PORT: String(port) },
      port,
      isShutdownComplete: () => {
        cleanupChecks += 1;
        return Promise.resolve(cleanupComplete);
      },
    },
    () => {
      setTimeout(() => {
        cleanupComplete = true;
      }, DELAYED_RUNTIME_CLEANUP_MS);
      return Promise.resolve();
    },
  );

  expect(cleanupComplete).toBe(true);
  expect(cleanupChecks).toBeGreaterThan(1);
});

test('rejects detached runtime cleanup that misses the graceful deadline', async () => {
  const port = await reservePort();
  await expect(
    withOwnedProcess(
      {
        command: [
          process.execPath,
          path.join(import.meta.dir, 'fixtures', 'production-smoke-listener.mjs'),
          String(port),
        ],
        cwd: import.meta.dir,
        deadlines: {
          forceExitMs: 500,
          gracefulShutdownMs: SHORT_GRACEFUL_SHUTDOWN_MS,
          logDrainMs: 500,
        },
        env: { PATH: process.env.PATH ?? '', PORT: String(port) },
        isShutdownComplete: () => Promise.resolve(false),
        port,
      },
      () => Promise.resolve(),
    ),
  ).rejects.toThrow('Owned process cleanup did not converge before its graceful shutdown deadline.');
});

test('preserves verification and detached cleanup failures in one aggregate error', async () => {
  const port = await reservePort();
  let caughtError: unknown;
  try {
    await withOwnedProcess(
      {
        command: [
          process.execPath,
          path.join(import.meta.dir, 'fixtures', 'production-smoke-listener.mjs'),
          String(port),
        ],
        cwd: import.meta.dir,
        deadlines: {
          forceExitMs: 500,
          gracefulShutdownMs: SHORT_GRACEFUL_SHUTDOWN_MS,
          logDrainMs: 500,
        },
        env: { PATH: process.env.PATH ?? '', PORT: String(port) },
        isShutdownComplete: () => Promise.resolve(false),
        port,
      },
      () => Promise.reject(new Error('deliberate verification failure')),
    );
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(AggregateError);
  if (!(caughtError instanceof AggregateError)) {
    throw new Error('Expected process verification and cleanup to reject with AggregateError');
  }
  expect(caughtError.message).toBe('Process verification and cleanup both failed.');
  expect(caughtError.errors.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual([
    'deliberate verification failure',
    'Owned process cleanup did not converge before its graceful shutdown deadline.',
  ]);
});
