import { expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageSourceDirectory = fileURLToPath(new URL('.', import.meta.url));
const packageDirectory = path.resolve(packageSourceDirectory, '..');

const ARK_BACKED_COMPONENT_SUBPATHS = [
  './svelte/cell-with-provenance',
  './svelte/checkbox',
  './svelte/drawer',
  './svelte/harness-badge',
  './svelte/multi-select',
  './svelte/popover',
  './svelte/provenance-marker',
  './svelte/segmented-control',
  './svelte/tabs',
  './svelte/toggle',
  './svelte/tooltip',
] as const;

test('public design entrypoints keep framework runtimes explicit', async () => {
  const manifest = await Bun.file(path.join(packageDirectory, 'package.json')).json();

  expect(manifest.exports['.']).toEqual({ import: './src/index.ts', types: './src/index.ts' });
  expect(manifest.exports['./solid']).toBeUndefined();
  expect(manifest.exports['./svelte']).toEqual({ import: './src/svelte.ts', types: './src/svelte.ts' });
  expect(manifest.exports['./svelte/passive']).toEqual({
    import: './src/svelte-passive.ts',
    types: './src/svelte-passive.ts',
  });
  for (const subpath of ARK_BACKED_COMPONENT_SUBPATHS) {
    expect(manifest.exports[subpath], subpath).toBeDefined();
  }

  const rootSource = await Bun.file(path.join(packageDirectory, 'src/index.ts')).text();
  expect(rootSource).toBe("export { aiUsagePreset } from './preset';\n");
  const svelteSource = await Bun.file(path.join(packageDirectory, 'src/svelte.ts')).text();
  expect(svelteSource).toContain("from './svelte/controls/toggle.svelte'");
  expect(svelteSource).toContain("from './svelte-passive'");
  const passiveSource = await Bun.file(path.join(packageDirectory, 'src/svelte-passive.ts')).text();
  expect(passiveSource).toContain("from './components/chart'");
  for (const name of ['accentFill', 'dimensionSwatch', 'stableSeriesColor']) {
    expect(svelteSource, name).toContain(name);
    expect(passiveSource, name).toContain(name);
  }
});

test('svelte compatibility barrel re-exports the passive surface and every Ark-backed component', async () => {
  const svelteSource = await Bun.file(path.join(packageDirectory, 'src/svelte.ts')).text();

  expect(svelteSource).toContain("from './svelte-passive'");
  for (const component of [
    'MultiSelect',
    'SegmentedControl',
    'Tabs',
    'Checkbox',
    'HarnessBadge',
    'Toggle',
    'Drawer',
    'Popover',
    'ProvenanceMarker',
    'CellWithProvenance',
    'MetricTile',
    'SegmentBar',
  ]) {
    expect(svelteSource, component).toContain(`as ${component}`);
  }
});

test('Panda scans the aggregate TypeScript and Svelte source surface', async () => {
  const pandaConfig = await Bun.file(path.join(packageDirectory, 'panda.config.ts')).text();
  expect(pandaConfig).toContain("include: ['./src/**/*.{ts,svelte}']");
});
