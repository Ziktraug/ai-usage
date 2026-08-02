import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const workspacePackageParents = ['apps', 'packages'];
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const productionDependencyFields = new Set<DependencyField>([
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
]);
const ignoredDirectories = new Set([
  '.git',
  '.output',
  '.output-build',
  '.output-dev',
  '.turbo',
  'dist',
  'node_modules',
  'styled-system',
]);
const checkedExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.svelte', '.ts', '.tsx']);
const workspaceImportPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?['"](@ai-usage\/[^'"]+)['"]|\bimport\(\s*['"](@ai-usage\/[^'"]+)['"]\s*\)|\brequire\(\s*['"](@ai-usage\/[^'"]+)['"]\s*\)/g;
const moduleImportPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

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
// packages/report-data may read stored imported rows, but it must not depend on collectors or app adapters.
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
    forbiddenDependencies: ['@ai-usage/local-collectors', '@ai-usage/report-data', '@ai-usage/web', '@ai-usage/cli'],
    forbiddenImports: ['@ai-usage/local-collectors', '@ai-usage/report-data', '@ai-usage/web', '@ai-usage/cli'],
    reason: 'usage-store must not depend on collectors, app packages, or report-data.',
  },
  {
    packageName: '@ai-usage/report-data',
    forbiddenDependencies: ['@ai-usage/effect-runtime', '@ai-usage/local-collectors', '@ai-usage/web', '@ai-usage/cli'],
    forbiddenImports: ['@ai-usage/effect-runtime', '@ai-usage/local-collectors', '@ai-usage/web', '@ai-usage/cli'],
    reason: 'report-data must stay collector-free and must not import runtime or app packages.',
  },
  {
    packageName: '@ai-usage/usage-merge',
    forbiddenDependencies: ['@ai-usage/local-collectors', '@ai-usage/report-data', '@ai-usage/web', '@ai-usage/cli'],
    forbiddenImports: ['@ai-usage/local-collectors', '@ai-usage/report-data', '@ai-usage/web', '@ai-usage/cli'],
    reason: 'usage-merge owns only the store-backed manual merge workflow.',
  },
  {
    packageName: '@ai-usage/cli',
    forbiddenDependencies: ['@ai-usage/local-collectors'],
    forbiddenImports: ['@ai-usage/local-collectors'],
    reason: 'CLI collection must run through the usage engine, never local collectors.',
  },
  {
    packageName: '@ai-usage/web',
    forbiddenDependencies: ['@ai-usage/cli', '@ai-usage/local-collectors', ...retiredPackages],
    forbiddenImports: ['@ai-usage/cli', '@ai-usage/local-collectors', ...retiredPackages],
    reason: 'web must not import CLI, collectors, or retired network adapter packages.',
  },
  {
    packageName: '@ai-usage/local-machine',
    forbiddenDependencies: [
      '@ai-usage/local-collectors',
      '@ai-usage/report-data',
      '@ai-usage/usage-engine-control',
      '@ai-usage/usage-engine-runtime',
      '@ai-usage/usage-store',
      '@ai-usage/web',
      '@ai-usage/cli',
    ],
    forbiddenImports: [
      '@ai-usage/local-collectors',
      '@ai-usage/report-data',
      '@ai-usage/usage-engine-control',
      '@ai-usage/usage-engine-runtime',
      '@ai-usage/usage-store',
      '@ai-usage/web',
      '@ai-usage/cli',
    ],
    reason: 'local-machine must stay independent from collectors, report storage, engine transport/runtime, and apps.',
  },
];

