import { expect, test } from 'bun:test';

const READ_SERVER_REUSE = `
  import config from './playwright.demo.config.ts';
  const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
  process.stdout.write(String(webServer?.reuseExistingServer));
`;

test('owns the demo server even outside CI', async () => {
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
