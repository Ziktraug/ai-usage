import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import {
  createWebClientModuleManifest,
  webClientModuleManifest,
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
          dynamicImports: [],
          fileName: 'assets/z.js',
          imports: [],
          moduleIds: [secondModule, firstModule],
          modules: { [firstModule]: {}, [secondModule]: {} },
          type: 'chunk',
        },
        'a.js': {
          dynamicImports: [],
          fileName: 'assets/a.js',
          imports: [],
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
          dynamicImports: [],
          fileName: 'assets/a.js',
          imports: [],
          moduleIds: ['./src/routes/+page.svelte'],
          modules: ['./src/routes/+page.svelte'],
          renderedDynamicImports: [],
        },
        {
          dynamicImports: [],
          fileName: 'assets/z.js',
          imports: [],
          moduleIds: ['./src/lib/rpc/client.ts', './src/routes/+page.svelte'],
          modules: ['./src/lib/rpc/client.ts', './src/routes/+page.svelte'],
          renderedDynamicImports: [],
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
          dynamicImports: [],
          fileName: 'assets/entry.js',
          imports: [],
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
            dynamicImports: [],
            fileName: 'assets/entry.js',
            imports: [],
            moduleIds: [moduleFile],
            modules: { [moduleFile]: {} },
            type: 'chunk',
          },
        },
        root,
      ),
    );
  });

  test('captures and rejects static and dynamic externals from the declared Vite build', async () => {
    const root = await createTemporaryDirectory();
    const entryFile = path.join(root, 'entry.ts');
    const manifestFile = path.join(root, '.private', 'client-modules.json');
    await writeFile(entryFile, "import 'fs';\nvoid import('path');\nvoid import('@orpc/server');\n", 'utf8');

    await build({
      build: {
        emptyOutDir: false,
        outDir: path.join(root, 'public-build'),
        rollupOptions: {
          external: ['fs', 'path', '@orpc/server'],
          input: entryFile,
        },
      },
      configFile: false,
      logLevel: 'silent',
      plugins: [webClientModuleManifest({ manifestFile })],
      root,
    });

    const manifest = await readFile(manifestFile, 'utf8');
    expect(manifest).toContain('"imports": [\n        "fs"');
    expect(manifest).toContain('"renderedDynamicImports": [\n        "@orpc/server",\n        "path"');

    const scanner = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        path.resolve(import.meta.dir, '../../tools/check-web-client-manifest.ts'),
        manifestFile,
      ],
      {
        cwd: root,
        env: {
          HOME: root,
          NO_COLOR: '1',
          PATH: process.env.PATH ?? '',
          TMPDIR: root,
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([scanner.exited, new Response(scanner.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('fs (node builtin)');
    expect(stderr).toContain('path (node builtin)');
    expect(stderr).toContain('@orpc/server (@orpc/server)');
  });
});
