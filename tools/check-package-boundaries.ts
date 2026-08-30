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
    packageName: '@ai-usage/platform-core',
    forbiddenDependencies: ['@ai-usage/*', 'drizzle-orm', 'pg'],
    forbiddenImports: ['@ai-usage/*', 'bun:sqlite', 'drizzle-orm', 'node:fs', 'node:http', 'node:https', 'pg'],
    reason: 'platform-core must contain only portable identity values and contracts.',
  },
  {
    packageName: '@ai-usage/authorization-contract',
    forbiddenDependencies: ['drizzle-orm', 'pg'],
    forbiddenImports: ['bun:sqlite', 'drizzle-orm', 'node:fs', 'node:http', 'node:https', 'pg'],
    reason: 'authorization-contract contains only the portable Authorizer port and value contracts.',
  },
  {
    packageName: '@ai-usage/authorization',
    forbiddenDependencies: ['drizzle-orm', 'pg'],
    forbiddenImports: ['bun:sqlite', 'drizzle-orm', 'node:fs', 'node:http', 'node:https', 'pg'],
    reason: 'authorization owns the application port and local policy, not persistence or transport.',
  },
  {
    packageName: '@ai-usage/project-registry',
    forbiddenDependencies: ['drizzle-orm', 'pg'],
    forbiddenImports: ['bun:sqlite', 'drizzle-orm', 'node:fs', 'node:http', 'node:https', 'pg'],
    reason: 'project-registry owns pure resolution and mapping contracts, not persistence or transport.',
  },
  {
    packageName: '@ai-usage/project-application',
    forbiddenDependencies: ['drizzle-orm', 'pg'],
    forbiddenImports: ['bun:sqlite', 'drizzle-orm', 'node:fs', 'node:http', 'node:https', 'pg'],
    reason: 'project-application owns the application service and ports, not persistence or transport.',
  },
  {
    packageName: '@ai-usage/replication-protocol',
    forbiddenDependencies: ['drizzle-orm', 'pg'],
    forbiddenImports: ['bun:sqlite', 'drizzle-orm', 'node:fs', 'node:http', 'node:https', 'pg'],
    reason: 'replication-protocol is the IO-free canonical wire contract.',
  },
  {
    packageName: '@ai-usage/replication-outbox',
    forbiddenDependencies: ['drizzle-orm', 'pg'],
    forbiddenImports: ['drizzle-orm', 'node:fs', 'node:http', 'node:https', 'pg'],
    reason: 'replication-outbox owns portable state transitions, not a database or network adapter.',
  },
  {
    packageName: '@ai-usage/replication-client',
    forbiddenDependencies: [
      '@ai-usage/memory-sqlite',
      '@ai-usage/postgres-store',
      '@ai-usage/usage-store',
      'drizzle-orm',
      'pg',
    ],
    forbiddenImports: [
      '@ai-usage/memory-sqlite',
      '@ai-usage/postgres-store',
      '@ai-usage/usage-store',
      'bun:sqlite',
      'drizzle-orm',
      'node:fs',
      'pg',
    ],
    reason: 'replication-client is the outbound HTTPS adapter and must not own either persistence authority.',
  },
  {
    packageName: '@ai-usage/identity',
    forbiddenDependencies: ['@better-auth/drizzle-adapter', 'drizzle-orm', 'pg'],
    forbiddenImports: ['@better-auth/drizzle-adapter', 'bun:sqlite', 'drizzle-orm', 'pg'],
    reason: 'identity owns authentication and Device application services, not their persistence adapter.',
  },
  {
    packageName: '@ai-usage/memory-sqlite',
    forbiddenDependencies: ['@ai-usage/postgres-store', 'drizzle-orm', 'pg'],
    forbiddenImports: [
      '@ai-usage/postgres-store',
      '@ai-usage/usage-store',
      'drizzle-orm',
      'node:http',
      'node:https',
      'pg',
    ],
    reason: 'memory-sqlite is the dedicated local authority and must not reach PostgreSQL, Usage SQLite, or HTTP.',
  },
  {
    packageName: '@ai-usage/memory-service',
    forbiddenDependencies: ['@ai-usage/memory-sqlite', '@ai-usage/postgres-store', 'drizzle-orm', 'pg'],
    forbiddenImports: ['@ai-usage/memory-sqlite', '@ai-usage/postgres-store', 'bun:sqlite', 'drizzle-orm', 'pg'],
    reason: 'memory-service owns bounded transport contracts and discovery, never a storage adapter.',
  },
  {
    packageName: '@ai-usage/memory-search',
    forbiddenDependencies: ['@ai-usage/memory-sqlite', '@ai-usage/postgres-store', 'drizzle-orm', 'pg'],
    forbiddenImports: ['@ai-usage/memory-sqlite', '@ai-usage/postgres-store', 'bun:sqlite', 'drizzle-orm', 'pg'],
    reason: 'memory-search owns portable chunking and evaluation contracts, never a storage authority.',
  },
  {
    packageName: '@ai-usage/mcp-adapter',
    forbiddenDependencies: ['@ai-usage/memory-sqlite', '@ai-usage/postgres-store', 'bun:sqlite', 'drizzle-orm', 'pg'],
    forbiddenImports: ['@ai-usage/memory-sqlite', '@ai-usage/postgres-store', 'bun:sqlite', 'drizzle-orm', 'pg'],
    reason: 'mcp-adapter owns the bounded edge protocol and must call application services, never storage.',
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
    packageName: '@ai-usage/postgres-store',
    forbiddenDependencies: [],
    forbiddenImports: ['bun:sqlite', 'node:fs', 'node:http', 'node:https'],
    reason:
      'postgres-store may consume only pure platform contracts and must stay independent from local SQLite, HTTP, and repository harness files.',
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
    packageName: '@ai-usage/server',
    forbiddenDependencies: [
      '@ai-usage/cli',
      '@ai-usage/local-collectors',
      '@ai-usage/local-machine',
      '@ai-usage/usage-engine',
      '@ai-usage/usage-engine-control',
      '@ai-usage/usage-engine-runtime',
      '@ai-usage/usage-store',
      '@ai-usage/web',
    ],
    forbiddenImports: [
      '@ai-usage/cli',
      '@ai-usage/local-collectors',
      '@ai-usage/local-machine',
      '@ai-usage/usage-engine',
      '@ai-usage/usage-engine-control',
      '@ai-usage/usage-engine-runtime',
      '@ai-usage/usage-store',
      '@ai-usage/web',
    ],
    reason: 'server must not compose local usage, collection, machine, CLI, or Web runtimes.',
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
const usageStorePerformanceTesting = `${usageStorePackage}/performance-testing`;
const webPerformanceTestingImporter = 'apps/web/src/hooks.server.ts';
const usageStoreReader = `${usageStorePackage}/reader`;
const usageStoreWriter = `${usageStorePackage}/writer`;
const usageStoreTesting = `${usageStorePackage}/testing`;
const postgresStorePackage = '@ai-usage/postgres-store';
const postgresStoreMigrations = `${postgresStorePackage}/migrations`;
const postgresStorePerformanceTesting = `${postgresStorePackage}/performance-testing`;
const postgresStoreTesting = `${postgresStorePackage}/testing`;
const postgresStoreWriter = `${postgresStorePackage}/writer`;
const platformServerPackage = '@ai-usage/server';
const platformCorePackage = '@ai-usage/platform-core';
const authorizationContractPackage = '@ai-usage/authorization-contract';
const authorizationPackage = '@ai-usage/authorization';
const identityPackage = '@ai-usage/identity';
const identitySharedAuthentication = `${identityPackage}/better-auth`;
const identityTesting = `${identityPackage}/testing`;
const betterAuthPackage = 'better-auth';
const betterAuthDrizzleAdapter = '@better-auth/drizzle-adapter';
const authorizationScopeInternal = `${authorizationPackage}/scope-internal`;
const projectApplicationPackage = '@ai-usage/project-application';
const projectRegistryPackage = '@ai-usage/project-registry';
const memorySqlitePackage = '@ai-usage/memory-sqlite';
const memorySearchPackage = '@ai-usage/memory-search';
const memoryServicePackage = '@ai-usage/memory-service';
const mcpAdapterPackage = '@ai-usage/mcp-adapter';
const replicationClientPackage = '@ai-usage/replication-client';
const replicationOutboxPackage = '@ai-usage/replication-outbox';
const replicationProtocolPackage = '@ai-usage/replication-protocol';
const mcpSdkPackage = '@modelcontextprotocol/sdk';
const engineControlPackage = '@ai-usage/usage-engine-control';
const engineControlTesting = `${engineControlPackage}/testing`;
const engineRuntimePackage = '@ai-usage/usage-engine-runtime';
const engineAppPackage = '@ai-usage/usage-engine';
const usageMergePackage = '@ai-usage/usage-merge';
const localMachinePackage = '@ai-usage/local-machine';
const localMachineCampaignLabelConfig = `${localMachinePackage}/campaign-label-config`;
const localMachineSessionDetail = `${localMachinePackage}/session-detail`;
const localMachineSkillsConfig = `${localMachinePackage}/skills-config`;
const localMachineSourcePolicyConfig = `${localMachinePackage}/source-policy-config`;
const localMachineTestingHarnessHome = `${localMachinePackage}/testing/harness-home`;
const reportDataPackage = '@ai-usage/report-data';
const reportDataPortableReport = `${reportDataPackage}/portable-report`;

const engineRuntimeAllowedWorkspaceDependencies = new Set([
  '@ai-usage/effect-runtime',
  '@ai-usage/local-collectors',
  '@ai-usage/local-machine',
  '@ai-usage/report-core',
  '@ai-usage/report-data',
  '@ai-usage/replication-outbox',
  '@ai-usage/replication-protocol',
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
  if (specifier === betterAuthPackage && packageName !== identityPackage) {
    return 'Only identity may depend directly on Better Auth.';
  }
  if (specifier === betterAuthDrizzleAdapter && packageName !== postgresStorePackage) {
    return 'Only postgres-store may depend on the Better Auth Drizzle adapter.';
  }
  if (!isWorkspaceSpecifier(specifier)) {
    return;
  }
  const dependencyPackage = workspacePackageNameFor(specifier);
  if (
    packageName === postgresStorePackage &&
    dependencyPackage !== authorizationPackage &&
    dependencyPackage !== identityPackage &&
    dependencyPackage !== memorySearchPackage &&
    dependencyPackage !== memoryServicePackage &&
    dependencyPackage !== platformCorePackage &&
    dependencyPackage !== projectApplicationPackage &&
    dependencyPackage !== projectRegistryPackage &&
    dependencyPackage !== replicationProtocolPackage
  ) {
    return 'postgres-store may depend only on authorization, identity, Memory, platform-core, project, and replication contracts.';
  }
  if (
    packageName === identityPackage &&
    dependencyPackage !== authorizationPackage &&
    dependencyPackage !== platformCorePackage
  ) {
    return 'identity may depend only on authorization and portable platform-core workspace contracts.';
  }
  if (packageName === authorizationContractPackage && dependencyPackage !== platformCorePackage) {
    return 'authorization-contract may depend only on portable platform-core contracts.';
  }
  if (
    packageName === authorizationPackage &&
    dependencyPackage !== authorizationContractPackage &&
    dependencyPackage !== platformCorePackage
  ) {
    return 'authorization may depend only on its portable contract and platform-core.';
  }
  if (
    packageName === projectRegistryPackage &&
    dependencyPackage !== platformCorePackage &&
    dependencyPackage !== '@ai-usage/report-core'
  ) {
    return 'project-registry may depend only on authorization, platform-core, and pure report-core VCS contracts.';
  }
  if (
    packageName === projectApplicationPackage &&
    dependencyPackage !== authorizationPackage &&
    dependencyPackage !== platformCorePackage
  ) {
    return 'project-application may depend only on authorization and portable platform-core contracts.';
  }
  if (
    packageName === memorySqlitePackage &&
    dependencyPackage !== authorizationPackage &&
    dependencyPackage !== memorySearchPackage &&
    dependencyPackage !== memoryServicePackage &&
    dependencyPackage !== platformCorePackage &&
    dependencyPackage !== projectRegistryPackage &&
    dependencyPackage !== replicationOutboxPackage &&
    dependencyPackage !== replicationProtocolPackage &&
    dependencyPackage !== '@ai-usage/report-core'
  ) {
    return 'memory-sqlite may depend only on authorization, Memory, platform, project, replication, and test-only report contracts.';
  }
  if (
    packageName === memoryServicePackage &&
    dependencyPackage !== authorizationContractPackage &&
    dependencyPackage !== platformCorePackage &&
    dependencyPackage !== projectRegistryPackage &&
    dependencyPackage !== replicationProtocolPackage
  ) {
    return 'memory-service may depend only on portable authorization, platform, project, and replication contracts.';
  }
  if (packageName === replicationProtocolPackage && dependencyPackage !== platformCorePackage) {
    return 'replication-protocol may depend only on portable platform-core contracts.';
  }
  if (
    packageName === replicationOutboxPackage &&
    dependencyPackage !== platformCorePackage &&
    dependencyPackage !== replicationProtocolPackage
  ) {
    return 'replication-outbox may depend only on platform-core and replication-protocol.';
  }
  if (
    packageName === replicationClientPackage &&
    dependencyPackage !== identityPackage &&
    dependencyPackage !== platformCorePackage &&
    dependencyPackage !== replicationOutboxPackage &&
    dependencyPackage !== replicationProtocolPackage
  ) {
    return 'replication-client may depend only on identity, platform-core, and portable replication contracts.';
  }
  if (
    packageName === mcpAdapterPackage &&
    dependencyPackage !== authorizationContractPackage &&
    dependencyPackage !== memoryServicePackage &&
    dependencyPackage !== platformCorePackage &&
    dependencyPackage !== '@ai-usage/skills'
  ) {
    return 'mcp-adapter may depend only on portable authorization, Memory application, and identity contracts.';
  }
  if (dependencyPackage === memorySqlitePackage && packageName !== engineAppPackage) {
    return 'Only apps/usage-engine may own the write-capable local Memory SQLite adapter.';
  }
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
  if (packageName === replicationOutboxPackage && specifier === 'bun:sqlite' && !isTestOnlySource(relativeFile)) {
    return 'replication-outbox production code must use its portable SQLite port, not open a database.';
  }
  if (isPackageOrSubpath(specifier, mcpSdkPackage) && packageName !== mcpAdapterPackage) {
    return 'Only mcp-adapter may import the MCP protocol SDK directly.';
  }
  if (specifier === betterAuthPackage) {
    if (packageName !== identityPackage) {
      return 'Only identity may import Better Auth directly.';
    }
    if (
      relativeFile !== 'packages/identity/src/shared-authentication.ts' &&
      relativeFile !== 'packages/identity/src/session-digest-adapter.ts'
    ) {
      return 'Better Auth types and runtime must remain inside identity adapter-private modules.';
    }
  }
  if (
    specifier === betterAuthDrizzleAdapter &&
    (packageName !== postgresStorePackage ||
      relativeFile !== 'packages/postgres-store/src/internal/authentication-adapter.ts')
  ) {
    return 'The Better Auth Drizzle adapter is private to the PostgreSQL authentication adapter.';
  }
  if (
    isPackageOrSubpath(specifier, identitySharedAuthentication) &&
    packageName !== platformServerPackage &&
    packageName !== postgresStorePackage &&
    !isTestOnlySource(relativeFile)
  ) {
    return 'Shared authentication may be composed only by apps/server and the private PostgreSQL adapter.';
  }
  if (
    (isPackageOrSubpath(specifier, usageStoreTesting) ||
      isPackageOrSubpath(specifier, engineControlTesting) ||
      isPackageOrSubpath(specifier, identityTesting) ||
      isPackageOrSubpath(specifier, postgresStorePerformanceTesting) ||
      isPackageOrSubpath(specifier, postgresStoreTesting)) &&
    isTestOnlySource(relativeFile)
  ) {
    return;
  }
  if (specifier === postgresStorePackage) {
    return 'The PostgreSQL store has no mixed root export; import an explicit subpath.';
  }
  if (
    specifier === authorizationScopeInternal &&
    packageName !== postgresStorePackage &&
    packageName !== memorySqlitePackage &&
    !isTestOnlySource(relativeFile)
  ) {
    return 'Opaque authorization scope internals may be imported only by persistence adapters or test fixtures.';
  }
  if (isPackageOrSubpath(specifier, memorySqlitePackage) && packageName !== engineAppPackage) {
    return 'Only apps/usage-engine may import the write-capable local Memory SQLite adapter.';
  }
  if (
    (specifier === postgresStoreWriter || specifier === postgresStoreMigrations) &&
    packageName !== platformServerPackage
  ) {
    return 'Only apps/server may import PostgreSQL writer and migration capabilities.';
  }
  if (
    (packageName === '@ai-usage/web' || packageName === '@ai-usage/cli') &&
    isPackageOrSubpath(specifier, postgresStorePackage)
  ) {
    return 'Web and CLI production code must remain independent from the shared PostgreSQL store.';
  }
  if (
    (packageName === '@ai-usage/web' || packageName === '@ai-usage/cli') &&
    isPackageOrSubpath(specifier, authorizationPackage)
  ) {
    return 'Web and CLI production code import only transport contracts, never authorization implementation.';
  }
  if (specifier === usageStorePackage) {
    return 'The mixed usage-store root is retired; import reader, writer, or testing explicitly.';
  }
  if (
    (packageName === '@ai-usage/web' || packageName === '@ai-usage/cli') &&
    specifier.startsWith(`${usageStorePackage}/`) &&
    specifier !== usageStoreReader &&
    !(
      packageName === '@ai-usage/web' &&
      relativeFile === webPerformanceTestingImporter &&
      specifier === usageStorePerformanceTesting
    )
  ) {
    return 'Web and CLI may import only the usage-store reader facade; only the server hook may consume benchmark-only performance instrumentation.';
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
        specifier === localMachineSkillsConfig ||
        specifier === localMachineSourcePolicyConfig);
    const isAllowedTestFixture = specifier === localMachineTestingHarnessHome && isTestOnlySource(relativeFile);
    if (!(isAllowedWebOperation || isAllowedTestFixture)) {
      return 'Web may import only local-machine campaign-label-config/session-detail/skills-config/source-policy-config; CLI has no local-machine data path.';
    }
  }
  if (
    packageName === '@ai-usage/cli' &&
    isPackageOrSubpath(specifier, reportDataPackage) &&
    specifier !== reportDataPortableReport
  ) {
    return 'CLI may import only the collector-free report-data portable-report facade.';
  }
  if (
    isPackageOrSubpath(specifier, usageStoreTesting) ||
    isPackageOrSubpath(specifier, engineControlTesting) ||
    isPackageOrSubpath(specifier, identityTesting) ||
    isPackageOrSubpath(specifier, postgresStorePerformanceTesting) ||
    isPackageOrSubpath(specifier, postgresStoreTesting)
  ) {
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
    for (const match of text.matchAll(moduleImportPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) {
        continue;
      }
      const resolvedRelativeImport = specifier.startsWith('.')
        ? path.resolve(path.dirname(file), specifier)
        : undefined;
      const relativeImportEscapesPostgresStore =
        policy.packageName === postgresStorePackage &&
        resolvedRelativeImport !== undefined &&
        (() => {
          const relativeTarget = path.relative(packageInfo.directory, resolvedRelativeImport);
          return (
            relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)
          );
        })();
      if (
        !(
          relativeImportEscapesPostgresStore ||
          policy.forbiddenImports.some((pattern) => matchesPattern(specifier, pattern))
        )
      ) {
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
    for (const match of text.matchAll(moduleImportPattern)) {
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
  const forbiddenPackages = new Set([
    '@ai-usage/local-collectors',
    authorizationPackage,
    engineRuntimePackage,
    memorySqlitePackage,
    postgresStorePackage,
  ]);
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
              message: `${applicationPackage} production dependencies must stay collector-, engine-runtime-, authorization-implementation-, Memory-writer-, and PostgreSQL-store-free. Reached through ${dependencyPath.join(' -> ')}.`,
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
