/** Local real-data preview. Starts only the web process; never starts a writer. */
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const state = resolve(root, '.agent-memory/dataviz-real-data');
const snapshot = resolve(state, 'snapshot.json');
if (!(await Bun.file(snapshot).exists())) {
  throw new Error(
    'Capture real data first: bun tools/capture-dataviz-prototype.ts (the existing app must serve session details on port 5173).',
  );
}
await mkdir(resolve(state, 'engine'), { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  AI_USAGE_DATABASE_PATH:
    process.env.AI_USAGE_DATABASE_PATH ?? resolve(homedir(), '.config/ai-usage/usage-store.sqlite'),
  AI_USAGE_DATAVIZ_SNAPSHOT: snapshot,
  AI_USAGE_ENGINE_STATE_DIR: resolve(state, 'engine'),
};
for (const command of [
  ['bun', 'run', '--filter', '@ai-usage/design-system', 'build'],
  ['bun', 'run', '--cwd', 'apps/web', 'dev:prepare'],
]) {
  const child = Bun.spawn(command, { cwd: root, env, stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited) {
    throw new Error('Preview preparation failed.');
  }
}
console.log('Dataviz preview: http://127.0.0.1:4178/?variant=parcours');
const child = Bun.spawn(['bun', 'run', '--cwd', 'apps/web', 'dev', '--port', '4178', '--strictPort'], {
  cwd: root,
  env,
  stdout: 'inherit',
  stderr: 'inherit',
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.exitCode = await child.exited;
