import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.svelte', '.ts', '.tsx']);
const emittedTextExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.map', '.mjs']);
const moduleQueryPattern = /[?#].*$/u;
const testOnlySourcePattern = /(?:^|\/)(?:__tests__|e2e|fixtures?|tests?)(?:\/|$)|(?:^|[.-])(?:spec|test)\.[^/]+$/u;
const moduleImportPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;

type DependencyField = (typeof dependencyFields)[number];

type ViolationSurface = 'dependency' | 'emitted-output' | 'lockfile' | 'source-import' | 'source-marker';

interface RetiredPackageRule {
  matches: (specifier: string) => boolean;
  name: string;
}

export interface WebRetiredStackViolation {
  file: string;
  line: number;
  rule: string;
  surface: ViolationSurface;
  value: string;
}

export interface CheckWebRetiredStackOptions {
  requireBuildOutput?: boolean;
  trackedFiles?: readonly string[];
}

const normalizeSeparators = (value: string): string => value.replaceAll('\\', '/');
const withoutModuleQuery = (value: string): string => value.replace(moduleQueryPattern, '');
const isPackageOrSubpath = (specifier: string, packageName: string): boolean =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

const retiredPackageRules: readonly RetiredPackageRule[] = [
  {
    matches: (specifier) => specifier.startsWith('@tanstack/solid-'),
    name: 'TanStack Solid adapter',
  },
  {
    matches: (specifier) => specifier.startsWith('@tanstack/start-'),
    name: 'TanStack Start package',
  },
  {
    matches: (specifier) => specifier.startsWith('@tanstack/router-'),
    name: 'TanStack Router package',
  },
  {
    matches: (specifier) => isPackageOrSubpath(specifier, 'solid-js'),
    name: 'Solid runtime',
  },
  {
    matches: (specifier) => specifier.startsWith('@solidjs/') || specifier.startsWith('@solid-primitives/'),
    name: 'Solid support package',
  },
  {
    matches: (specifier) =>
      ['babel-preset-solid', 'solid-refresh', 'vite-plugin-solid', 'vite-solid'].some((packageName) =>
        isPackageOrSubpath(specifier, packageName),
      ),
    name: 'Solid Vite package',
  },
  {
    matches: (specifier) => isPackageOrSubpath(specifier, 'lucide-solid'),
    name: 'Solid icon package',
  },
  {
    matches: (specifier) =>
      isPackageOrSubpath(specifier, '@ark-ui/solid') || isPackageOrSubpath(specifier, '@zag-js/solid'),
    name: 'Ark Solid package',
  },
  {
    matches: (specifier) => isPackageOrSubpath(specifier, 'nitro') || isPackageOrSubpath(specifier, 'nitropack'),
    name: 'Nitro package',
  },
];

const sourceMarkerRules = [
  { name: 'createServerFn wrapper', pattern: /\bcreateServerFn\b/gu },
  { name: '_serverFn route', pattern: /_serverFn/gu },
  { name: 'server-function warmup', pattern: /\bwarmup\b/giu },
  { name: 'Nitro runner workaround', pattern: /nitro-loopback/giu },
] as const;

const emittedPackagePatterns = [
  { name: 'TanStack Solid adapter', pattern: /@tanstack\/solid-[A-Za-z0-9._/-]*/gu },
  { name: 'TanStack Start package', pattern: /@tanstack\/start-[A-Za-z0-9._/-]*/gu },
  { name: 'TanStack Router package', pattern: /@tanstack\/router-[A-Za-z0-9._/-]*/gu },
  { name: 'Solid runtime', pattern: /(?:^|[^A-Za-z0-9_/-])(solid-js(?:\/[A-Za-z0-9._/-]*)?)/gu },
  { name: 'Solid support package', pattern: /@(?:solidjs|solid-primitives)\/[A-Za-z0-9._/-]+/gu },
  {
    name: 'Solid Vite package',
    pattern:
      /(?:^|[^A-Za-z0-9_/-])((?:babel-preset-solid|solid-refresh|vite-plugin-solid|vite-solid)(?:\/[A-Za-z0-9._/-]*)?)/gu,
  },
  {
    name: 'Solid icon package',
    pattern: /(?:^|[^A-Za-z0-9_/-])(lucide-solid(?:\/[A-Za-z0-9._/-]*)?)/gu,
  },
  { name: 'Ark Solid package', pattern: /@(?:ark-ui|zag-js)\/solid(?:\/[A-Za-z0-9._/-]*)?/gu },
  {
    name: 'Nitro package',
    pattern: /(?:^|[^A-Za-z0-9_/-])((?:nitro|nitropack)(?:\/[A-Za-z0-9._/-]*)?)(?=$|[^A-Za-z0-9_/-])/gu,
  },
] as const;

const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
};

