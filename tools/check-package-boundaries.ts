import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const workspacePackageParents = ['apps', 'packages'];
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const ignoredDirectories = new Set([
  '.git',
  '.turbo',
  '.output',
  '.worktrees',
  'dist',
  'node_modules',
  'styled-system',
]);
const checkedExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const workspaceImportPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?['"](@ai-usage\/[^'"]+)['"]|\bimport\(\s*['"](@ai-usage\/[^'"]+)['"]\s*\)|\brequire\(\s*['"](@ai-usage\/[^'"]+)['"]\s*\)/g;

type DependencyField = (typeof dependencyFields)[number];

interface BoundaryPolicy {
  forbiddenDependencies: string[];
  forbiddenImports: string[];
  packageName: string;
  reason: string;
}

interface PackageInfo {
  dependencies: Map<string, DependencyField>;
  directory: string;
  packageName: string;
}

export interface PackageBoundaryViolation {
  file: string;
  line?: number;
  message: string;
  packageName: string;
  specifier: string;
}

const workspacePackageScope = '@ai-usage/';
const retiredPackages = [`${workspacePackageScope}lan-pairing`, `${workspacePackageScope}sync`] as const;

// packages/report-core is pure domain calculation. Workspace runtime imports would make report types depend
// on collection, storage, transport, or app execution.
// packages/usage-store owns SQLite/materialized facts. It must not know about collection, report payloads,
// file-transfer orchestration, or app adapters.
// packages/report-data may read stored imported rows, but it must not depend on app adapters.
// packages/usage-merge orchestrates manual merge bundle import/export. It must not import app packages or
// final report payload orchestration.
// packages/skills owns a local filesystem control plane. It must remain independent from reporting,
// persistence, transport, and app packages.
const boundaryPolicies: BoundaryPolicy[] = [
  {
    packageName: '@ai-usage/effect-runtime',
    forbiddenDependencies: ['@ai-usage/*'],
    forbiddenImports: ['@ai-usage/*'],
    reason: 'effect-runtime must stay domain-free and independent of workspace packages.',
  },
  {
    packageName: '@ai-usage/report-core',
    forbiddenDependencies: ['@ai-usage/*'],
    forbiddenImports: ['@ai-usage/*'],
    reason: 'report-core must stay pure and independent of workspace runtime packages.',
  },
  {
    packageName: '@ai-usage/skills',
    forbiddenDependencies: ['@ai-usage/*'],
    forbiddenImports: ['@ai-usage/*'],
    reason: 'skills must stay independent of workspace runtime packages.',
  },
  {
    packageName: '@ai-usage/usage-store',
    forbiddenDependencies: [
      '@ai-usage/local-collectors',
      '@ai-usage/report-data',
      '@ai-usage/usage-merge',
      '@ai-usage/web',
      '@ai-usage/cli',
    ],
    forbiddenImports: [
      '@ai-usage/local-collectors',
      '@ai-usage/report-data',
      '@ai-usage/usage-merge',
      '@ai-usage/web',
      '@ai-usage/cli',
    ],
    reason: 'usage-store must not depend on collectors, file-transfer orchestration, app packages, or report-data.',
  },
  {
    packageName: '@ai-usage/report-data',
    forbiddenDependencies: ['@ai-usage/web', '@ai-usage/cli'],
    forbiddenImports: ['@ai-usage/web', '@ai-usage/cli'],
    reason: 'report-data must not import app packages.',
  },
  {
    packageName: '@ai-usage/cli',
    forbiddenDependencies: ['@ai-usage/usage-store'],
    forbiddenImports: ['@ai-usage/usage-store'],
    reason: 'CLI application workflows must reach durable usage data through report-data.',
  },
  {
    packageName: '@ai-usage/usage-merge',
    forbiddenDependencies: [
      '@ai-usage/local-collectors',
      '@ai-usage/report-data',
      retiredPackages[1],
      '@ai-usage/web',
      '@ai-usage/cli',
    ],
    forbiddenImports: [
      '@ai-usage/local-collectors',
      '@ai-usage/report-data',
      retiredPackages[1],
      '@ai-usage/web',
      '@ai-usage/cli',
    ],
    reason:
      'usage-merge file-transfer orchestration must not import collectors, network sync, final report payload orchestration, or app adapters.',
  },
  {
    packageName: '@ai-usage/web',
    forbiddenDependencies: ['@ai-usage/cli', ...retiredPackages],
    forbiddenImports: ['@ai-usage/cli', ...retiredPackages],
    reason: 'web must not import CLI or retired network adapter packages.',
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const matchesPattern = (specifier: string, pattern: string) => {
  if (pattern.endsWith('/*')) {
    return specifier.startsWith(pattern.slice(0, -1));
  }
  return specifier === pattern || specifier.startsWith(`${pattern}/`);
};

async function readPackageInfo(packageJsonPath: string): Promise<PackageInfo | null> {
  let text: string;
  try {
    text = await readFile(packageJsonPath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const json = JSON.parse(text) as unknown;
  if (!isRecord(json) || typeof json.name !== 'string' || !json.name.startsWith('@ai-usage/')) {
    return null;
  }

  const dependencies = new Map<string, DependencyField>();
  for (const field of dependencyFields) {
    const value = json[field];
    if (!isRecord(value)) {
      continue;
    }
    for (const dependencyName of Object.keys(value)) {
      dependencies.set(dependencyName, field);
    }
  }

  return {
    dependencies,
    directory: path.dirname(packageJsonPath),
    packageName: json.name,
  };
}

async function discoverWorkspacePackages(root: string) {
  const packages = new Map<string, PackageInfo>();
  for (const parent of workspacePackageParents) {
    const parentPath = path.join(root, parent);
    const entries = await readdir(parentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageInfo = await readPackageInfo(path.join(parentPath, entry.name, 'package.json'));
      if (packageInfo) {
        packages.set(packageInfo.packageName, packageInfo);
      }
    }
  }
  return packages;
}

async function collectSourceFiles(directory: string): Promise<string[]> {
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

const lineNumberFor = (text: string, index: number) => text.slice(0, index).split('\n').length;

function collectDependencyViolations(
  root: string,
  packages: Map<string, PackageInfo>,
  policy: BoundaryPolicy,
): PackageBoundaryViolation[] {
  const packageInfo = packages.get(policy.packageName);
  if (!packageInfo) {
    return [];
  }

  const violations: PackageBoundaryViolation[] = [];
  for (const [dependencyName, field] of packageInfo.dependencies) {
    if (!policy.forbiddenDependencies.some((pattern) => matchesPattern(dependencyName, pattern))) {
      continue;
    }
    violations.push({
      file: path.relative(root, path.join(packageInfo.directory, 'package.json')),
      message: `${policy.reason} Forbidden ${field} entry.`,
      packageName: policy.packageName,
      specifier: dependencyName,
    });
  }
  return violations;
}

async function collectImportViolations(
  root: string,
  packageInfo: PackageInfo,
  policy: BoundaryPolicy,
): Promise<PackageBoundaryViolation[]> {
  const violations: PackageBoundaryViolation[] = [];
  const files = await collectSourceFiles(packageInfo.directory);

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(workspaceImportPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) {
        continue;
      }
      if (!policy.forbiddenImports.some((pattern) => matchesPattern(specifier, pattern))) {
        continue;
      }
      violations.push({
        file: path.relative(root, file),
        line: lineNumberFor(text, match.index),
        message: `${policy.reason} Forbidden import.`,
        packageName: policy.packageName,
        specifier,
      });
    }
  }

  return violations;
}

const retiredPackagePolicyFor = (packageName: string): BoundaryPolicy => ({
  packageName,
  forbiddenDependencies: [...retiredPackages],
  forbiddenImports: [...retiredPackages],
  reason: 'retired workspace packages must not return in manifests or source imports.',
});

export async function collectViolations(root: string): Promise<PackageBoundaryViolation[]> {
  const packages = await discoverWorkspacePackages(root);
  const violations: PackageBoundaryViolation[] = [];

  for (const policy of boundaryPolicies) {
    const packageInfo = packages.get(policy.packageName);
    violations.push(...collectDependencyViolations(root, packages, policy));
    if (packageInfo) {
      violations.push(...(await collectImportViolations(root, packageInfo, policy)));
    }
  }

  for (const packageInfo of packages.values()) {
    if (retiredPackages.includes(packageInfo.packageName as (typeof retiredPackages)[number])) {
      violations.push({
        file: path.relative(root, path.join(packageInfo.directory, 'package.json')),
        message: 'retired workspace packages must not be recreated.',
        packageName: packageInfo.packageName,
        specifier: packageInfo.packageName,
      });
    }
    const policy = retiredPackagePolicyFor(packageInfo.packageName);
    violations.push(...collectDependencyViolations(root, packages, policy));
    violations.push(...(await collectImportViolations(root, packageInfo, policy)));
  }

  const uniqueViolations = new Map<string, PackageBoundaryViolation>();
  for (const violation of violations) {
    const key = [violation.file, violation.line ?? '', violation.packageName, violation.specifier].join(':');
    if (!uniqueViolations.has(key)) {
      uniqueViolations.set(key, violation);
    }
  }

  return [...uniqueViolations.values()];
}

const reportViolations = (violations: PackageBoundaryViolation[]): void => {
  if (violations.length === 0) {
    return;
  }

  console.error('Workspace package boundaries were violated.');
  for (const violation of violations) {
    const location = violation.line === undefined ? violation.file : `${violation.file}:${violation.line}`;
    console.error(`${location} ${violation.packageName} -> ${violation.specifier} - ${violation.message}`);
  }
  process.exitCode = 1;
};

if (import.meta.main) {
  reportViolations(await collectViolations(process.cwd()));
}
