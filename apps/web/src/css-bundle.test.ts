import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { aiUsagePreset } from '@ai-usage/design-system/preset';
import { $ } from 'bun';

const CLIENT_BUNDLE_BUILD_TIMEOUT_MS = 120_000;
const INITIAL_GZIP_CLOSURE_BASELINE_BYTES = 251_597;
const BREAKDOWN_SEARCH_GZIP_BUDGET_BYTES = 334;
const PUNCHCARD_FILTER_GZIP_BUDGET_BYTES = 625;
const REPORT_STRUCTURE_ENCODING_GZIP_BUDGET_BYTES = 1440;
const REPORT_SIGNAL_LANGUAGE_GZIP_BUDGET_BYTES = 370;
const DATA_QUALITY_LABELING_GZIP_BUDGET_BYTES = 619;
const HARNESS_PROVIDER_HIERARCHY_GZIP_BUDGET_BYTES = 1628;
const REPORT_SHARING_GZIP_BUDGET_BYTES = 615;
const SYNC_COMPARISON_ROUTE_HASH_GZIP_BUDGET_BYTES = 2;
const PENDING_FILTER_TIMELINE_GZIP_BUDGET_BYTES = 96;
const POST_REVIEW_CORRECTIONS_GZIP_BUDGET_BYTES = 128;
const REPORT_TESTABILITY_SEAMS_GZIP_BUDGET_BYTES = 128;
/**
 * The quota rail rides in the shell, so a second provider is initial-closure weight: one more ring,
 * a brand mark per provider that publishes one, and rail semantics that no longer assume a single
 * head. Measured against the commit that introduced it (3497 bytes) rather than estimated, then
 * rounded to the next 64: the build is not byte-identical between runs, and a budget pinned to an
 * exact measurement fails on a five-byte drift that says nothing about the code.
 */
const MULTI_PROVIDER_QUOTA_RAIL_GZIP_BUDGET_BYTES = 3520;
/**
 * Branded value objects parse at the boundary, and their parsers ship with the contract types.
 * Measured at 644 bytes, rounded on the same rule.
 */
const CORE_VALUE_OBJECTS_GZIP_BUDGET_BYTES = 704;
/**
 * Restoring the quota percentage in the 768-1279px band, where the rail is a 56px icon column and
 * the labelled row is hidden. Purely responsive atoms — the stacked row direction and gap, and the
 * compact value's md/xl display pair — since colour and weight reuse existing atoms. Measured at
 * 98 bytes, rounded to the next 64 on the same rule as the entries above.
 */
const COMPACT_QUOTA_RAIL_VALUE_GZIP_BUDGET_BYTES = 128;
const INITIAL_GZIP_CLOSURE_MAXIMUM_BYTES =
  Math.ceil(INITIAL_GZIP_CLOSURE_BASELINE_BYTES * 1.1) +
  BREAKDOWN_SEARCH_GZIP_BUDGET_BYTES +
  PUNCHCARD_FILTER_GZIP_BUDGET_BYTES +
  REPORT_STRUCTURE_ENCODING_GZIP_BUDGET_BYTES +
  REPORT_SIGNAL_LANGUAGE_GZIP_BUDGET_BYTES +
  DATA_QUALITY_LABELING_GZIP_BUDGET_BYTES +
  HARNESS_PROVIDER_HIERARCHY_GZIP_BUDGET_BYTES +
  REPORT_SHARING_GZIP_BUDGET_BYTES +
  SYNC_COMPARISON_ROUTE_HASH_GZIP_BUDGET_BYTES +
  PENDING_FILTER_TIMELINE_GZIP_BUDGET_BYTES +
  POST_REVIEW_CORRECTIONS_GZIP_BUDGET_BYTES +
  REPORT_TESTABILITY_SEAMS_GZIP_BUDGET_BYTES +
  MULTI_PROVIDER_QUOTA_RAIL_GZIP_BUDGET_BYTES +
  CORE_VALUE_OBJECTS_GZIP_BUDGET_BYTES +
  COMPACT_QUOTA_RAIL_VALUE_GZIP_BUDGET_BYTES;
const LEADING_SLASH_PATTERN = /^\/+/;
const REPORT_COLOR_TOKEN_PATTERN = /token\(colors\.([A-Za-z0-9_.-]+)\)/g;
const REPORT_SOURCE_FILE_PATTERN = /\.(?:svelte|ts)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const semanticColorPaths = (): ReadonlySet<string> => {
  const colors = aiUsagePreset.theme?.extend?.semanticTokens?.colors as unknown;
  const paths = new Set<string>();
  const visit = (node: unknown, prefix: string): void => {
    if (!isRecord(node)) {
      return;
    }
    if (isRecord(node.value)) {
      paths.add(prefix);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      visit(value, prefix ? `${prefix}.${key}` : key);
    }
  };
  visit(colors, '');
  return paths;
};

