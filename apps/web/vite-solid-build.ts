import path from 'node:path';
import { fileURLToPath } from 'node:url';

const viteModulePath = fileURLToPath(import.meta.resolve('vite-solid'));
const viteCliPath = path.resolve(path.dirname(viteModulePath), '../../bin/vite.js');
const viteProcess = Bun.spawn({
  cmd: [process.execPath, '--no-env-file', viteCliPath, 'build'],
  cwd: import.meta.dir,
  stderr: 'inherit',
  stdin: 'inherit',
  stdout: 'inherit',
});
const exitCode = await viteProcess.exited;

if (exitCode !== 0) {
  throw new Error(`Solid production Vite build failed with exit code ${exitCode}.`);
}
