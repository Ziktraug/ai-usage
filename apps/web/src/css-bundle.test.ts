import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { $ } from 'bun';

const CLIENT_BUNDLE_BUILD_TIMEOUT_MS = 120_000;
const INITIAL_GZIP_CLOSURE_BASELINE_BYTES = 251_597;
const INITIAL_GZIP_CLOSURE_MAXIMUM_BYTES = Math.ceil(INITIAL_GZIP_CLOSURE_BASELINE_BYTES * 1.1);
const LEADING_SLASH_PATTERN = /^\/+/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const initialAssetPaths = async (appDir: string): Promise<string[]> => {
  const serverDir = path.join(appDir, '.output/server');
  const manifestFile = readdirSync(serverDir).find(
    (file) => file.startsWith('_tanstack-start-manifest_') && file.endsWith('.mjs'),
  );
  if (!manifestFile) {
    throw new Error('Expected the report build to emit one TanStack Start manifest');
  }
  const imported: unknown = await import(pathToFileURL(path.join(serverDir, manifestFile)).href);
  if (!(isRecord(imported) && typeof imported.tsrStartManifest === 'function')) {
    throw new Error('Expected the TanStack Start manifest to export tsrStartManifest');
  }
  const manifest: unknown = imported.tsrStartManifest();
  const routes = isRecord(manifest) && isRecord(manifest.routes) ? manifest.routes : undefined;
  const root = routes && isRecord(routes.__root__) ? routes.__root__ : undefined;
  if (!root) {
    throw new Error('Expected the TanStack Start manifest to describe the root route');
  }
  const paths = [
    ...(Array.isArray(root.css) ? root.css : []),
    ...(Array.isArray(root.preloads) ? root.preloads : []),
    ...(Array.isArray(root.scripts)
      ? root.scripts.flatMap((script) =>
          isRecord(script) && isRecord(script.attrs) && typeof script.attrs.src === 'string' ? [script.attrs.src] : [],
        )
      : []),
  ];
  if (!paths.every((assetPath) => typeof assetPath === 'string' && assetPath.startsWith('/assets/'))) {
    throw new Error('Expected every root-route client asset to use the generated assets directory');
  }
  return [...new Set(paths)];
};

describe('report app client bundle', () => {
  test(
    'emits generated Panda CSS and splits server-only route UI from the report entry',
    async () => {
      const appDir = path.resolve(import.meta.dir, '..');
      await $`bun run build`.cwd(appDir).quiet();

      const assetsDir = path.join(appDir, '.output/public/assets');
      expect(existsSync(assetsDir)).toBe(true);

      const cssFile = readdirSync(assetsDir).find((file) => file.endsWith('.css'));
      if (!cssFile) {
        throw new Error('Expected the report build to emit a CSS asset');
      }

      const css = readFileSync(path.join(assetsDir, cssFile), 'utf8');
      expect(css).toContain('--colors-canvas');
      expect(css).toContain('--colors-accent');
      expect(css).toContain('[data-theme=dark]');
      expect(css).toContain('prefers-color-scheme:dark');
      expect(css).not.toContain('@layer reset,base,tokens,recipes,utilities;');

      const javascriptFiles = readdirSync(assetsDir).filter((file) => file.endsWith('.js'));
      const reportEntry = javascriptFiles.find((file) => file.startsWith('index-'));
      expect(javascriptFiles.length).toBeGreaterThan(2);
      if (!reportEntry) {
        throw new Error('Expected the report build to emit an index JavaScript entry');
      }
      expect(readFileSync(path.join(assetsDir, reportEntry)).byteLength).toBeLessThan(720_000);

      const publicDir = path.join(appDir, '.output/public');
      const rootAssets = await initialAssetPaths(appDir);
      const gzipClosureBytes = rootAssets.reduce(
        (total, assetPath) =>
          total +
          gzipSync(readFileSync(path.join(publicDir, assetPath.replace(LEADING_SLASH_PATTERN, ''))), { level: 9 })
            .byteLength,
        0,
      );
      expect(gzipClosureBytes).toBeLessThanOrEqual(INITIAL_GZIP_CLOSURE_MAXIMUM_BYTES);
    },
    CLIENT_BUNDLE_BUILD_TIMEOUT_MS,
  );
});
