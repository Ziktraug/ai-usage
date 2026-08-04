import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkWebRetiredStack,
  isTrackedWebProductionSource,
  scanBunLockfile,
  scanEmittedWebOutput,
  scanPackageManifest,
  scanWebProductionSource,
} from './check-web-retired-stack';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('Web retired-stack scanner', () => {
  test.each([
    ['direct import', "import { createRouter } from '@tanstack/solid-router';", 'TanStack Solid adapter'],
    ['re-export', "export { createSignal } from 'solid-js';", 'Solid runtime'],
    ['dynamic import', "const legacy = import('nitro/runtime');", 'Nitro package'],
    ['CommonJS import', "const icons = require('lucide-solid/icons');", 'Solid icon package'],
    ['server-only import', "import start from '@tanstack/start-server-core';", 'TanStack Start package'],
    ['constant backtick dynamic import', 'const legacy = import(`solid-js/web`);', 'Solid runtime'],
    ['require.resolve edge', 'const legacy = require.resolve(`@ark-ui/solid`);', 'Ark Solid package'],
  ])('rejects a %s in production source', (_scenario, source, rule) => {
    expect(scanWebProductionSource('apps/web/src/server/example.server.ts', source)).toContainEqual(
      expect.objectContaining({ rule, surface: 'source-import' }),
    );
  });

  test('rejects interpolated module edges because their dependency closure is not statically provable', () => {
    const interpolationStart = '${';
    const source = `const legacy = import(\`solid-${interpolationStart}runtimeName === 'server' ? 'js' : 'json'}\`);`;

    expect(scanWebProductionSource('apps/web/src/server/example.server.ts', source)).toContainEqual(
      expect.objectContaining({ rule: 'interpolated module edge', surface: 'source-import' }),
    );
  });

  test('intentionally rejects retired references in production comments', () => {
    const source = "// Removed code used import('solid-js');";

    expect(scanWebProductionSource('apps/web/src/server/example.server.ts', source)).toContainEqual(
      expect.objectContaining({ rule: 'Solid runtime', surface: 'source-import' }),
    );
  });

  test.each([
    ['createServerFn', 'export const load = createServerFn({ method: "GET" });', 'createServerFn wrapper'],
    ['_serverFn', 'const route = "/_serverFn/report";', '_serverFn route'],
    ['warmup', 'const warmup = async () => undefined;', 'server-function warmup'],
    ['Nitro runner', 'const runner = "nitro-loopback.browser.ts";', 'Nitro runner workaround'],
  ])('rejects the retired %s marker', (_scenario, source, rule) => {
    expect(scanWebProductionSource('apps/web/src/server/example.server.ts', source)).toContainEqual(
      expect.objectContaining({ rule, surface: 'source-marker' }),
    );
  });

  test('rejects retired dependency entries without rejecting current Svelte adapters', () => {
    const manifest = JSON.stringify(
      {
        dependencies: {
          '@tanstack/solid-table': '8.21.3',
          '@tanstack/svelte-query': '6.1.38',
          '@tanstack/table-core': '8.21.3',
        },
        devDependencies: { 'vite-plugin-solid': '2.11.12' },
      },
      null,
      2,
    );

    expect(scanPackageManifest('apps/web/package.json', manifest)).toEqual([
      expect.objectContaining({ rule: 'TanStack Solid adapter', value: 'dependencies:@tanstack/solid-table' }),
      expect.objectContaining({ rule: 'Solid Vite package', value: 'devDependencies:vite-plugin-solid' }),
    ]);
  });

  test('rejects retired packages retained only in bun.lock', () => {
    const lockfile = '[packages]\n"solid-js": ["solid-js@1.9.13"]\n"@tanstack/router-core": ["1.0.0"]\n';

    expect(scanBunLockfile('bun.lock', lockfile)).toEqual([
      expect.objectContaining({ rule: 'Solid runtime', value: 'solid-js' }),
      expect.objectContaining({ rule: 'TanStack Router package', value: '@tanstack/router-core' }),
    ]);
  });

  test('rejects retired packages and server-function markers in emitted server or client output', () => {
    const emitted = [
      'import "@ark-ui/solid";',
      '//# sourceMappingURL=/node_modules/@tanstack/start-client-core/index.js',
      'const endpoint = "/_serverFn/report";',
    ].join('\n');

    expect(scanEmittedWebOutput('apps/web/.output-build/sveltekit/server/index.js', emitted)).toEqual([
      expect.objectContaining({ rule: 'TanStack Start package', surface: 'emitted-output' }),
      expect.objectContaining({ rule: 'Ark Solid package', surface: 'emitted-output' }),
      expect.objectContaining({ rule: '_serverFn route', surface: 'emitted-output' }),
    ]);
  });

  test('does not treat longer emitted package names as retired packages', () => {
    const emitted = 'import "solid-json"; import "lucide-solidarity"; import "vite-solidarity";';

    expect(scanEmittedWebOutput('apps/web/.output-build/sveltekit/client/app.js', emitted)).toEqual([]);
  });

  test('limits source scanning to tracked Web production code', () => {
    expect(isTrackedWebProductionSource('apps/web/src/routes/+page.svelte')).toBe(true);
    expect(isTrackedWebProductionSource('apps/web/src/server/load.server.ts')).toBe(true);
    expect(isTrackedWebProductionSource('apps/web/vite.config.ts')).toBe(true);
    expect(isTrackedWebProductionSource('packages/design-system/src/svelte.ts')).toBe(true);
    expect(isTrackedWebProductionSource('apps/web/src/runtime.server.mts')).toBe(true);
    expect(isTrackedWebProductionSource('apps/web/src/runtime.server.cts')).toBe(true);
    expect(isTrackedWebProductionSource('apps/web/src/load.test.ts')).toBe(false);
    expect(isTrackedWebProductionSource('apps/web/e2e/report.spec.ts')).toBe(false);
    expect(isTrackedWebProductionSource('apps/web/migration-parity/shards/x1.parity.ts')).toBe(false);
  });

  test('rejects a retired production TSX file even when it has no package import', () => {
    expect(scanWebProductionSource('apps/web/src/legacy-component.tsx', 'export const Legacy = () => null;')).toEqual([
      expect.objectContaining({ rule: 'retired production TSX source', surface: 'source-marker' }),
    ]);
  });

  test('checks tracked source, manifests, lockfile, and selected emitted output together', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ai-usage-retired-stack-'));
    temporaryDirectories.push(workspaceRoot);
    const sourceFile = 'apps/web/src/server/legacy.server.ts';
    const manifestFile = 'apps/web/package.json';
    const lockfile = 'bun.lock';
    const emittedFile = 'apps/web/.output-build/sveltekit/server/index.js';
    const clientFile = 'apps/web/.output-build/sveltekit/client/app.js';
    for (const relativeFile of [sourceFile, manifestFile, emittedFile, clientFile]) {
      await mkdir(path.dirname(path.join(workspaceRoot, relativeFile)), { recursive: true });
    }
    await writeFile(path.join(workspaceRoot, sourceFile), "export * from '@tanstack/solid-query';\n", 'utf8');
    await writeFile(
      path.join(workspaceRoot, manifestFile),
      JSON.stringify({ devDependencies: { nitro: '3.0.0' } }),
      'utf8',
    );
    await writeFile(path.join(workspaceRoot, lockfile), '"lucide-solid": ["lucide-solid@1.0.0"]\n', 'utf8');
    await writeFile(path.join(workspaceRoot, emittedFile), 'const route = "/_serverFn/report";\n', 'utf8');
    await writeFile(path.join(workspaceRoot, clientFile), 'const framework = "sveltekit";\n', 'utf8');

    const violations = await checkWebRetiredStack(workspaceRoot, {
      requireBuildOutput: true,
      trackedFiles: [sourceFile, manifestFile, lockfile],
    });

    expect(violations.map(({ surface }) => surface)).toEqual([
      'source-import',
      'dependency',
      'lockfile',
      'emitted-output',
    ]);
  });

  test('accepts a clean SvelteKit fixture', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ai-usage-retired-stack-clean-'));
    temporaryDirectories.push(workspaceRoot);
    const sourceFile = 'apps/web/src/routes/+page.svelte';
    const manifestFile = 'apps/web/package.json';
    const lockfile = 'bun.lock';
    const emittedFile = 'apps/web/.output-build/sveltekit/client/app.js';
    const serverFile = 'apps/web/.output-build/sveltekit/server/index.js';
    for (const relativeFile of [sourceFile, manifestFile, emittedFile, serverFile]) {
      await mkdir(path.dirname(path.join(workspaceRoot, relativeFile)), { recursive: true });
    }
    await writeFile(
      path.join(workspaceRoot, sourceFile),
      "import { createQuery } from '@tanstack/svelte-query';\n",
      'utf8',
    );
    await writeFile(
      path.join(workspaceRoot, manifestFile),
      JSON.stringify({ dependencies: { '@tanstack/svelte-query': '6.1.38', '@tanstack/table-core': '8.21.3' } }),
      'utf8',
    );
    await writeFile(
      path.join(workspaceRoot, lockfile),
      '"@tanstack/svelte-query": ["@tanstack/svelte-query@6.1.38"]\n',
      'utf8',
    );
    await writeFile(path.join(workspaceRoot, emittedFile), 'const framework = "sveltekit";\n', 'utf8');
    await writeFile(path.join(workspaceRoot, serverFile), 'const adapter = "bun";\n', 'utf8');

    await expect(
      checkWebRetiredStack(workspaceRoot, {
        requireBuildOutput: true,
        trackedFiles: [sourceFile, manifestFile, lockfile],
      }),
    ).resolves.toEqual([]);
  });

  test.each([
    ['client', 'server'],
    ['server', 'client'],
  ] as const)('fails closed when %s output is missing', async (missingTree, presentTree) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), `ai-usage-retired-stack-missing-${missingTree}-`));
    temporaryDirectories.push(workspaceRoot);
    const emittedFile = `apps/web/.output-build/sveltekit/${presentTree}/index.js`;
    await mkdir(path.dirname(path.join(workspaceRoot, emittedFile)), { recursive: true });
    await writeFile(path.join(workspaceRoot, emittedFile), 'const framework = "sveltekit";\n', 'utf8');

    await expect(checkWebRetiredStack(workspaceRoot, { requireBuildOutput: true, trackedFiles: [] })).rejects.toThrow(
      `${missingTree} output contains no scannable emitted files`,
    );
  });
});