const usageStorePackage = '@ai-usage/usage-store';
const usageStoreReader = `${usageStorePackage}/reader`;
const usageStoreWriter = `${usageStorePackage}/writer`;
const usageStoreTesting = `${usageStorePackage}/testing`;
const engineControlPackage = '@ai-usage/usage-engine-control';
const engineControlTesting = `${engineControlPackage}/testing`;
const engineRuntimePackage = '@ai-usage/usage-engine-runtime';
const engineAppPackage = '@ai-usage/usage-engine';
const usageMergePackage = '@ai-usage/usage-merge';
const localMachinePackage = '@ai-usage/local-machine';
const localMachineCampaignLabelConfig = `${localMachinePackage}/campaign-label-config`;
const localMachineSessionDetail = `${localMachinePackage}/session-detail`;
const localMachineSkillsConfig = `${localMachinePackage}/skills-config`;
const localMachineTestingHarnessHome = `${localMachinePackage}/testing/harness-home`;
const reportDataPackage = '@ai-usage/report-data';
const reportDataPortableReport = `${reportDataPackage}/portable-report`;

const engineRuntimeAllowedWorkspaceDependencies = new Set([
  '@ai-usage/effect-runtime',
  '@ai-usage/local-collectors',
  '@ai-usage/local-machine',
  '@ai-usage/report-core',
  '@ai-usage/report-data',
  '@ai-usage/usage-engine-control',
  usageMergePackage,
  usageStorePackage,
]);
const testOnlySourcePattern =
  /(?:^|\/)(?:__tests__|e2e|fixture|fixtures|test|tests)(?:\/|$)|(?:^|[.-])(?:e2e|spec|test)\.[^/]+$/u;

const isWorkspaceSpecifier = (specifier: string): boolean => specifier.startsWith(workspacePackageScope);

const isTestOnlySource = (relativeFile: string): boolean => testOnlySourcePattern.test(relativeFile);

const isPackageOrSubpath = (specifier: string, packageName: string): boolean =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

const workspacePackageNameFor = (specifier: string): string => specifier.split('/').slice(0, 2).join('/');

const targetDependencyReason = (
  packageName: string,
  specifier: string,
  applicationPackages: ReadonlySet<string>,
): string | undefined => {
  if (!isWorkspaceSpecifier(specifier)) {
    return;
  }
  const dependencyPackage = workspacePackageNameFor(specifier);
  if (packageName === engineControlPackage && dependencyPackage !== '@ai-usage/report-core') {
    return 'usage-engine-control may depend only on pure report-core contracts.';
  }
  if (packageName === engineRuntimePackage && !engineRuntimeAllowedWorkspaceDependencies.has(dependencyPackage)) {
    return 'usage-engine-runtime may depend only on its explicit write-side domain packages.';
  }
  if (dependencyPackage === usageMergePackage && packageName !== engineRuntimePackage) {
    return 'Only usage-engine-runtime may depend on the writer-capable usage-merge package.';
  }
  if (
    packageName === usageMergePackage &&
    dependencyPackage !== '@ai-usage/report-core' &&
    dependencyPackage !== usageStorePackage
  ) {
    return 'usage-merge may depend only on report-core and usage-store.';
  }
  if (dependencyPackage === engineRuntimePackage && packageName !== engineAppPackage) {
    return 'Only apps/usage-engine may depend on usage-engine-runtime.';
  }
  if (
    packageName === usageStorePackage &&
    (dependencyPackage === engineControlPackage ||
      dependencyPackage === engineRuntimePackage ||
      applicationPackages.has(dependencyPackage))
  ) {
    return 'usage-store must remain independent from engine contracts, runtime, and applications.';
  }
  return;
};

