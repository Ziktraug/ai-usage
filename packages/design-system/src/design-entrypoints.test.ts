import { expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pandaConfig from '../panda.config';

const packageSourceDirectory = fileURLToPath(new URL('.', import.meta.url));

test('public design entrypoints keep framework runtimes explicit', async () => {
  expect(Bun.resolveSync('@ai-usage/design-system', packageSourceDirectory)).toBe(
    path.join(packageSourceDirectory, 'index.ts'),
  );
  expect(Bun.resolveSync('@ai-usage/design-system/svelte', packageSourceDirectory)).toBe(
    path.join(packageSourceDirectory, 'svelte.ts'),
  );
  expect(() => Bun.resolveSync('@ai-usage/design-system/solid', packageSourceDirectory)).toThrow();

  // The root entry is the preset alone: no component, style recipe or framework runtime rides along.
  expect(Object.keys(await import('@ai-usage/design-system'))).toEqual(['aiUsagePreset']);
});

test('the Report entrypoint exposes the executive editorial primitives', async () => {
  const reportModule = await import('./report');

  for (const name of [
    'editorialSection',
    'executiveCaption',
    'executiveEssentialLabel',
    'numericDisplay',
    'sectionDivider',
  ]) {
    expect(reportModule, name).toHaveProperty(name);
  }
});

test('Panda scans the aggregate TypeScript and Svelte source surface', () => {
  expect(pandaConfig.include).toEqual(['./src/**/*.{ts,svelte}']);
});
