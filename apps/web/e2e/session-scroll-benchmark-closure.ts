import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const LEADING_SLASH_PATTERN = /^\/+/;

interface ClientManifestEntry {
  readonly css?: readonly string[];
  readonly file: string;
  readonly imports?: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalStringArray = (value: unknown, label: string): readonly string[] | undefined => {
  if (value === undefined) {
    return;
  }
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
    throw new Error(`Expected ${label} to be an array of strings`);
  }
  return value;
};

const parseClientManifest = (value: unknown): ReadonlyMap<string, ClientManifestEntry> => {
  if (!isRecord(value)) {
    throw new Error('Expected the SvelteKit client manifest to be an object');
  }
  const entries = new Map<string, ClientManifestEntry>();
  for (const [key, candidate] of Object.entries(value)) {
    if (!(isRecord(candidate) && typeof candidate.file === 'string')) {
      throw new Error(`Expected the SvelteKit client manifest entry ${key} to expose a file`);
    }
    const css = optionalStringArray(candidate.css, `${key}.css`);
    const imports = optionalStringArray(candidate.imports, `${key}.imports`);
    entries.set(key, {
      ...(css === undefined ? {} : { css }),
      file: candidate.file,
      ...(imports === undefined ? {} : { imports }),
    });
  }
  return entries;
};

export interface InitialStaticClosureBytes {
  readonly assetCount: number;
  readonly brotliBytes: number;
  readonly gzipBytes: number;
  readonly rawBytes: number;
}

const initialAssetPaths = (appDir: string): string[] => {
  const manifestPath = path.join(appDir, '.svelte-kit/build/output/client/.vite/manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Expected the SvelteKit client manifest at ${manifestPath}`);
  }
  const parsedManifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifest = parseClientManifest(parsedManifest);
  const pending = [
    '../../node_modules/@sveltejs/kit/src/runtime/client/entry.js',
    '.svelte-kit/build/generated/client-optimized/app.js',
    '.svelte-kit/build/generated/client-optimized/nodes/0.js',
    '.svelte-kit/build/generated/client-optimized/nodes/3.js',
  ];
  const visited = new Set<string>();
  const assets = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop();
    if (!key || visited.has(key)) {
      continue;
    }
    visited.add(key);
    const entry = manifest.get(key);
    if (!entry) {
      throw new Error(`Expected the SvelteKit client manifest to include ${key}`);
    }
    assets.add(entry.file);
    for (const css of entry.css ?? []) {
      assets.add(css);
    }
    pending.push(...(entry.imports ?? []));
  }
  return [...assets].sort();
};

const readInitialAsset = (publicDir: string, assetPath: string): Buffer => {
  const assetFile = path.join(publicDir, assetPath.replace(LEADING_SLASH_PATTERN, ''));
  if (!existsSync(assetFile)) {
    throw new Error(`Expected the initial client asset to exist: ${assetPath}`);
  }
  return readFileSync(assetFile);
};

export const measureInitialStaticClosureBytes = (
  appDir = path.resolve(import.meta.dirname, '..'),
): InitialStaticClosureBytes => {
  const publicDir = path.join(appDir, '.output-build/sveltekit/client');
  const rootAssets = initialAssetPaths(appDir);
  let rawBytes = 0;
  let gzipBytes = 0;
  let brotliBytes = 0;
  for (const assetPath of rootAssets) {
    const body = readInitialAsset(publicDir, assetPath);
    rawBytes += body.byteLength;
    gzipBytes += gzipSync(body, { level: 9 }).byteLength;
    brotliBytes += brotliCompressSync(body).byteLength;
  }
  return {
    assetCount: rootAssets.length,
    brotliBytes,
    gzipBytes,
    rawBytes,
  };
};
