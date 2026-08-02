import { writeFile } from 'node:fs/promises';

const mode = process.argv[2];
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This is direct subprocess fixture input, not a Turbo cache input.
const pidFile = process.env.PLAN052_SUPERVISOR_PID_FILE;

if (mode === 'grandchild') {
  process.on('SIGINT', () => undefined);
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1000);
} else if (mode === 'parent' && pidFile) {
  const grandchild = Bun.spawn([process.execPath, '--no-env-file', import.meta.path, 'grandchild'], {
    stderr: 'ignore',
    stdin: 'ignore',
    stdout: 'ignore',
  });
  await writeFile(pidFile, `${JSON.stringify({ grandchild: grandchild.pid, parent: process.pid })}\n`);
  process.on('SIGINT', () => undefined);
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1000);
} else {
  throw new Error('Production supervisor fixture mode is invalid.');
}