const targetImportReason = (
  packageName: string,
  relativeFile: string,
  specifier: string,
  applicationPackages: ReadonlySet<string>,
): string | undefined => {
  if (
    (isPackageOrSubpath(specifier, usageStoreTesting) || isPackageOrSubpath(specifier, engineControlTesting)) &&
    isTestOnlySource(relativeFile)
  ) {
    return;
  }
  if (specifier === usageStorePackage) {
    return 'The mixed usage-store root is retired; import reader, writer, or testing explicitly.';
  }
  if (
    (packageName === '@ai-usage/web' || packageName === '@ai-usage/cli') &&
    specifier.startsWith(`${usageStorePackage}/`) &&
    specifier !== usageStoreReader
  ) {
    return 'Web and CLI may import only the usage-store reader facade.';
  }
  if (isPackageOrSubpath(specifier, usageMergePackage) && packageName !== engineRuntimePackage) {
    return 'Only usage-engine-runtime may import the writer-capable usage-merge package.';
  }
  if (
    isPackageOrSubpath(specifier, usageStoreWriter) &&
    packageName !== engineRuntimePackage &&
    packageName !== usageMergePackage
  ) {
    return 'Only usage-engine-runtime and usage-merge may import the usage-store writer facade.';
  }
  if (isPackageOrSubpath(specifier, engineRuntimePackage) && packageName !== engineAppPackage) {
    return 'Only apps/usage-engine may compose usage-engine-runtime.';
  }
  if (packageName === '@ai-usage/cli' && isPackageOrSubpath(specifier, engineAppPackage)) {
    return 'CLI may locate the foreground engine executable but must not import the engine application.';
  }
  if (
    (packageName === '@ai-usage/web' || packageName === '@ai-usage/cli') &&
    isPackageOrSubpath(specifier, localMachinePackage)
  ) {
    const isAllowedWebOperation =
      packageName === '@ai-usage/web' &&
      (specifier === localMachineCampaignLabelConfig ||
        specifier === localMachineSessionDetail ||
        specifier === localMachineSkillsConfig);
    const isAllowedTestFixture = specifier === localMachineTestingHarnessHome && isTestOnlySource(relativeFile);
    if (!(isAllowedWebOperation || isAllowedTestFixture)) {
      return 'Web may import only local-machine campaign-label-config/session-detail/skills-config; CLI has no local-machine data path.';
    }
  }
  if (
    packageName === '@ai-usage/cli' &&
    isPackageOrSubpath(specifier, reportDataPackage) &&
    specifier !== reportDataPortableReport
  ) {
    return 'CLI may import only the collector-free report-data portable-report facade.';
  }
  if (isPackageOrSubpath(specifier, usageStoreTesting) || isPackageOrSubpath(specifier, engineControlTesting)) {
    return 'Testing adapters may be imported only by test or fixture source.';
  }
  if (
    packageName === engineControlPackage &&
    isWorkspaceSpecifier(specifier) &&
    !isPackageOrSubpath(specifier, '@ai-usage/report-core')
  ) {
    return 'usage-engine-control may import only pure report-core contracts.';
  }
  if (packageName === engineRuntimePackage && isWorkspaceSpecifier(specifier)) {
    const dependencyName = workspacePackageNameFor(specifier);
    if (!engineRuntimeAllowedWorkspaceDependencies.has(dependencyName)) {
      return 'usage-engine-runtime may import only its explicit write-side domain packages.';
    }
    if (dependencyName === usageStorePackage && specifier !== usageStoreWriter) {
      return 'usage-engine-runtime must use the explicit usage-store writer facade.';
    }
  }
  if (
    packageName === usageStorePackage &&
    (isPackageOrSubpath(specifier, engineControlPackage) ||
      isPackageOrSubpath(specifier, engineRuntimePackage) ||
      applicationPackages.has(workspacePackageNameFor(specifier)))
  ) {
    return 'usage-store must remain independent from engine contracts, runtime, and applications.';
  }
  if (
    packageName === '@ai-usage/report-data' &&
    specifier.startsWith(`${usageStorePackage}/`) &&
    specifier !== usageStoreReader
  ) {
    return 'report-data may import only the usage-store reader facade.';
  }
  return;
};

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

