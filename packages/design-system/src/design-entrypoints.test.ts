import { expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageSourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const packageDirectory = path.resolve(packageSourceDirectory, '..');

test('public design entrypoints keep framework runtimes explicit', async () => {
  const manifest = await Bun.file(path.join(packageDirectory, 'package.json')).json();

  expect(manifest.exports['.']).toEqual({ import: './src/index.ts', types: './src/index.ts' });
  expect(manifest.exports['./solid']).toBeUndefined();
  expect(manifest.exports['./svelte']).toEqual({ import: './src/svelte.ts', types: './src/svelte.ts' });

  const rootSource = await Bun.file(path.join(packageSourceDirectory, 'index.ts')).text();
  expect(rootSource).toBe("export { aiUsagePreset } from './preset';\n");
  expect(await Bun.file(path.join(packageSourceDirectory, 'svelte.ts')).text()).toContain(
    "from './svelte/controls/toggle.svelte'",
  );
  const svelteSource = await Bun.file(path.join(packageSourceDirectory, 'svelte.ts')).text();
  expect(svelteSource).toContain("from './components/chart'");
  for (const name of ['accentFill', 'dimensionSwatch', 'stableSeriesColor']) {
    expect(svelteSource, name).toContain(name);
  }
});

test('Panda scans the aggregate TypeScript and Svelte source surface', async () => {
  const pandaConfig = await Bun.file(path.join(packageDirectory, 'panda.config.ts')).text();
  expect(pandaConfig).toContain("include: ['./src/**/*.{ts,svelte}']");
});
