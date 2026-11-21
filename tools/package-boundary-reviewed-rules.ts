import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// The reviewed rules that replaced source-text tests (plan 128), and the source-scan primitives they share with
// tools/check-package-boundaries.ts. The checker imports this module, never the reverse, so the two stay acyclic.

export interface PackageBoundaryViolation {
  file: string;
  line?: number;
  message: string;
  packageName: string;
  specifier: string;
}

/** What the reviewed rules read from a discovered workspace package. */
interface GuardedPackage {
  directory: string;
  exports: unknown;
}

/**
 * `required` (the CLI and the real-tree test) reports a guarded package missing from the workspace;
 * `when-present` (fixtures holding only the packages under test) skips it. A guarded package that is present
 * without `src` or without production source is a violation in both modes.
 */
export type GuardedPackagePresence = 'required' | 'when-present';

const ignoredDirectories = new Set([
  '.direnv',
  '.git',
  '.output-build',
  '.svelte-kit',
  '.turbo',
  '.worktrees',
  'dist',
  'node_modules',
  'styled-system',
]);
const checkedExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.svelte', '.ts', '.tsx']);
const testOnlySourcePattern =
  /(?:^|\/)(?:__tests__|e2e|fixture|fixtures|test|tests)(?:\/|$)|(?:^|[.-])(?:e2e|spec|test)\.[^/]+$/u;
const testSourcePattern = /\.test\.[^/]+$/u;

/** Every static import, re-export, dynamic `import()` and `require()` specifier (groups 1, 2 and 3). */
export const moduleImportPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

export const isTestOnlySource = (relativeFile: string): boolean => testOnlySourcePattern.test(relativeFile);

export const isPackageOrSubpath = (specifier: string, packageName: string): boolean =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

export const lineNumberFor = (text: string, index: number) => text.slice(0, index).split('\n').length;

const toRepositoryPath = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

export async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collectSourceFiles(path.join(directory, entry.name))));
      }
      continue;
    }

    if (entry.isFile() && checkedExtensions.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }

  return files;
}

const sourceModuleExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.svelte'] as const;
const emittedExtensionSources = new Map<string, readonly string[]>([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
]);

export const resolveRelativeModule = async (packageDirectory: string, importer: string, specifier: string) => {
  const base = path.resolve(path.dirname(importer), specifier);
  const relativeBase = path.relative(packageDirectory, base);
  if (relativeBase.startsWith('..') || path.isAbsolute(relativeBase)) {
    return { status: 'outside-package' as const };
  }
  const extension = path.extname(base);
  const substitutedExtensions = emittedExtensionSources.get(extension) ?? [];
  const candidates = extension
    ? [base, ...substitutedExtensions.map((sourceExtension) => `${base.slice(0, -extension.length)}${sourceExtension}`)]
    : [
        ...sourceModuleExtensions.map((sourceExtension) => `${base}${sourceExtension}`),
        ...sourceModuleExtensions.map((sourceExtension) => path.join(base, `index${sourceExtension}`)),
      ];
  for (const candidate of candidates) {
    const exists = await readFile(candidate, 'utf8').then(
      () => true,
      () => false,
    );
    if (exists) {
      return { file: candidate, status: 'resolved' as const };
    }
  }
  return { status: 'unresolved' as const };
};

const missingPackageViolation = (packageName: string): PackageBoundaryViolation => ({
  file: '.',
  message: `Guarded package ${packageName} is missing from the workspace (apps/*, packages/*).`,
  packageName,
  specifier: packageName,
});

type GuardedSources =
  | { files: readonly string[]; sourceDirectory: string; status: 'scanned' }
  | { status: 'skipped' }
  | { status: 'violation'; violation: PackageBoundaryViolation };

/** The source files of a guarded package's `src` that `include` keeps; an absent or empty scan is reported. */
const guardedSources = async (
  root: string,
  packages: ReadonlyMap<string, GuardedPackage>,
  packageName: string,
  presence: GuardedPackagePresence,
  include: (file: string) => boolean,
): Promise<GuardedSources> => {
  const packageInfo = packages.get(packageName);
  if (!packageInfo) {
    return presence === 'when-present'
      ? { status: 'skipped' }
      : { status: 'violation', violation: missingPackageViolation(packageName) };
  }
  const sourceDirectory = path.join(packageInfo.directory, 'src');
  const sourcePath = toRepositoryPath(root, sourceDirectory);
  const files = await collectSourceFiles(sourceDirectory).then(
    (found) => found.filter(include),
    (error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    },
  );
  if (files === undefined || files.length === 0) {
    return {
      status: 'violation',
      violation: {
        file: sourcePath,
        message: `${packageName} must have production source under ${sourcePath} for this rule to check.`,
        packageName,
        specifier: sourcePath,
      },
    };
  }
  return { files, sourceDirectory, status: 'scanned' };
};

