const viteProcess = Bun.spawn({
  cmd: ['bun', '--no-env-file', '--bun', 'vite', 'build'],
  cwd: import.meta.dir,
  env: { ...process.env, AI_USAGE_SVELTEKIT_PHASE: 'build' },
  stderr: 'inherit',
  stdin: 'inherit',
  stdout: 'inherit',
});
const exitCode = await viteProcess.exited;

if (exitCode !== 0) {
  throw new Error(`SvelteKit production Vite build failed with exit code ${exitCode}.`);
}
