import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ignoredDirectories = new Set(['.git', '.turbo', '.output', 'dist', 'node_modules', 'styled-system']);
const checkedExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const workspacePackageParents = ['apps', 'packages'];
const workspaceImportPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?['"](@ai-usage\/[^'"]+)['"]|\bimport\(\s*['"](@ai-usage\/[^'"]+)['"]\s*\)/g;

type PackageInterface = {
  exports: Set<string>;
  packageName: string;
};

type Violation = {
  file: string;
  line: number;
  message: string;
  specifier: string;
};

const root = process.cwd();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const packageExportKeys = (exportsValue: unknown) => {
  if (typeof exportsValue === 'string') return new Set(['.']);
  if (!isRecord(exportsValue)) return new Set<string>();
  return new Set(Object.keys(exportsValue).filter((key) => key === '.' || key.startsWith('./')));
};

async function readPackageInterface(packageJsonPath: string): Promise<PackageInterface | null> {
  let text: string;
  try {
    text = await readFile(packageJsonPath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  const json = JSON.parse(text) as unknown;
  if (!isRecord(json) || typeof json.name !== 'string' || !json.name.startsWith('@ai-usage/')) return null;
  return {
    exports: packageExportKeys(json.exports),
    packageName: json.name,
  };
}

async function discoverWorkspacePackages() {
  const packages = new Map<string, PackageInterface>();
  for (const parent of workspacePackageParents) {
    const parentPath = path.join(root, parent);
    const entries = await readdir(parentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageInterface = await readPackageInterface(path.join(parentPath, entry.name, 'package.json'));
      if (packageInterface) packages.set(packageInterface.packageName, packageInterface);
    }
  }
  return packages;
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...(await collectSourceFiles(path.join(directory, entry.name))));
      continue;
    }

    if (entry.isFile() && checkedExtensions.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }

  return files;
}

const lineNumberFor = (text: string, index: number) => text.slice(0, index).split('\n').length;

const parseWorkspaceSpecifier = (specifier: string) => {
  const [, packageSegment, ...subpathParts] = specifier.split('/');
  if (!packageSegment) return null;
  return {
    exportKey: subpathParts.length ? `./${subpathParts.join('/')}` : '.',
    packageName: `@ai-usage/${packageSegment}`,
  };
};

async function collectViolations(packages: Map<string, PackageInterface>) {
  const files = await collectSourceFiles(root);
  const violations: Violation[] = [];

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(workspaceImportPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const parsed = parseWorkspaceSpecifier(specifier);
      if (!parsed) continue;

      const packageInterface = packages.get(parsed.packageName);
      if (!packageInterface) {
        violations.push({
          file: path.relative(root, file),
          line: lineNumberFor(text, match.index),
          message: 'Unknown @ai-usage workspace package import.',
          specifier,
        });
        continue;
      }

      if (!packageInterface.exports.has(parsed.exportKey)) {
        violations.push({
          file: path.relative(root, file),
          line: lineNumberFor(text, match.index),
          message: `Import is not declared in ${parsed.packageName} package exports.`,
          specifier,
        });
      }
    }
  }

  return violations;
}

const packages = await discoverWorkspacePackages();
const violations = await collectViolations(packages);

if (violations.length > 0) {
  console.error('Workspace package imports must go through declared public package exports.');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} ${violation.specifier} - ${violation.message}`);
  }
  process.exitCode = 1;
}