// The browser imports only the oRPC contract (ADR 0010/0012), so the web-contract production closure may reach
// only its own src modules and these reviewed pure dependencies: never a server, runtime, Node or Bun module.
// The closure starts at every production source and follows each resolved relative import, whatever its name or
// extension, so a fixture or `.mts` module reached from production is checked too; a test source may not be reached.
const webContractPackage = '@ai-usage/web-contract';
const webContractAllowedExternalPackages = ['@ai-usage/report-core', '@orpc/contract', 'valibot'] as const;
const webContractAllowedExactSpecifiers = new Set(['@ai-usage/skills/config', '@ai-usage/skills/shared']);
const webContractModulePattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

const isWebContractAllowedExternal = (specifier: string): boolean =>
  webContractAllowedExactSpecifiers.has(specifier) ||
  webContractAllowedExternalPackages.some((packageName) => isPackageOrSubpath(specifier, packageName));

type WebContractTarget = { file: string; status: 'follow' } | { reason: string; status: 'reject' } | { status: 'ok' };

const webContractTarget = async (
  sourceDirectory: string,
  file: string,
  specifier: string,
): Promise<WebContractTarget> => {
  if (!specifier.startsWith('.')) {
    return isWebContractAllowedExternal(specifier)
      ? { status: 'ok' }
      : {
          reason:
            'web-contract production code may import only report-core, @orpc/contract, valibot and the reviewed Skills contract entrypoints.',
          status: 'reject',
        };
  }
  const resolved = await resolveRelativeModule(sourceDirectory, file, specifier);
  if (resolved.status === 'outside-package') {
    return {
      reason: 'web-contract production code must not import modules outside its src directory.',
      status: 'reject',
    };
  }
  if (resolved.status === 'unresolved') {
    return {
      reason: 'web-contract relative imports must resolve to a module inside its src directory.',
      status: 'reject',
    };
  }
  return testSourcePattern.test(resolved.file)
    ? { reason: 'web-contract production code must not import test sources.', status: 'reject' }
    : { file: resolved.file, status: 'follow' };
};

export const collectWebContractClosureViolations = async (
  root: string,
  packages: ReadonlyMap<string, GuardedPackage>,
  presence: GuardedPackagePresence,
): Promise<PackageBoundaryViolation[]> => {
  const sources = await guardedSources(
    root,
    packages,
    webContractPackage,
    presence,
    (file) => !isTestOnlySource(toRepositoryPath(root, file)),
  );
  if (sources.status !== 'scanned') {
    return sources.status === 'violation' ? [sources.violation] : [];
  }
  const violations: PackageBoundaryViolation[] = [];
  const pending = [...sources.files];
  const visited = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(webContractModulePattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) {
        continue;
      }
      const target = await webContractTarget(sources.sourceDirectory, file, specifier);
      if (target.status === 'follow') {
        pending.push(target.file);
      } else if (target.status === 'reject') {
        violations.push({
          file: toRepositoryPath(root, file),
          line: lineNumberFor(text, match.index),
          message: target.reason,
          packageName: webContractPackage,
          specifier,
        });
      }
    }
  }
  return violations;
};

// Archives decode through one decoder: `DecompressionStream('zstd')`, pulled chunk by chunk in
// `local-history.ts` (ADR 0047), re-qualified on Bun 1.4.3 and 1.4.4. Bun's one-shot zstd decoders corrupted the
// heap on Bun 1.3.13 and take no output bound, and `node:zlib`'s one-shot decoder holds the whole output at once,
// so no other zstd decoder is reached from the history readers. The pattern matches every spelling a source can
// reach one by (`zstdDecompress`, `zstdDecompressSync`, `createZstdDecompress`, the `ZstdDecompress` class),
// comments included. Only `*.test.*` files are exempt: fixtures and testing helpers are scanned. Compressors are
// not implicated and stay available to fixtures and tests.
const zstdDecoderPackages = ['@ai-usage/local-machine', '@ai-usage/local-collectors'] as const;
const oneShotZstdDecoderPattern = /\b(?:create)?[Zz]stdDecompress(?:Sync)?\b/gu;
const streamingDecoderPattern = /\bDecompressionStream\b/gu;
const streamingDecoderOwner = 'packages/local-machine/src/local-history.ts';

