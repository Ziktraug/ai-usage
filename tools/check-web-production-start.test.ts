import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import path from 'node:path';
import { withOwnedProcess } from './check-web-production-start';

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
        command: ['node', path.join(import.meta.dir, 'fixtures', 'production-smoke-listener.mjs'), String(port)],
        cwd: import.meta.dir,
        deadlines: { forceExitMs: 500, gracefulShutdownMs: 1000, logDrainMs: 500 },
        env: { PATH: process.env.PATH ?? '', PORT: String(port) },
        port,
      },
      async (child) => {
        childPid = child.pid;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}`);
            if ((await response.text()) === 'fixture-ready') {
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
