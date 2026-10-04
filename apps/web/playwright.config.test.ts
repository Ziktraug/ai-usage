import { expect, test } from 'bun:test';

const READ_SERVER_REUSE = `
  import config from './playwright.config.ts';
  const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
  process.stdout.write(String(webServer?.reuseExistingServer));
`;

test('owns the functional server even outside CI', async () => {
  const child = Bun.spawn(['bun', '-e', READ_SERVER_REUSE], {
    cwd: import.meta.dir,
    env: { ...process.env, CI: '' },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);

  expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: '', stdout: 'false' });
});

test('waits for the strict Vite listener without racing an early HTTP probe', async () => {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `
        import config from './playwright.config.ts';
        const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
        const ready = server?.wait?.stdout;
        process.stdout.write(JSON.stringify({
          hasEarlyNetworkProbe: server?.url !== undefined || server?.port !== undefined,
          acceptsOwnedListener: ready?.test('  ➜  Local:   http://127.0.0.1:4174/'),
          acceptsOtherPort: ready?.test('  ➜  Local:   http://127.0.0.1:41740/'),
          acceptsOtherHost: ready?.test('  ➜  Local:   http://0.0.0.0:4174/'),
          acceptsInitialization: ready?.test('VITE v8.2.0 initializing'),
          stdout: server?.stdout,
          timeout: server?.timeout,
          gracefulShutdown: server?.gracefulShutdown,
        }));
      `,
    ],
    { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({
    acceptsInitialization: false,
    acceptsOtherHost: false,
    acceptsOtherPort: false,
    acceptsOwnedListener: true,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 8000 },
    hasEarlyNetworkProbe: false,
    stdout: 'pipe',
    timeout: 20_000,
  });
});