const matchingRetiredPackageRule = (rawSpecifier: string): RetiredPackageRule | undefined => {
  const specifier = withoutModuleQuery(rawSpecifier);
  return retiredPackageRules.find((rule) => rule.matches(specifier));
};

export const isTrackedWebProductionSource = (relativeFile: string): boolean => {
  const normalizedFile = normalizeSeparators(relativeFile);
  if (testOnlySourcePattern.test(normalizedFile)) {
    return false;
  }
  const isWebSource = normalizedFile.startsWith('apps/web/');
  const isDesignSystemSource = normalizedFile.startsWith('packages/design-system/src/');
  if (!(isWebSource || isDesignSystemSource)) {
    return false;
  }
  if (normalizedFile.startsWith('apps/web/migration-parity/')) {
    return false;
  }
  if (normalizedFile.startsWith('apps/web/src/')) {
    return sourceExtensions.has(path.extname(normalizedFile));
  }
  return sourceExtensions.has(path.extname(normalizedFile)) && !normalizedFile.includes('/e2e/');
};

export const scanWebProductionSource = (file: string, text: string): readonly WebRetiredStackViolation[] => {
  const violations: WebRetiredStackViolation[] = [];
  if (path.extname(file) === '.tsx') {
    violations.push({
      file,
      line: 1,
      rule: 'retired production TSX source',
      surface: 'source-marker',
      value: file,
    });
  }
  for (const match of text.matchAll(moduleImportPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    const rule = specifier ? matchingRetiredPackageRule(specifier) : undefined;
    if (specifier && rule) {
      violations.push({
        file,
        line: lineAt(text, match.index),
        rule: rule.name,
        surface: 'source-import',
        value: specifier,
      });
    }
  }
  for (const markerRule of sourceMarkerRules) {
    for (const match of text.matchAll(markerRule.pattern)) {
      violations.push({
        file,
        line: lineAt(text, match.index),
        rule: markerRule.name,
        surface: 'source-marker',
        value: match[0],
      });
    }
  }
  return violations;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const scanPackageManifest = (file: string, text: string): readonly WebRetiredStackViolation[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Package manifest ${file} is not valid JSON.`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`Package manifest ${file} must be a JSON object.`);
  }
  const violations: WebRetiredStackViolation[] = [];
  for (const field of dependencyFields) {
    const entries = parsed[field];
    if (!isRecord(entries)) {
      continue;
    }
    for (const packageName of Object.keys(entries)) {
      const rule = matchingRetiredPackageRule(packageName);
      if (rule) {
        violations.push({
          file,
          line: lineAt(text, text.indexOf(`"${packageName}"`)),
          rule: rule.name,
          surface: 'dependency',
          value: `${field satisfies DependencyField}:${packageName}`,
        });
      }
    }
  }
  return violations;
};

export const scanBunLockfile = (file: string, text: string): readonly WebRetiredStackViolation[] => {
  const violations: WebRetiredStackViolation[] = [];
  const quotedPackagePattern = /"([@A-Za-z0-9][A-Za-z0-9@._/-]*)"/gu;
  const seen = new Set<string>();
  for (const match of text.matchAll(quotedPackagePattern)) {
    const packageName = match[1];
    const rule = packageName ? matchingRetiredPackageRule(packageName) : undefined;
    if (!(packageName && rule)) {
      continue;
    }
    const key = `${match.index}:${rule.name}:${packageName}`;
    if (!seen.has(key)) {
      seen.add(key);
      violations.push({
        file,
        line: lineAt(text, match.index),
        rule: rule.name,
        surface: 'lockfile',
        value: packageName,
      });
    }
  }
  return violations;
};

export const scanEmittedWebOutput = (file: string, text: string): readonly WebRetiredStackViolation[] => {
  const violations: WebRetiredStackViolation[] = [];
  for (const rule of emittedPackagePatterns) {
    for (const match of text.matchAll(rule.pattern)) {
      violations.push({
        file,
        line: lineAt(text, match.index),
        rule: rule.name,
        surface: 'emitted-output',
        value: match[1] ?? match[0],
      });
    }
  }
  for (const markerRule of sourceMarkerRules) {
    if (markerRule.name === 'server-function warmup') {
      continue;
    }
    for (const match of text.matchAll(markerRule.pattern)) {
      violations.push({
        file,
        line: lineAt(text, match.index),
        rule: markerRule.name,
        surface: 'emitted-output',
        value: match[0],
      });
    }
  }
  return violations;
};

const trackedFilesAt = async (workspaceRoot: string): Promise<readonly string[]> => {
  const subprocess = Bun.spawn(['git', 'ls-files', '-z'], {
    cwd: workspaceRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Unable to enumerate tracked files for the retired-stack check: ${stderr.trim()}`);
  }
  return stdout.split('\0').filter(Boolean);
};