const zstdDecoderMatches = (relativeFile: string, text: string) => [
  ...[...text.matchAll(oneShotZstdDecoderPattern)].map((match) => ({
    match,
    message: 'History readers decode zstd only through the streaming DecompressionStream reader.',
  })),
  ...(relativeFile === streamingDecoderOwner
    ? []
    : [...text.matchAll(streamingDecoderPattern)].map((match) => ({
        match,
        message: `Only ${streamingDecoderOwner} may construct the streaming zstd decoder.`,
      }))),
];

export const collectZstdDecoderViolations = async (
  root: string,
  packages: ReadonlyMap<string, GuardedPackage>,
  presence: GuardedPackagePresence,
): Promise<PackageBoundaryViolation[]> => {
  const violations: PackageBoundaryViolation[] = [];
  for (const packageName of zstdDecoderPackages) {
    const sources = await guardedSources(
      root,
      packages,
      packageName,
      presence,
      (file) => !testSourcePattern.test(file),
    );
    if (sources.status !== 'scanned') {
      violations.push(...(sources.status === 'violation' ? [sources.violation] : []));
      continue;
    }
    for (const file of sources.files) {
      const relativeFile = toRepositoryPath(root, file);
      const text = await readFile(file, 'utf8');
      for (const { match, message } of zstdDecoderMatches(relativeFile, text)) {
        violations.push({
          file: relativeFile,
          line: lineNumberFor(text, match.index),
          message,
          packageName,
          specifier: match[0],
        });
      }
    }
  }
  return violations;
};

// The engine seams are reviewed public surfaces: a new, removed or retargeted subpath is a decision, not a drift.
const reviewedPackageExports = new Map<string, Readonly<Record<string, string>>>([
  [
    '@ai-usage/usage-engine-control',
    {
      '.': './src/contracts.ts',
      './client': './src/client.ts',
      './completion': './src/completion.ts',
      './delegation-operations': './src/delegation-operations.ts',
      './handoff': './src/handoff.ts',
      './node': './src/rendezvous.ts',
      './testing': './src/testing.ts',
    },
  ],
  [
    '@ai-usage/usage-engine-runtime',
    {
      '.': './src/runtime.ts',
      './live': './src/live.ts',
      './recovery': './src/recovery.ts',
      './source-adapters': './src/source-adapters.ts',
      './source-control': './src/source-control.ts',
    },
  ],
  [
    '@ai-usage/usage-store',
    {
      './performance-testing': './src/performance-testing.ts',
      './reader': './src/reader.ts',
      './testing': './src/testing.ts',
      './writer': './src/writer.ts',
    },
  ],
  ['@ai-usage/usage-engine', { './main': './src/main.ts' }],
]);

const isExportsMap = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const collectPackageExportsViolations = (
  root: string,
  packages: ReadonlyMap<string, GuardedPackage>,
  presence: GuardedPackagePresence,
): PackageBoundaryViolation[] => {
  const violations: PackageBoundaryViolation[] = [];
  for (const [packageName, reviewed] of reviewedPackageExports) {
    const packageInfo = packages.get(packageName);
    if (!packageInfo) {
      violations.push(...(presence === 'required' ? [missingPackageViolation(packageName)] : []));
      continue;
    }
    const declared = isExportsMap(packageInfo.exports) ? packageInfo.exports : {};
    const subpaths = new Set([...Object.keys(reviewed), ...Object.keys(declared)]);
    for (const subpath of [...subpaths].toSorted()) {
      if (declared[subpath] === reviewed[subpath]) {
        continue;
      }
      violations.push({
        file: toRepositoryPath(root, path.join(packageInfo.directory, 'package.json')),
        message: `${packageName} exports ${subpath} as ${JSON.stringify(declared[subpath] ?? null)}; the reviewed seam is ${JSON.stringify(reviewed[subpath] ?? null)}.`,
        packageName,
        specifier: subpath,
      });
    }
  }
  return violations;
};
