import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * These assertions read the emitted client build; they never produce one. Run `bun run build`
 * first — CI does, in the step directly above this one, so the guard costs no second build.
 */
const APP_DIRECTORY = path.resolve(import.meta.dir, '..');
const CLIENT_MANIFEST_PATH = '.svelte-kit/build/output/client/.vite/manifest.json';
const CLIENT_PUBLIC_DIRECTORY = '.output-build/sveltekit/client';

/**
 * What the browser downloads before the report can paint: the SvelteKit client runtime, the app
 * entry, node 0 (the shell layout, on every route) and node 3 (the report page). Anything behind a
 * dynamic import or on another route is deliberately outside this closure.
 */
const INITIAL_CLOSURE_ENTRY_KEYS = [
  '../../node_modules/@sveltejs/kit/src/runtime/client/entry.js',
  '.svelte-kit/build/generated/client-optimized/app.js',
  '.svelte-kit/build/generated/client-optimized/nodes/0.js',
  '.svelte-kit/build/generated/client-optimized/nodes/3.js',
] as const;

/**
 * A product decision, not an accounting of history: the report's first load stays under 300 KB
 * gzipped. Raising it is a deliberate choice about what the app costs to open, and the reason
 * belongs in the commit that raises it.
 */
const INITIAL_GZIP_CLOSURE_CEILING_BYTES = 300_000;

/**
 * The last measurement taken on main, and the tolerance around it. The ceiling alone cannot catch
 * the regression that actually matters — a dynamic import going eager, which lands in kilobytes —
 * because it can happen with headroom to spare. Two percent sits well above the few bytes that
 * differ between two builds of the same tree, and well below any real change of shape.
 *
 * When a change legitimately grows the closure, re-measure and move this number in the same commit.
 */
const RECORDED_GZIP_CLOSURE_BYTES = 290_137;
const GZIP_CLOSURE_DRIFT_TOLERANCE = 0.02;

/** The report page entry, uncompressed. A coarse companion to the closure guard above. */
const REPORT_ENTRY_MAXIMUM_BYTES = 720_000;

const LEADING_SLASH_PATTERN = /^\/+/;
const TRAILING_MEDIA_QUERY_PATTERN = /@media screen and \(width>=[\d.]+rem\)(?![\s\S]*@media)/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface ClientManifestEntry {
  readonly css?: readonly string[];
  readonly file: string;
  readonly imports?: readonly string[];
}

const readClientManifest = (): Record<string, ClientManifestEntry> => {
  const manifestPath = path.join(APP_DIRECTORY, CLIENT_MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    throw new Error(`No client build found at ${manifestPath}. Run \`bun run build\` before this test.`);
  }
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Expected the SvelteKit client manifest to be an object');
  }
  return parsed as Record<string, ClientManifestEntry>;
};

