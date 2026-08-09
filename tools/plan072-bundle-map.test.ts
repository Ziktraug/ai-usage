import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'tools/plan072-bundle-map.ts');

interface BundleMapOutput {
  readonly destinationClosures: ReadonlyArray<{ label: string }>;
  readonly duplicatedArkOrZagCount: number;
  readonly initialChunkCount: number;
  readonly initialChunkFileNames: readonly string[];
  readonly initialChunks: ReadonlyArray<{ arkComponents: readonly string[]; fileName: string; isInitial: boolean }>;
  readonly lazyChunkFileNames: readonly string[];
  readonly lazyChunks: ReadonlyArray<{ fileName: string; isInitial: boolean }>;
}

const parseChunk = (value: unknown): BundleMapOutput['initialChunks'][number] => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('arkComponents' in value) ||
    !Array.isArray(value.arkComponents) ||
    !value.arkComponents.every((component) => typeof component === 'string') ||
    !('fileName' in value) ||
    typeof value.fileName !== 'string' ||
    !('isInitial' in value) ||
    typeof value.isInitial !== 'boolean'
  ) {
    throw new Error('Expected a valid bundle-map chunk');
  }
  return { arkComponents: value.arkComponents, fileName: value.fileName, isInitial: value.isInitial };
};

const parseBundleMapOutput = (value: unknown): BundleMapOutput => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('duplicatedArkOrZagCount' in value) ||
    typeof value.duplicatedArkOrZagCount !== 'number' ||
    !('destinationClosures' in value) ||
    !Array.isArray(value.destinationClosures) ||
    !('initialChunkCount' in value) ||
    typeof value.initialChunkCount !== 'number' ||
    !('initialChunkFileNames' in value) ||
    !Array.isArray(value.initialChunkFileNames) ||
    !value.initialChunkFileNames.every((fileName) => typeof fileName === 'string') ||
    !('initialChunks' in value) ||
    !Array.isArray(value.initialChunks) ||
    !('lazyChunkFileNames' in value) ||
    !Array.isArray(value.lazyChunkFileNames) ||
    !value.lazyChunkFileNames.every((fileName) => typeof fileName === 'string') ||
    !('lazyChunks' in value) ||
    !Array.isArray(value.lazyChunks)
  ) {
    throw new Error('Expected a valid bundle-map output');
  }
  return {
    destinationClosures: value.destinationClosures.map((closure) => {
      if (
        typeof closure !== 'object' ||
        closure === null ||
        !('label' in closure) ||
        typeof closure.label !== 'string'
      ) {
        throw new Error('Expected a valid destination closure');
      }
      return { label: closure.label };
    }),
    duplicatedArkOrZagCount: value.duplicatedArkOrZagCount,
    initialChunkCount: value.initialChunkCount,
    initialChunkFileNames: value.initialChunkFileNames,
    initialChunks: value.initialChunks.map(parseChunk),
    lazyChunkFileNames: value.lazyChunkFileNames,
    lazyChunks: value.lazyChunks.map(parseChunk),
  };
};