const emittedFilesAt = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await emittedFilesAt(entryPath)));
    } else if (entry.isFile() && emittedTextExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
};

export const checkWebRetiredStack = async (
  workspaceRoot: string,
  options: CheckWebRetiredStackOptions = {},
): Promise<readonly WebRetiredStackViolation[]> => {
  const trackedFiles = options.trackedFiles ?? (await trackedFilesAt(workspaceRoot));
  const violations: WebRetiredStackViolation[] = [];
  for (const relativeFile of trackedFiles) {
    const normalizedFile = normalizeSeparators(relativeFile);
    if (isTrackedWebProductionSource(normalizedFile)) {
      violations.push(
        ...scanWebProductionSource(normalizedFile, await readFile(path.join(workspaceRoot, relativeFile), 'utf8')),
      );
    } else if (path.basename(normalizedFile) === 'package.json') {
      violations.push(
        ...scanPackageManifest(normalizedFile, await readFile(path.join(workspaceRoot, relativeFile), 'utf8')),
      );
    } else if (normalizedFile === 'bun.lock') {
      violations.push(
        ...scanBunLockfile(normalizedFile, await readFile(path.join(workspaceRoot, relativeFile), 'utf8')),
      );
    }
  }

  if (options.requireBuildOutput) {
    const outputDirectory = path.join(workspaceRoot, 'apps/web/.output-build/sveltekit');
    let emittedFiles: readonly string[];
    try {
      emittedFiles = await emittedFilesAt(outputDirectory);
    } catch (error) {
      throw new Error(`Unable to read the selected SvelteKit output at ${outputDirectory}. Run bun run build first.`, {
        cause: error,
      });
    }
    if (emittedFiles.length === 0) {
      throw new Error(`The selected SvelteKit output at ${outputDirectory} contains no scannable emitted files.`);
    }
    for (const emittedFile of emittedFiles) {
      const relativeFile = normalizeSeparators(path.relative(workspaceRoot, emittedFile));
      violations.push(...scanEmittedWebOutput(relativeFile, await readFile(emittedFile, 'utf8')));
    }
  }
  return violations;
};

const reportViolations = (violations: readonly WebRetiredStackViolation[]): void => {
  if (violations.length === 0) {
    return;
  }
  console.error('The Web retired-stack check found forbidden production references.');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} [${violation.surface}] ${violation.value} (${violation.rule})`);
  }
  process.exitCode = 1;
};

if (import.meta.main) {
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--require-build-output');
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown retired-stack check arguments: ${unknownArguments.join(', ')}`);
  }
  const workspaceRoot = path.resolve(import.meta.dir, '..');
  reportViolations(
    await checkWebRetiredStack(workspaceRoot, {
      requireBuildOutput: process.argv.includes('--require-build-output'),
    }),
  );
}