const initialAssetPaths = (manifest: Record<string, ClientManifestEntry>): string[] => {
  const pending: string[] = [...INITIAL_CLOSURE_ENTRY_KEYS];
  const visited = new Set<string>();
  const assets = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop();
    if (!key || visited.has(key)) {
      continue;
    }
    visited.add(key);
    const entry = manifest[key];
    if (!(entry && typeof entry.file === 'string')) {
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

const readInitialAsset = (assetPath: string): Buffer => {
  const assetFile = path.join(APP_DIRECTORY, CLIENT_PUBLIC_DIRECTORY, assetPath.replace(LEADING_SLASH_PATTERN, ''));
  if (!existsSync(assetFile)) {
    throw new Error(`Expected the initial client asset to exist: ${assetPath}`);
  }
  return readFileSync(assetFile);
};

/**
 * Gzipped per asset and summed, not over the concatenation: that is what the browser actually
 * fetches, and it keeps the cost of chunk splitting visible. Identical bytes carved into separate
 * chunks compress worse than merged, so the closure can grow without a line of new code shipping.
 */
const gzipClosureBytes = (assetPaths: readonly string[]): number =>
  assetPaths.reduce((total, assetPath) => total + gzipSync(readInitialAsset(assetPath), { level: 9 }).byteLength, 0);

const budgetFailures = (totalBytes: number): string[] => {
  const failures: string[] = [];
  const driftCeiling = Math.round(RECORDED_GZIP_CLOSURE_BYTES * (1 + GZIP_CLOSURE_DRIFT_TOLERANCE));
  if (totalBytes > INITIAL_GZIP_CLOSURE_CEILING_BYTES) {
    failures.push(
      `initial gzip closure is ${totalBytes} B, over the ${INITIAL_GZIP_CLOSURE_CEILING_BYTES} B ceiling — ` +
        'the report first load has outgrown what the app is meant to cost to open',
    );
  }
  if (totalBytes > driftCeiling) {
    failures.push(
      `initial gzip closure jumped to ${totalBytes} B, over ${driftCeiling} B ` +
        `(recorded ${RECORDED_GZIP_CLOSURE_BYTES} B + ${GZIP_CLOSURE_DRIFT_TOLERANCE * 100}%) — ` +
        'a jump this size usually means a dynamic import became eager; if it is intended, ' +
        'update RECORDED_GZIP_CLOSURE_BYTES in this file',
    );
  }
  return failures;
};

describe('report app client bundle', () => {
  test('serves generated Panda CSS with resolved tokens', () => {
    const assetPaths = initialAssetPaths(readClientManifest());
    const cssAssetPaths = assetPaths.filter((assetPath) => assetPath.endsWith('.css'));
    if (cssAssetPaths.length === 0) {
      throw new Error('Expected the initial client manifest closure to include a CSS asset');
    }
    const css = cssAssetPaths.map((assetPath) => readInitialAsset(assetPath).toString('utf8')).join('\n');

    expect(css).toContain('--colors-canvas');
    expect(css).toContain('--colors-accent');
    expect(css).toContain('--colors-interaction-brush');
    expect(css).toContain('--colors-interaction-brush-hover');
    expect(css).toContain('[data-theme=dark]');
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).not.toContain('@layer reset,base,tokens,recipes,utilities;');
    expect(css).not.toContain('--colors-border');
    expect(css).not.toContain('token(colors.');
  });

  test('emits the responsive breakpoints the quota rail is designed against', () => {
    const assetPaths = initialAssetPaths(readClientManifest());
    const css = assetPaths
      .filter((assetPath) => assetPath.endsWith('.css'))
      .map((assetPath) => readInitialAsset(assetPath).toString('utf8'))
      .join('\n');

    // The rail's compact percentage is an `md`/`xl` display pair, and provider-quota-rail.ssr.test.ts
    // pins those atoms onto the element. What that cannot see is where the atoms actually switch:
    // a preset change moving `md` would shift the band silently while every atom assertion still
    // passed. Panda emits the breakpoints in rem, so 48rem/80rem are the 768px/1280px contract.
    const mediaQueryFor = (atom: string): string | undefined => {
      const upToAtom = css.slice(0, css.indexOf(`.${atom.replace(':', '\\:')}`));
      return upToAtom.match(TRAILING_MEDIA_QUERY_PATTERN)?.[0];
    };

    expect(mediaQueryFor('md:d_block')).toBe('@media screen and (width>=48rem)');
    expect(mediaQueryFor('xl:d_none')).toBe('@media screen and (width>=80rem)');
    expect(mediaQueryFor('md:d_none')).toBe('@media screen and (width>=48rem)');
    expect(mediaQueryFor('xl:d_block')).toBe('@media screen and (width>=80rem)');
  });

  test('splits server-only route UI out of the report entry', () => {
    const nodesDirectory = path.join(APP_DIRECTORY, CLIENT_PUBLIC_DIRECTORY, '_app/immutable/nodes');
    const javascriptFiles = readdirSync(nodesDirectory).filter((file) => file.endsWith('.js'));
    const reportEntry = javascriptFiles.find((file) => file.startsWith('3.'));

    expect(javascriptFiles.length).toBeGreaterThan(2);
    if (!reportEntry) {
      throw new Error('Expected the report build to emit an index JavaScript entry');
    }
    expect(readFileSync(path.join(nodesDirectory, reportEntry)).byteLength).toBeLessThan(REPORT_ENTRY_MAXIMUM_BYTES);
  });

  test('keeps the report first load within its gzip budget', () => {
    const totalBytes = gzipClosureBytes(initialAssetPaths(readClientManifest()));

    expect(budgetFailures(totalBytes)).toEqual([]);
  });
});
