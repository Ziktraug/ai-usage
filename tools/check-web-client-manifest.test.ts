import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkWebClientModuleManifest,
  parseWebClientModuleManifest,
  scanWebClientModuleManifest,
} from './check-web-client-manifest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const manifestText = (modules: readonly string[]): string =>
  JSON.stringify({
    chunks: [
      {
        dynamicImports: [],
        fileName: 'assets/entry.js',
        imports: [],
        moduleIds: modules,
        modules,
        renderedDynamicImports: [],
      },
    ],
    format: 'ai-usage-web-client-modules',
    target: 'client',
    version: 2,
  });

describe('emitted Web client module manifest scanner', () => {
  test.each([
    ['direct import', 'node:fs', 'node builtin'],
    ['bare Node builtin', 'fs', 'node builtin'],
    ['bare Node builtin subpath', 'fs/promises', 'node builtin'],
    ['bare Node path builtin', 'path', 'node builtin'],
    ['direct Bun import', 'bun:sqlite', 'Bun builtin'],
    ['indirect dependency', '../../node_modules/@orpc/server/dist/index.mjs', '@orpc/server'],
    ['re-exported workspace module', '../../packages/report-data/src/index.ts', 'report-data'],
    ['dynamic workspace import', '../../packages/usage-merge/src/index.ts', 'usage-merge'],
    ['usage store', '../../packages/usage-store/src/reader.ts', 'usage-store'],
    ['local machine', '../../packages/local-machine/src/index.ts', 'local-machine'],
    ['engine runtime', '../../packages/usage-engine-runtime/src/index.ts', 'usage-engine-runtime'],
    ['$lib server alias', '$lib/server/report.ts', '$lib/server'],
    ['resolved server directory', './src/lib/server/report.ts', '$lib/server'],
    ['server module suffix', './src/lib/report.server.ts', '.server module'],
    ['Solid package', '../../node_modules/solid-js/dist/solid.js', 'retired Solid/TanStack module'],
    [
      'TanStack Solid package',
      '../../node_modules/@tanstack/solid-query/dist/index.js',
      'retired Solid/TanStack module',
    ],
    ['Solid Vite package', '../../node_modules/vite-plugin-solid/dist/index.js', 'retired Solid/TanStack module'],
    ['Solid icon package', '../../node_modules/lucide-solid/dist/index.js', 'retired Solid/TanStack module'],
    ['Ark Solid package', '../../node_modules/@ark-ui/solid/dist/index.js', 'retired Solid/TanStack module'],
    ['Nitro package', '../../node_modules/nitro/dist/index.js', 'retired Nitro module'],
    ['Nitro workaround', './src/lib/server/rpc/nitro-loopback.browser.ts', 'retired Nitro module'],
    ['createServerFn wrapper', './src/lib/report-createServerFn.ts', 'retired createServerFn module'],
    ['legacy serverFn route', './src/routes/_serverFn/report.ts', 'retired createServerFn module'],
  ])('rejects a %s present in a client chunk', (_scenario, moduleId, rule) => {
    const manifest = parseWebClientModuleManifest(manifestText([moduleId]));

    expect(scanWebClientModuleManifest(manifest)).toContainEqual({
      chunk: 'assets/entry.js',
      moduleId,
      rule,
    });
  });

  test('accepts a clean Svelte client graph', () => {
    const manifest = parseWebClientModuleManifest(
      manifestText([
        './src/routes/+page.svelte',
        './src/lib/rpc/client.ts',
        './src/path.ts',
        '../../packages/report-core/src/index.ts',
        '../../packages/web-contract/src/contract.ts',
        '../../node_modules/@tanstack/svelte-query/dist/index.js',
      ]),
    );

    expect(scanWebClientModuleManifest(manifest)).toEqual([]);
  });

  test('fails closed when the manifest file is missing', async () => {
    await expect(checkWebClientModuleManifest('/missing/ai-usage-client-manifest.json')).rejects.toThrow(
      'Unable to read the Web client module manifest',
    );
  });

  test('fails closed for malformed JSON and a malformed schema', () => {
    expect(() => parseWebClientModuleManifest('{')).toThrow('not valid JSON');
    expect(() => parseWebClientModuleManifest('{}')).toThrow('format must be');
  });

  test('fails closed for empty and incomplete manifests', () => {
    expect(() =>
      parseWebClientModuleManifest(
        JSON.stringify({
          chunks: [],
          format: 'ai-usage-web-client-modules',
          target: 'client',
          version: 2,
        }),
      ),
    ).toThrow('at least one chunk');
    expect(() => parseWebClientModuleManifest(manifestText([]))).toThrow('must contain moduleIds and modules');
    expect(() =>
      parseWebClientModuleManifest(
        JSON.stringify({
          chunks: [{ fileName: 'assets/entry.js', moduleIds: ['./a.ts'], modules: ['./a.ts'] }],
          format: 'ai-usage-web-client-modules',
          target: 'client',
          version: 2,
        }),
      ),
    ).toThrow('must contain imports and dynamicImports arrays');
    expect(() =>
      parseWebClientModuleManifest(
        JSON.stringify({
          chunks: [
            {
              dynamicImports: [],
              fileName: 'assets/entry.js',
              imports: [],
              moduleIds: ['./a.ts'],
              modules: ['./a.ts'],
            },
          ],
          format: 'ai-usage-web-client-modules',
          target: 'client',
          version: 2,
        }),
      ),
    ).toThrow('must contain a renderedDynamicImports array');
    expect(() =>
      parseWebClientModuleManifest(
        JSON.stringify({
          chunks: [
            {
              dynamicImports: [],
              fileName: 'assets/entry.js',
              imports: [],
              moduleIds: ['./a.ts'],
              modules: ['./b.ts'],
              renderedDynamicImports: [],
            },
          ],
          format: 'ai-usage-web-client-modules',
          target: 'client',
          version: 2,
        }),
      ),
    ).toThrow('incomplete module metadata');
  });

  test('reads and scans a complete manifest from disk', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-client-scanner-'));
    temporaryDirectories.push(directory);
    const manifestFile = path.join(directory, 'client-modules.json');
    await writeFile(manifestFile, manifestText(['./src/routes/+page.svelte']), 'utf8');

    expect(await checkWebClientModuleManifest(manifestFile)).toEqual([]);
  });
});