const sourceFilesUnder = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(entryPath));
    } else if (REPORT_SOURCE_FILE_PATTERN.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
};

test('Report source references only declared semantic color tokens', () => {
  const appDirectory = path.resolve(import.meta.dir, '..');
  const repositoryDirectory = path.resolve(appDirectory, '../..');
  const sourceFiles = [
    ...sourceFilesUnder(path.join(appDirectory, 'src/lib/features/report')),
    ...sourceFilesUnder(path.join(repositoryDirectory, 'packages/design-system/src/components')),
  ];
  const declaredColors = semanticColorPaths();
  const unknownTokens = new Set<string>();
  for (const sourceFile of sourceFiles) {
    const source = readFileSync(sourceFile, 'utf8');
    for (const match of source.matchAll(REPORT_COLOR_TOKEN_PATTERN)) {
      const token = match[1];
      if (token && !declaredColors.has(token)) {
        unknownTokens.add(token);
      }
    }
  }

  expect([...unknownTokens].toSorted()).toEqual([]);
});

test('Report alerts use warning and danger roles instead of the interaction accent', () => {
  const reportCoreDirectory = path.join(import.meta.dir, 'lib/features/report/core');
  const warningSource = readFileSync(path.join(reportCoreDirectory, 'report-warnings.svelte'), 'utf8');
  const statusSource = readFileSync(path.join(reportCoreDirectory, 'report-status.svelte'), 'utf8');

  expect(warningSource).toContain("borderColor: 'status.warn'");
  expect(warningSource).toContain("bg: 'status.warnSoft'");
  expect(warningSource).not.toContain("bg: 'accentTint'");
  expect(statusSource).toContain("borderColor: 'status.danger'");
  expect(statusSource).toContain("bg: 'status.dangerSoft'");
});

interface ClientManifestEntry {
  readonly css?: readonly string[];
  readonly file: string;
  readonly imports?: readonly string[];
}

const initialAssetPaths = (appDir: string): string[] => {
  const manifestPath = path.join(appDir, '.svelte-kit/build/output/client/.vite/manifest.json');
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('Expected the SvelteKit client manifest to be an object');
  }
  const manifest = parsed as Record<string, ClientManifestEntry>;
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

const readInitialAsset = (publicDir: string, assetPath: string) => {
  const assetFile = path.join(publicDir, assetPath.replace(LEADING_SLASH_PATTERN, ''));
  if (!existsSync(assetFile)) {
    throw new Error(`Expected the initial client asset to exist: ${assetPath}`);
  }
  return readFileSync(assetFile);
};

describe('report app client bundle', () => {
  test(
    'emits generated Panda CSS and splits server-only route UI from the report entry',
    async () => {
      const appDir = path.resolve(import.meta.dir, '..');
      await $`bun run build`.cwd(appDir).quiet();

      const publicDir = path.join(appDir, '.output-build/sveltekit/client');
      const rootAssets = initialAssetPaths(appDir);
      const cssAssetPaths = rootAssets.filter((assetPath) => assetPath.endsWith('.css'));
      if (cssAssetPaths.length === 0) {
        throw new Error('Expected the initial client manifest closure to include a CSS asset');
      }
      const css = cssAssetPaths.map((assetPath) => readInitialAsset(publicDir, assetPath).toString('utf8')).join('\n');
      expect(css).toContain('--colors-canvas');
      expect(css).toContain('--colors-accent');
      expect(css).toContain('--colors-interaction-brush');
      expect(css).toContain('--colors-interaction-brush-hover');
      expect(css).toContain('[data-theme=dark]');
      expect(css).toContain('prefers-color-scheme:dark');
      expect(css).not.toContain('@layer reset,base,tokens,recipes,utilities;');
      expect(css).not.toContain('--colors-border');
      expect(css).not.toContain('token(colors.');

      const nodesDir = path.join(publicDir, '_app/immutable/nodes');
      const javascriptFiles = readdirSync(nodesDir).filter((file) => file.endsWith('.js'));
      const reportEntry = javascriptFiles.find((file) => file.startsWith('3.'));
      expect(javascriptFiles.length).toBeGreaterThan(2);
      if (!reportEntry) {
        throw new Error('Expected the report build to emit an index JavaScript entry');
      }
      expect(readFileSync(path.join(nodesDir, reportEntry)).byteLength).toBeLessThan(720_000);

      const gzipClosureBytes = rootAssets.reduce(
        (total, assetPath) => total + gzipSync(readInitialAsset(publicDir, assetPath), { level: 9 }).byteLength,
        0,
      );
      expect(gzipClosureBytes).toBeLessThanOrEqual(INITIAL_GZIP_CLOSURE_MAXIMUM_BYTES);
    },
    CLIENT_BUNDLE_BUILD_TIMEOUT_MS,
  );
});
