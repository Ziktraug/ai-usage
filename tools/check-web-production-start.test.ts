import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import path from 'node:path';
import {
  assertSyntheticSkillsProductionPrivacy,
  parseProcfsListeningAddresses,
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

test('reads the local address of each socket listening on a port from the procfs TCP tables', () => {
  const ipv4 = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:BB80 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0',
    '   1: 00000000:BB80 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0 100 0 0 10 0',
    // Established, not listening, on the same port.
    '   2: 0100007F:BB80 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0 20 4 30 10 -1',
    // Listening on another port.
    '   3: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4 1 0 100 0 0 10 0',
    '',
  ].join('\n');
  const ipv6 = [
    '  sl  local_address                         remote_address                        st tx_queue rx_queue',
    '   0: 00000000000000000000000000000000:BB80 00000000000000000000000000000000:0000 0A 00000000:00000000',
    '',
  ].join('\n');

  expect(parseProcfsListeningAddresses(ipv4, 48_000)).toEqual(['127.0.0.1', '0.0.0.0']);
  expect(parseProcfsListeningAddresses(ipv6, 48_000)).toEqual(['ipv6:00000000000000000000000000000000']);
  expect(parseProcfsListeningAddresses(ipv4, 1)).toEqual([]);
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