const writeMinimalManifests = (manifestPath: string, viteManifestPath: string): void => {
  const manifest = {
    chunks: [
      {
        dynamicImports: [],
        fileName: '_app/immutable/entry/start.hash.js',
        imports: ['_app/immutable/chunks/EardQyRL.js'],
        moduleIds: [],
        modules: [],
        renderedDynamicImports: [],
      },
      {
        dynamicImports: [],
        fileName: '_app/immutable/chunks/EardQyRL.js',
        imports: [],
        moduleIds: [
          '../../node_modules/@ark-ui/svelte/dist/components/drawer/drawer-backdrop.svelte',
          '../../node_modules/@ark-ui/svelte/dist/components/popover/popover-root.svelte',
          '../../node_modules/@zag-js/focus-trap/dist/index.js',
          './src/lib/features/sessions/table/session-table.svelte',
        ],
        modules: [],
        renderedDynamicImports: [],
      },
      {
        dynamicImports: [],
        fileName: '_app/immutable/chunks/DrrDGPOk2.js',
        imports: ['_app/immutable/chunks/EardQyRL.js'],
        moduleIds: ['./src/lib/features/sessions/table/session-table.svelte'],
        modules: [],
        renderedDynamicImports: [],
      },
    ],
    format: 'ai-usage-web-client-modules',
    target: 'client',
    version: 2,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  const viteManifest = {
    '../../node_modules/@sveltejs/kit/src/runtime/client/entry.js': {
      file: '_app/immutable/entry/start.hash.js',
      imports: ['shared-runtime'],
    },
    '.svelte-kit/build/generated/client-optimized/app.js': {
      file: '_app/immutable/entry/app.hash.js',
      imports: ['shared-runtime'],
    },
    '.svelte-kit/build/generated/client-optimized/nodes/0.js': {
      file: '_app/immutable/nodes/0.hash.js',
      imports: ['shared-runtime'],
    },
    '.svelte-kit/build/generated/client-optimized/nodes/3.js': {
      file: '_app/immutable/nodes/3.hash.js',
      imports: ['shared-runtime'],
    },
    'shared-runtime': {
      file: '_app/immutable/chunks/EardQyRL.js',
      imports: [],
    },
  };
  writeFileSync(viteManifestPath, JSON.stringify(viteManifest), 'utf8');
};

describe('plan072 bundle-map', () => {
  let tempDirectory: string | null = null;

  beforeEach(() => {
    tempDirectory = mkdtempSync(path.join(tmpdir(), 'plan072-bundle-map-'));
  });

  afterEach(() => {
    if (tempDirectory && existsSync(tempDirectory)) {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test('classifies Ark/Zag in the initial chunk and reports no duplicates', async () => {
    if (!tempDirectory) {
      throw new Error('Expected a temp directory');
    }
    const manifestPath = path.join(tempDirectory, 'client-modules.json');
    const viteManifestPath = path.join(tempDirectory, 'vite-manifest.json');
    const outputJson = path.join(tempDirectory, 'plan072-bundle-map.json');
    const outputMd = path.join(tempDirectory, 'plan072-bundle-map.md');
    const clientOutput = path.join(tempDirectory, 'client');
    writeMinimalManifests(manifestPath, viteManifestPath);
    for (const asset of [
      '_app/immutable/entry/start.hash.js',
      '_app/immutable/entry/app.hash.js',
      '_app/immutable/nodes/0.hash.js',
      '_app/immutable/nodes/3.hash.js',
      '_app/immutable/chunks/EardQyRL.js',
    ]) {
      const assetPath = path.join(clientOutput, asset);
      mkdirSync(path.dirname(assetPath), { recursive: true });
      writeFileSync(assetPath, `fixture:${asset}`, 'utf8');
    }
    const proc = Bun.spawn(['bun', SCRIPT_PATH], {
      cwd: ROOT,
      env: {
        ...process.env,
        AI_USAGE_PLAN072_CLIENT_OUTPUT: clientOutput,
        AI_USAGE_PLAN072_MANIFEST: manifestPath,
        AI_USAGE_PLAN072_OUTPUT_JSON: outputJson,
        AI_USAGE_PLAN072_OUTPUT_MD: outputMd,
        AI_USAGE_PLAN072_VITE_MANIFEST: viteManifestPath,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(existsSync(outputJson)).toBe(true);
    const parsed = parseBundleMapOutput(JSON.parse(readFileSync(outputJson, 'utf8')));
    expect(parsed.duplicatedArkOrZagCount).toBe(0);
    expect(parsed.initialChunkCount).toBe(2);
    expect(parsed.destinationClosures.map((closure) => closure.label)).toEqual([
      'overview',
      'sessions',
      'breakdown',
      'sessions-after-drawer',
    ]);
    expect(parsed.initialChunkFileNames.filter((fileName) => parsed.lazyChunkFileNames.includes(fileName))).toEqual([]);
    expect(parsed.lazyChunks.every((chunk) => !chunk.isInitial)).toBe(true);
    const initialWithArk = parsed.initialChunks.find((entry) => entry.arkComponents.length > 0);
    expect(initialWithArk).toBeDefined();
    expect(initialWithArk?.arkComponents).toContain('drawer');
    expect(initialWithArk?.arkComponents).toContain('popover');
    expect(initialWithArk?.isInitial).toBe(true);
    expect(parsed.lazyChunks).toContainEqual(
      expect.objectContaining({ fileName: '_app/immutable/chunks/DrrDGPOk2.js', isInitial: false }),
    );
    expect(parsed.lazyChunkFileNames).not.toContain('_app/immutable/chunks/EardQyRL.js');
  });
});