const collectTargetDependencyViolations = (
  root: string,
  packageInfo: PackageInfo,
  applicationPackages: ReadonlySet<string>,
): PackageBoundaryViolation[] => {
  const violations: PackageBoundaryViolation[] = [];
  for (const [specifier, field] of packageInfo.dependencies) {
    const reason = targetDependencyReason(packageInfo.packageName, specifier, applicationPackages);
    if (reason === undefined) {
      continue;
    }
    violations.push({
      file: path.relative(root, path.join(packageInfo.directory, 'package.json')),
      message: `${reason} Forbidden ${field} entry.`,
      packageName: packageInfo.packageName,
      specifier,
    });
  }
  return violations;
};

const collectTargetImportViolations = async (
  root: string,
  packageInfo: PackageInfo,
  applicationPackages: ReadonlySet<string>,
): Promise<PackageBoundaryViolation[]> => {
  const violations: PackageBoundaryViolation[] = [];
  const files = await collectSourceFiles(packageInfo.directory);
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const relativeFile = path.relative(root, file).split(path.sep).join('/');
    for (const match of text.matchAll(workspaceImportPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) {
        continue;
      }
      const reason = targetImportReason(packageInfo.packageName, relativeFile, specifier, applicationPackages);
      if (reason === undefined) {
        continue;
      }
      violations.push({
        file: relativeFile,
        line: lineNumberFor(text, match.index),
        message: reason,
        packageName: packageInfo.packageName,
        specifier,
      });
    }
  }
  return violations;
};

const sourceModuleExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.svelte'] as const;
const emittedExtensionSources = new Map<string, readonly string[]>([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
]);

const resolveRelativeModule = async (packageDirectory: string, importer: string, specifier: string) => {
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

const collectPortableReportClosureViolations = async (
  root: string,
  packages: Map<string, PackageInfo>,
): Promise<PackageBoundaryViolation[]> => {
  const packageInfo = packages.get(reportDataPackage);
  if (!packageInfo) {
    return [];
  }
  const entrypoint = path.join(packageInfo.directory, 'src', 'portable-report.ts');
  const entrypointExists = await readFile(entrypoint, 'utf8').then(
    () => true,
    () => false,
  );
  if (!entrypointExists) {
    return [];
  }

  const violations: PackageBoundaryViolation[] = [];
  const pending = [entrypoint];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!(file && !visited.has(file))) {
      continue;
    }
    visited.add(file);
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(moduleImportPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) {
        continue;
      }
      if (isWorkspaceSpecifier(specifier)) {
        if (!isPackageOrSubpath(specifier, '@ai-usage/report-core')) {
          violations.push({
            file: path.relative(root, file).split(path.sep).join('/'),
            line: lineNumberFor(text, match.index),
            message: 'The portable-report import closure may depend only on report-core workspace modules.',
            packageName: reportDataPackage,
            specifier,
          });
        }
        continue;
      }
      if (specifier.startsWith('.')) {
        const resolved = await resolveRelativeModule(packageInfo.directory, file, specifier);
        if (resolved.status === 'resolved') {
          pending.push(resolved.file);
        } else {
          violations.push({
            file: path.relative(root, file).split(path.sep).join('/'),
            line: lineNumberFor(text, match.index),
            message: 'The portable-report import closure must resolve relative modules inside report-data.',
            packageName: reportDataPackage,
            specifier,
          });
        }
      }
    }
  }
  return violations;
};

const retiredPackagePolicyFor = (packageName: string): BoundaryPolicy => ({
  packageName,
  forbiddenDependencies: [...retiredPackages],
  forbiddenImports: [...retiredPackages],
  reason: 'retired workspace packages must not return in manifests or source imports.',
});

