import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createWebClientModuleManifest,
  webClientModuleManifestFormat,
  webClientModuleManifestVersion,
  writeWebClientModuleManifest,
} from './vite-client-module-manifest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-client-manifest-'));
  temporaryDirectories.push(directory);
  return directory;
};

describe('Web client module manifest plugin', () => {
  test('records complete moduleIds and modules for every chunk deterministically', () => {
    const root = path.resolve('/workspace/apps/web');
    const firstModule = path.join(root, 'src/routes/+page.svelte');
    const secondModule = path.join(root, 'src/lib/rpc/client.ts');
    const manifest = createWebClientModuleManifest(
      {
        'z.js': {
          fileName: 'assets/z.js',
          moduleIds: [secondModule, firstModule],
          modules: { [firstModule]: {}, [secondModule]: {} },
          type: 'chunk',
        },
        'a.js': {
          fileName: 'assets/a.js',
          moduleIds: [firstModule],
          modules: { [firstModule]: {} },
          type: 'chunk',
        },
        'a.css': { type: 'asset' },
      },
      root,
    );

    expect(manifest).toEqual({
      chunks: [
        {
          fileName: 'assets/a.js',
          moduleIds: ['./src/routes/+page.svelte'],
          modules: ['./src/routes/+page.svelte'],
        },
        {
          fileName: 'assets/z.js',
          moduleIds: ['./src/lib/rpc/client.ts', './src/routes/+page.svelte'],
          modules: ['./src/lib/rpc/client.ts', './src/routes/+page.svelte'],
        },
      ],
      format: webClientModuleManifestFormat,
      target: 'client',
      version: webClientModuleManifestVersion,
    });
  });

  test('writes the private manifest to its explicit non-public path', async () => {
    const root = await createTemporaryDirectory();
    const manifestFile = path.join(root, '.svelte-kit', 'build', 'private', 'client-modules.json');
    const moduleFile = path.join(root, 'src/routes/+page.svelte');

    await writeWebClientModuleManifest(
      {
        'entry.js': {
          fileName: 'assets/entry.js',
          moduleIds: [moduleFile],
          modules: { [moduleFile]: {} },
          type: 'chunk',
        },
      },
      root,
      manifestFile,
    );

    expect(JSON.parse(await readFile(manifestFile, 'utf8'))).toEqual(
      createWebClientModuleManifest(
        {
          'entry.js': {
            fileName: 'assets/entry.js',
            moduleIds: [moduleFile],
            modules: { [moduleFile]: {} },
            type: 'chunk',
          },
        },
        root,
      ),
    );
  });
});
