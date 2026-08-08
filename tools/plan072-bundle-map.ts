#!/usr/bin/env bun
/**
 * Plan 072 bundle cartography.
 *
 * Reads the SvelteKit client module manifest emitted by
 * `apps/web/vite-client-module-manifest.ts` and produces a machine-readable
 * plus a human-readable report of:
 *
 *   - which Ark and Zag modules each chunk contains,
 *   - which modules are duplicated across two or more chunks,
 *   - the initial static closure (entry + app + nodes/0 + nodes/3) and the
 *     Ark/Zag modules it drags in,
 *   - the lazy chunks that are loaded only after the first user
 *     interaction (Drawer, session table, breakdown, quota history) and the
 *     Ark/Zag modules they bring.
 *
 * The output is intentionally deterministic and committed as an artifact so
 * the next reviewer can diff bundle composition between candidates.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_MANIFEST_PATH = path.join(ROOT, 'apps/web/.svelte-kit/build/private/client-modules.json');
const DEFAULT_VITE_MANIFEST_PATH = path.join(ROOT, 'apps/web/.svelte-kit/build/output/client/.vite/manifest.json');
const DEFAULT_OUTPUT_JSON = path.join(ROOT, 'docs/performance/artifacts/plan072-bundle-map.json');
const DEFAULT_OUTPUT_MD = path.join(ROOT, 'docs/performance/artifacts/plan072-bundle-map.md');
const DEFAULT_CLIENT_OUTPUT = path.join(ROOT, 'apps/web/.output-build/sveltekit/client');
// biome-ignore lint/suspicious/noUndeclaredEnvVars: tooling override for isolated test runs
const MANIFEST_PATH = process.env.AI_USAGE_PLAN072_MANIFEST ?? DEFAULT_MANIFEST_PATH;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: tooling override for isolated test runs
const VITE_MANIFEST_PATH = process.env.AI_USAGE_PLAN072_VITE_MANIFEST ?? DEFAULT_VITE_MANIFEST_PATH;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: tooling override for isolated test runs
const OUTPUT_JSON = process.env.AI_USAGE_PLAN072_OUTPUT_JSON ?? DEFAULT_OUTPUT_JSON;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: tooling override for isolated test runs
const OUTPUT_MD = process.env.AI_USAGE_PLAN072_OUTPUT_MD ?? DEFAULT_OUTPUT_MD;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: tooling override for isolated test runs
const CLIENT_OUTPUT = process.env.AI_USAGE_PLAN072_CLIENT_OUTPUT ?? DEFAULT_CLIENT_OUTPUT;

const ARK_MODULE_PATTERNS = [/(?:\.\.\/)+node_modules\/@ark-ui\/svelte\//u] as const;
const ARK_COMPONENT_PATTERNS = [
  /(?:\.\.\/)+node_modules\/@ark-ui\/svelte\/dist\/components\/(drawer|popover|tabs|toggle|select|toggle-group|tooltip|checkbox|portal|dialog|popper|presence|focus-trap|remove-scroll|dismissable|aria-hidden)/u,
] as const;
const ZAG_PACKAGE_PATTERNS = [/(?:\.\.\/)+node_modules\/@zag-js\//u] as const;
const SESSIONS_DESTINATION_MODULE_PATTERN = /\/sessions-destination\.svelte$/u;
const BREAKDOWN_DESTINATION_MODULE_PATTERN = /\/dashboard-breakdown\.svelte$/u;
const SESSION_DRAWER_MODULE_PATTERN = /\/session-drawer\.svelte$/u;
const WORKSPACE_RELATIVE_PREFIX_PATTERN = /^(?:\.\.\/)+(?=packages\/)/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string');

interface ManifestChunk {
  readonly dynamicImports: readonly string[];
  readonly fileName: string;
  readonly imports: readonly string[];
  readonly moduleIds: readonly string[];
  readonly modules: readonly string[];
  readonly renderedDynamicImports: readonly string[];
}

interface Manifest {
  readonly chunks: readonly ManifestChunk[];
  readonly format: 'ai-usage-web-client-modules';
  readonly target: 'client';
  readonly version: number;
}

interface ViteManifestEntry {
  readonly css: readonly string[];
  readonly file: string;
  readonly imports: readonly string[];
}

const parseManifest = (value: unknown): Manifest => {
  if (!isRecord(value)) {
    throw new Error('Expected the client module manifest to be an object');
  }
  if (value.format !== 'ai-usage-web-client-modules' || value.target !== 'client') {
    throw new Error('Expected the client module manifest to be a web client manifest');
  }
  if (!Array.isArray(value.chunks) || value.chunks.length === 0) {
    throw new Error('Expected the client module manifest to expose chunks');
  }
  const chunks: ManifestChunk[] = [];
  for (const candidate of value.chunks) {
    if (!isRecord(candidate)) {
      throw new Error('Expected every client module manifest chunk to be an object');
    }
    if (typeof candidate.fileName !== 'string') {
      throw new Error('Expected every client module manifest chunk to expose a fileName');
    }
    chunks.push({
      dynamicImports: isNonEmptyStringArray(candidate.dynamicImports) ? candidate.dynamicImports : [],
      fileName: candidate.fileName,
      imports: isNonEmptyStringArray(candidate.imports) ? candidate.imports : [],
      moduleIds: isNonEmptyStringArray(candidate.moduleIds) ? candidate.moduleIds : [],
      modules: isNonEmptyStringArray(candidate.modules) ? candidate.modules : [],
      renderedDynamicImports: isNonEmptyStringArray(candidate.renderedDynamicImports)
        ? candidate.renderedDynamicImports
        : [],
    });
  }
  return {
    chunks,
    format: 'ai-usage-web-client-modules',
    target: 'client',
    version: typeof value.version === 'number' ? value.version : 0,
  };
};

const parseViteManifest = (value: unknown): ReadonlyMap<string, ViteManifestEntry> => {
  if (!isRecord(value)) {
    throw new Error('Expected the Vite client manifest to be an object');
  }
  const entries = new Map<string, ViteManifestEntry>();
  for (const [key, candidate] of Object.entries(value)) {
    if (!(isRecord(candidate) && typeof candidate.file === 'string')) {
      throw new Error(`Expected Vite manifest entry ${key} to expose a file`);
    }
    entries.set(key, {
      css: isNonEmptyStringArray(candidate.css) ? candidate.css : [],
      file: candidate.file,
      imports: isNonEmptyStringArray(candidate.imports) ? candidate.imports : [],
    });
  }
  return entries;
};

const matchesAny = (moduleId: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(moduleId));

const isArkModule = (moduleId: string): boolean => matchesAny(moduleId, ARK_MODULE_PATTERNS);
const isZagModule = (moduleId: string): boolean => matchesAny(moduleId, ZAG_PACKAGE_PATTERNS);
const isArkComponent = (moduleId: string): boolean => matchesAny(moduleId, ARK_COMPONENT_PATTERNS);
const workspaceStableModuleId = (moduleId: string): string => moduleId.replace(WORKSPACE_RELATIVE_PREFIX_PATTERN, '');

const INITIAL_VITE_ENTRY_KEYS = [
  '../../node_modules/@sveltejs/kit/src/runtime/client/entry.js',
  '.svelte-kit/build/generated/client-optimized/app.js',
  '.svelte-kit/build/generated/client-optimized/nodes/0.js',
  '.svelte-kit/build/generated/client-optimized/nodes/3.js',
] as const;

const deriveInitialClosure = (viteManifest: ReadonlyMap<string, ViteManifestEntry>): ReadonlySet<string> => {
  const closure = new Set<string>();
  const visitedKeys = new Set<string>();
  const queue: string[] = [...INITIAL_VITE_ENTRY_KEYS];

  while (queue.length > 0) {
    const key = queue.shift();
    if (!key || visitedKeys.has(key)) {
      continue;
    }
    visitedKeys.add(key);
    const entry = viteManifest.get(key);
    if (!entry) {
      throw new Error(`Expected the Vite client manifest to include ${key}`);
    }
    closure.add(entry.file);
    queue.push(...entry.imports);
  }

  return closure;
};

const LAZY_CHUNK_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'session-table', pattern: /session-table/u },
  { label: 'session-drawer', pattern: /session-drawer/u },
  { label: 'dashboard-breakdown', pattern: /dashboard-breakdown/u },
  { label: 'quota-history-panel', pattern: /quota-history/u },
];

interface ChunkSummary {
  readonly arkComponents: readonly string[];
  readonly arkModuleIds: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly fileName: string;
  readonly imports: readonly string[];
  readonly isInitial: boolean;
  readonly lazyLabel: string | null;
  readonly moduleCount: number;
  readonly zagModuleIds: readonly string[];
}

interface ModuleOccurrence {
  readonly chunkFileNames: readonly string[];
  readonly moduleId: string;
}

interface ClosureAsset {
  readonly brotliBytes: number;
  readonly fileName: string;
  readonly gzipBytes: number;
  readonly rawBytes: number;
}

interface DestinationClosure {
  readonly arkModuleIds: readonly string[];
  readonly assets: readonly ClosureAsset[];
  readonly brotliBytes: number;
  readonly chunkCount: number;
  readonly designSystemArkImporters: readonly string[];
  readonly gzipBytes: number;
  readonly label: string;
  readonly rawBytes: number;
  readonly zagModuleIds: readonly string[];
}

const buildSummary = (
  chunks: readonly ManifestChunk[],
  viteManifest: ReadonlyMap<string, ViteManifestEntry>,
): readonly ChunkSummary[] => {
  const initialClosure = deriveInitialClosure(viteManifest);
  const summaries: ChunkSummary[] = [];
  for (const chunk of chunks) {
    const isInitial = initialClosure.has(chunk.fileName);
    const chunkIdentity = `${chunk.fileName}\n${chunk.moduleIds.join('\n')}`;
    const lazyLabel = LAZY_CHUNK_PATTERNS.find((entry) => entry.pattern.test(chunkIdentity))?.label ?? null;
    const arkModuleIds = chunk.moduleIds.filter(isArkModule);
    const arkComponents = Array.from(
      new Set(arkModuleIds.filter(isArkComponent).map((moduleId) => extractArkComponent(moduleId))),
    ).sort();
    const zagModuleIds = chunk.moduleIds.filter(isZagModule);
    summaries.push({
      arkComponents,
      arkModuleIds: Array.from(new Set(arkModuleIds)).sort(),
      dynamicImports: chunk.dynamicImports,
      fileName: chunk.fileName,
      imports: chunk.imports,
      isInitial,
      lazyLabel,
      moduleCount: chunk.moduleIds.length,
      zagModuleIds: Array.from(new Set(zagModuleIds)).sort(),
    });
  }
  return summaries;
};

const ARK_COMPONENT_NAME_PATTERN = /@ark-ui\/svelte\/dist\/components\/([^/]+)/u;

const extractArkComponent = (moduleId: string): string => {
  const match = ARK_COMPONENT_NAME_PATTERN.exec(moduleId);
  if (!match) {
    return 'unknown';
  }
  return match[1] ?? 'unknown';
};

const buildOccurrences = (chunks: readonly ManifestChunk[]): readonly ModuleOccurrence[] => {
  const byModule = new Map<string, string[]>();
  for (const chunk of chunks) {
    for (const moduleId of new Set(chunk.moduleIds)) {
      const list = byModule.get(moduleId) ?? [];
      list.push(chunk.fileName);
      byModule.set(moduleId, list);
    }
  }
  const occurrences: ModuleOccurrence[] = [];
  for (const [moduleId, chunkFileNames] of byModule) {
    if (chunkFileNames.length > 1) {
      occurrences.push({ chunkFileNames: [...chunkFileNames].sort(), moduleId });
    }
  }
  occurrences.sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  return occurrences;
};

const initialChunkSummary = (summaries: readonly ChunkSummary[]): ChunkSummary[] =>
  summaries.filter((summary) => summary.isInitial);

const lazyChunkSummary = (summaries: readonly ChunkSummary[]): ChunkSummary[] =>
  summaries.filter((summary) => summary.lazyLabel !== null);

const importedChunkClosure = (chunks: readonly ManifestChunk[], roots: ReadonlySet<string>): ReadonlySet<string> => {
  const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const closure = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (!fileName || closure.has(fileName)) {
      continue;
    }
    closure.add(fileName);
    const chunk = byFileName.get(fileName);
    if (chunk) {
      pending.push(...chunk.imports);
    }
  }
  return closure;
};

const chunkFilesMatching = (chunks: readonly ManifestChunk[], pattern: RegExp): Set<string> =>
  new Set(
    chunks.filter((chunk) => chunk.moduleIds.some((moduleId) => pattern.test(moduleId))).map((chunk) => chunk.fileName),
  );

const assetFilesForClosure = (
  chunkFiles: ReadonlySet<string>,
  viteManifest: ReadonlyMap<string, ViteManifestEntry>,
): readonly string[] => {
  const assets = new Set(chunkFiles);
  for (const entry of viteManifest.values()) {
    if (chunkFiles.has(entry.file)) {
      for (const cssFile of entry.css) {
        assets.add(cssFile);
      }
    }
  }
  return [...assets].sort();
};

const measureAsset = (fileName: string): ClosureAsset => {
  const filePath = path.join(CLIENT_OUTPUT, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`Expected built client asset ${fileName}`);
  }
  const body = readFileSync(filePath);
  return {
    brotliBytes: brotliCompressSync(body).byteLength,
    fileName,
    gzipBytes: gzipSync(body, { level: 9 }).byteLength,
    rawBytes: body.byteLength,
  };
};

const summarizeClosure = (
  label: string,
  chunkFiles: ReadonlySet<string>,
  chunks: readonly ManifestChunk[],
  viteManifest: ReadonlyMap<string, ViteManifestEntry>,
): DestinationClosure => {
  const closureChunks = chunks.filter((chunk) => chunkFiles.has(chunk.fileName));
  const moduleIds = closureChunks.flatMap((chunk) => chunk.moduleIds);
  const arkModuleIds = [...new Set(moduleIds.filter(isArkModule))].sort();
  const zagModuleIds = [...new Set(moduleIds.filter(isZagModule))].sort();
  const designSystemArkImporters = [
    ...new Set(
      closureChunks
        .filter((chunk) => chunk.moduleIds.some((moduleId) => isArkModule(moduleId) || isZagModule(moduleId)))
        .flatMap((chunk) =>
          chunk.moduleIds
            .filter((moduleId) => moduleId.includes('/packages/design-system/src/'))
            .map(workspaceStableModuleId),
        ),
    ),
  ].sort();
  const assets = assetFilesForClosure(chunkFiles, viteManifest).map(measureAsset);
  return {
    arkModuleIds,
    assets,
    brotliBytes: assets.reduce((total, asset) => total + asset.brotliBytes, 0),
    chunkCount: assets.length,
    designSystemArkImporters,
    gzipBytes: assets.reduce((total, asset) => total + asset.gzipBytes, 0),
    label,
    rawBytes: assets.reduce((total, asset) => total + asset.rawBytes, 0),
    zagModuleIds,
  };
};

const buildDestinationClosures = (
  chunks: readonly ManifestChunk[],
  viteManifest: ReadonlyMap<string, ViteManifestEntry>,
): readonly DestinationClosure[] => {
  const initial = deriveInitialClosure(viteManifest);
  const sessionsRoots = new Set([...initial, ...chunkFilesMatching(chunks, SESSIONS_DESTINATION_MODULE_PATTERN)]);
  const breakdownRoots = new Set([...initial, ...chunkFilesMatching(chunks, BREAKDOWN_DESTINATION_MODULE_PATTERN)]);
  const drawerRoots = new Set([...sessionsRoots, ...chunkFilesMatching(chunks, SESSION_DRAWER_MODULE_PATTERN)]);
  return [
    summarizeClosure('overview', importedChunkClosure(chunks, initial), chunks, viteManifest),
    summarizeClosure('sessions', importedChunkClosure(chunks, sessionsRoots), chunks, viteManifest),
    summarizeClosure('breakdown', importedChunkClosure(chunks, breakdownRoots), chunks, viteManifest),
    summarizeClosure('sessions-after-drawer', importedChunkClosure(chunks, drawerRoots), chunks, viteManifest),
  ];
};

const buildMarkdown = (
  manifest: Manifest,
  summaries: readonly ChunkSummary[],
  occurrences: readonly ModuleOccurrence[],
  destinationClosures: readonly DestinationClosure[],
): string => {
  const lines: string[] = [];
  lines.push('# Plan 072 — Bundle cartography');
  lines.push('');

  lines.push('## Destination closures');
  lines.push('');
  lines.push('| Destination | Assets | Raw | Gzip | Brotli | Ark | Zag |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const closure of destinationClosures) {
    lines.push(
      `| ${closure.label} | ${closure.chunkCount} | ${closure.rawBytes} | ${closure.gzipBytes} | ${closure.brotliBytes} | ${closure.arkModuleIds.length} | ${closure.zagModuleIds.length} |`,
    );
  }
  lines.push('');
  lines.push(
    `Manifest: \`${path.relative(ROOT, MANIFEST_PATH)}\` (format=${manifest.format}, version=${manifest.version})`,
  );
  lines.push(`Total chunks: ${manifest.chunks.length}`);
  lines.push('');

  lines.push('## Initial closure');
  lines.push('');
  lines.push('| File | Ark components | Zag modules | Module count |');
  lines.push('| --- | --- | ---: | ---: |');
  for (const summary of initialChunkSummary(summaries)) {
    lines.push(
      `| \`${summary.fileName}\` | ${summary.arkComponents.join(', ') || '—'} | ${summary.zagModuleIds.length} | ${summary.moduleCount} |`,
    );
  }
  lines.push('');

  lines.push('## Lazy chunks after first interaction');
  lines.push('');
  lines.push('| Label | File | Ark components | Module count |');
  lines.push('| --- | --- | --- | ---: |');
  for (const summary of lazyChunkSummary(summaries)) {
    lines.push(
      `| ${summary.lazyLabel ?? '—'} | \`${summary.fileName}\` | ${summary.arkComponents.join(', ') || '—'} | ${summary.moduleCount} |`,
    );
  }
  lines.push('');

  lines.push('## Duplicated modules (>=2 chunks)');
  lines.push('');
  const duplicatedArkOrZag = occurrences.filter(
    (occurrence) => isArkModule(occurrence.moduleId) || isZagModule(occurrence.moduleId),
  );
  lines.push(`Total duplicated modules: ${occurrences.length}; Ark/Zag only: ${duplicatedArkOrZag.length}`);
  lines.push('');
  if (duplicatedArkOrZag.length === 0) {
    lines.push('_No Ark or Zag modules are duplicated across chunks._');
    lines.push('');
  } else {
    lines.push('| Module | Chunks |');
    lines.push('| --- | --- |');
    for (const occurrence of duplicatedArkOrZag) {
      lines.push(`| \`${occurrence.moduleId}\` | ${occurrence.chunkFileNames.length} |`);
    }
    lines.push('');
  }

  lines.push('## Duplicated non-Ark/Zag modules');
  lines.push('');
  const duplicatedOther = occurrences.filter(
    (occurrence) => !(isArkModule(occurrence.moduleId) || isZagModule(occurrence.moduleId)),
  );
  if (duplicatedOther.length === 0) {
    lines.push('_No non-Ark/Zag modules are duplicated across chunks._');
  } else {
    lines.push('| Module | Chunks |');
    lines.push('| --- | ---: |');
    for (const occurrence of duplicatedOther) {
      lines.push(`| \`${occurrence.moduleId}\` | ${occurrence.chunkFileNames.length} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
};

const main = (): void => {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const rawViteManifest = readFileSync(VITE_MANIFEST_PATH, 'utf8');
  const manifest = parseManifest(JSON.parse(raw));
  const viteManifest = parseViteManifest(JSON.parse(rawViteManifest));
  const summaries = buildSummary(manifest.chunks, viteManifest);
  const occurrences = buildOccurrences(manifest.chunks);
  const destinationClosures = buildDestinationClosures(manifest.chunks, viteManifest);
  const initial = initialChunkSummary(summaries);
  const lazy = lazyChunkSummary(summaries);
  const duplicatedArkOrZag = occurrences.filter(
    (occurrence) => isArkModule(occurrence.moduleId) || isZagModule(occurrence.moduleId),
  );
  const summary = {
    chunkCount: manifest.chunks.length,
    duplicatedArkOrZagCount: duplicatedArkOrZag.length,
    duplicatedModuleCount: occurrences.length,
    destinationClosures,
    initialChunkCount: initial.length,
    initialChunks: initial,
    lazyChunkCount: lazy.length,
    lazyChunks: lazy,
    manifestFormat: manifest.format,
    manifestPath: path.relative(ROOT, MANIFEST_PATH),
    manifestVersion: manifest.version,
    occurrences,
  };
  writeFileSync(OUTPUT_JSON, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(OUTPUT_MD, buildMarkdown(manifest, summaries, occurrences, destinationClosures), 'utf8');
  process.stdout.write(
    `plan072-bundle-map: ${summary.chunkCount} chunks, ${summary.duplicatedArkOrZagCount} duplicated Ark/Zag modules, ${summary.initialChunkCount} initial chunks.\n`,
  );
};

main();