const collectProductionWorkspaceImportEdges = async (
  root: string,
  packages: ReadonlyMap<string, PackageInfo>,
): Promise<ReadonlyMap<string, ReadonlyMap<string, string>>> => {
  const edgesByPackage = new Map<string, ReadonlyMap<string, string>>();
  for (const packageInfo of packages.values()) {
    const edges = new Map<string, string>();
    const files = await collectSourceFiles(packageInfo.directory);
    for (const file of files) {
      const relativeFile = path.relative(root, file).split(path.sep).join('/');
      if (isTestOnlySource(relativeFile)) {
        continue;
      }
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(workspaceImportPattern)) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (specifier === undefined) {
          continue;
        }
        const dependencyName = workspacePackageNameFor(specifier);
        if (!edges.has(dependencyName)) {
          edges.set(dependencyName, relativeFile);
        }
      }
    }
    edgesByPackage.set(packageInfo.packageName, edges);
  }
  return edgesByPackage;
};

const collectApplicationProductionClosureViolations = async (
  root: string,
  packages: ReadonlyMap<string, PackageInfo>,
): Promise<PackageBoundaryViolation[]> => {
  const forbiddenPackages = new Set(['@ai-usage/local-collectors', engineRuntimePackage]);
  const violations: PackageBoundaryViolation[] = [];
  const importEdges = await collectProductionWorkspaceImportEdges(root, packages);
  for (const applicationPackage of ['@ai-usage/web', '@ai-usage/cli']) {
    if (!packages.has(applicationPackage)) {
      continue;
    }
    const pending = [{ packageName: applicationPackage, path: [applicationPackage] }];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.shift();
      if (!(current && !visited.has(current.packageName))) {
        continue;
      }
      visited.add(current.packageName);
      const packageInfo = packages.get(current.packageName);
      if (!packageInfo) {
        continue;
      }
      const dependencyEdges = new Map<string, string>();
      for (const [dependencyName, field] of packageInfo.dependencies) {
        if (!productionDependencyFields.has(field)) {
          continue;
        }
        dependencyEdges.set(
          dependencyName,
          path.relative(root, path.join(packageInfo.directory, 'package.json')).split(path.sep).join('/'),
        );
      }
      for (const [dependencyName, file] of importEdges.get(current.packageName) ?? []) {
        if (!dependencyEdges.has(dependencyName)) {
          dependencyEdges.set(dependencyName, file);
        }
      }
      for (const [dependencyName, file] of dependencyEdges) {
        const dependencyPath = [...current.path, dependencyName];
        if (forbiddenPackages.has(dependencyName)) {
          if (current.packageName !== applicationPackage) {
            violations.push({
              file,
              message: `${applicationPackage} production dependencies must stay collector- and engine-runtime-free. Reached through ${dependencyPath.join(' -> ')}.`,
              packageName: applicationPackage,
              specifier: dependencyName,
            });
          }
          continue;
        }
        const isCliExecutableBoundary = applicationPackage === '@ai-usage/cli' && dependencyName === engineAppPackage;
        if (packages.has(dependencyName) && !isCliExecutableBoundary) {
          pending.push({ packageName: dependencyName, path: dependencyPath });
        }
      }
    }
  }
  return violations;
};

export async function collectViolations(root: string): Promise<PackageBoundaryViolation[]> {
  const packages = await discoverWorkspacePackages(root);
  const violations: PackageBoundaryViolation[] = [];
  const applicationPackages = new Set(
    [...packages.values()]
      .filter((packageInfo) => path.relative(root, packageInfo.directory).split(path.sep)[0] === 'apps')
      .map(({ packageName }) => packageName),
  );
  violations.push(...(await collectPortableReportClosureViolations(root, packages)));
  violations.push(...(await collectApplicationProductionClosureViolations(root, packages)));

  for (const policy of boundaryPolicies) {
    const packageInfo = packages.get(policy.packageName);
    violations.push(...collectDependencyViolations(root, packages, policy));
    if (packageInfo) {
      violations.push(...(await collectImportViolations(root, packageInfo, policy)));
    }
  }

  for (const packageInfo of packages.values()) {
    violations.push(...collectTargetDependencyViolations(root, packageInfo, applicationPackages));
    violations.push(...(await collectTargetImportViolations(root, packageInfo, applicationPackages)));
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
