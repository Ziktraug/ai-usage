import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectViolations } from './check-package-boundaries';

const fixtures: string[] = [];
const repositoryRoot = path.resolve(import.meta.dir, '..');
const workspacePackageScope = '@ai-usage/';
const cliRuntimePackage = `${workspacePackageScope}cli/runtime`;
const localCollectorsClaudeHistory = `${['@ai-usage', 'local-collectors'].join('/')}/claude-history`;
const localMachineRoot = ['@ai-usage', 'local-machine'].join('/');
const reportDataPackage = `${workspacePackageScope}report-data`;
const reportDataPortableReport = `${reportDataPackage}/portable-report`;
const usageStoreInternal = `${workspacePackageScope}usage-store/internal`;
const usageStorePerformanceTesting = `${workspacePackageScope}usage-store/performance-testing`;
const postgresStorePackage = `${workspacePackageScope}postgres-store`;
const postgresStoreMigrations = `${postgresStorePackage}/migrations`;
const postgresStorePerformanceTesting = `${postgresStorePackage}/performance-testing`;
const postgresStoreTesting = `${postgresStorePackage}/testing`;
const postgresStoreWriter = `${postgresStorePackage}/writer`;
const platformBridgePackage = ['@ai-usage', 'platform-bridge'].join('/');
const platformCorePackage = `${workspacePackageScope}platform-core`;
const authorizationContractPackage = `${workspacePackageScope}authorization-contract`;
const authorizationPackage = `${workspacePackageScope}authorization`;
const authorizationScopeInternal = `${authorizationPackage}/scope-internal`;
const identityPackage = `${workspacePackageScope}identity`;
const identitySharedAuthentication = `${identityPackage}/better-auth`;
const projectApplicationPackage = `${workspacePackageScope}project-application`;
const memorySqlitePackage = `${workspacePackageScope}memory-sqlite`;
const memoryServicePackage = `${workspacePackageScope}memory-service`;
const retiredLanPackage = `${workspacePackageScope}lan-pairing`;
const retiredSyncPackage = `${workspacePackageScope}sync`;
const webBridgePackage = ['@ai-usage', 'web-bridge'].join('/');

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

const createFixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-usage-boundaries-'));
  fixtures.push(root);
  await Promise.all([mkdir(path.join(root, 'apps'), { recursive: true }), mkdir(path.join(root, 'packages'))]);
  return root;
};

const writePackage = async (
  root: string,
  parent: 'apps' | 'packages',
  directory: string,
  packageJson: Record<string, unknown>,
  source = 'export {}\n',
): Promise<void> => {
  const packageRoot = path.join(root, parent, directory);
  await mkdir(path.join(packageRoot, 'src'), { recursive: true });
  await Promise.all([
    writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify(packageJson)}\n`),
    writeFile(path.join(packageRoot, 'src/index.ts'), source),
  ]);
};

describe('package boundary guard', () => {
  test('rejects retired package manifest dependencies', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'example', {
      dependencies: { [retiredSyncPackage]: 'workspace:*' },
      name: '@ai-usage/example',
    });

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/example/package.json',
        packageName: '@ai-usage/example',
        specifier: retiredSyncPackage,
      }),
    );
  });

  test('rejects root and subpath imports from every retired package', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'example',
      { name: '@ai-usage/example' },
      `import '${retiredSyncPackage}';\nexport { pair } from '${retiredLanPackage}/client';\n`,
    );

    const violations = await collectViolations(root);
    expect(violations.map((violation) => violation.specifier)).toEqual([
      retiredSyncPackage,
      `${retiredLanPackage}/client`,
    ]);
  });

  test('rejects a recreated retired package even without dependencies', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'sync', { name: retiredSyncPackage });

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/sync/package.json',
        packageName: retiredSyncPackage,
        specifier: retiredSyncPackage,
      }),
    );
  });

  test('rejects CommonJS imports from retired package subpaths', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'example',
      { name: '@ai-usage/example' },
      `const sync = require('${retiredSyncPackage}/client');\nvoid sync;\n`,
    );

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/example/src/index.ts',
        packageName: '@ai-usage/example',
        specifier: `${retiredSyncPackage}/client`,
      }),
    );
  });

  test('forbids web source imports from CLI packages', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      { name: '@ai-usage/web' },
      `import { main } from '${cliRuntimePackage}';\nvoid main;\n`,
    );

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'apps/web/src/index.ts',
        packageName: '@ai-usage/web',
        specifier: cliRuntimePackage,
      }),
    );
  });

  test('keeps web production code independent from local collectors', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      {
        dependencies: { '@ai-usage/local-collectors': 'workspace:*' },
        name: '@ai-usage/web',
      },
      `import '${localCollectorsClaudeHistory}';\n`,
    );

    expect(await collectViolations(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'apps/web/package.json',
          packageName: '@ai-usage/web',
          specifier: '@ai-usage/local-collectors',
        }),
        expect.objectContaining({
          file: 'apps/web/src/index.ts',
          packageName: '@ai-usage/web',
          specifier: localCollectorsClaudeHistory,
        }),
      ]),
    );
  });

  test('keeps report-data independent from collectors and effect runtime', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'report-data',
      {
        dependencies: {
          '@ai-usage/effect-runtime': 'workspace:*',
          '@ai-usage/local-collectors': 'workspace:*',
        },
        name: reportDataPackage,
      },
      "import '@ai-usage/effect-runtime';\nimport '@ai-usage/local-collectors';\n",
    );

    const violations = await collectViolations(root);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: reportDataPackage,
          specifier: '@ai-usage/effect-runtime',
        }),
        expect.objectContaining({
          packageName: reportDataPackage,
          specifier: '@ai-usage/local-collectors',
        }),
      ]),
    );
  });

  test('keeps usage-engine-control transport-only', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'usage-engine-control',
      {
        dependencies: { '@ai-usage/report-data': 'workspace:*' },
        name: '@ai-usage/usage-engine-control',
      },
      "import '@ai-usage/report-data';\n",
    );

    expect(await collectViolations(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: '@ai-usage/usage-engine-control',
          specifier: '@ai-usage/report-data',
        }),
      ]),
    );
  });

  test('matches allowed control dependencies by package boundary, not prefix', async () => {
    const root = await createFixture();
    const reportCoreSibling = ['@ai-usage', 'report-core-runtime'].join('/');
    await writePackage(
      root,
      'packages',
      'usage-engine-control',
      {
        dependencies: { '@ai-usage/report-core-runtime': 'workspace:*' },
        name: '@ai-usage/usage-engine-control',
      },
      `import '${reportCoreSibling}/client';\n`,
    );

    expect(await collectViolations(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: '@ai-usage/usage-engine-control',
          specifier: '@ai-usage/report-core-runtime/client',
        }),
      ]),
    );
  });

  test('allows usage-store writer only from usage-engine-runtime and usage-merge', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' }, "import '@ai-usage/usage-store/writer';\n");
    await writePackage(
      root,
      'packages',
      'usage-engine-runtime',
      { name: '@ai-usage/usage-engine-runtime' },
      "import '@ai-usage/usage-store/writer';\n",
    );
    await writePackage(
      root,
      'packages',
      'usage-merge',
      { name: '@ai-usage/usage-merge' },
      "import '@ai-usage/usage-store/writer';\n",
    );

    const violations = await collectViolations(root);
    expect(violations).toContainEqual(
      expect.objectContaining({ packageName: '@ai-usage/web', specifier: '@ai-usage/usage-store/writer' }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({
        packageName: '@ai-usage/usage-engine-runtime',
        specifier: '@ai-usage/usage-store/writer',
      }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({
        packageName: '@ai-usage/usage-merge',
        specifier: '@ai-usage/usage-store/writer',
      }),
    );
  });

  test('allows only the Web server hook to consume explicit usage-store performance instrumentation', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    await writeFile(
      path.join(root, 'apps/web/src/hooks.server.ts'),
      "import '@ai-usage/usage-store/performance-testing';\n",
    );

    expect(await collectViolations(root)).toEqual([]);
  });

  test('rejects performance instrumentation from general server and client Web modules', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      { name: '@ai-usage/web' },
      "import '@ai-usage/usage-store/performance-testing';\n",
    );
    await writeFile(
      path.join(root, 'apps/web/src/general.server.ts'),
      "import '@ai-usage/usage-store/performance-testing';\n",
    );

    const violations = await collectViolations(root);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'apps/web/src/index.ts', specifier: usageStorePerformanceTesting }),
        expect.objectContaining({
          file: 'apps/web/src/general.server.ts',
          specifier: usageStorePerformanceTesting,
        }),
      ]),
    );
  });

  test('allows only usage-engine-runtime to depend on the writer-capable usage-merge package', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      {
        dependencies: { '@ai-usage/usage-merge': 'workspace:*' },
        name: '@ai-usage/web',
      },
      "import '@ai-usage/usage-merge';\n",
    );
    await writePackage(
      root,
      'packages',
      'usage-engine-runtime',
      {
        dependencies: { '@ai-usage/usage-merge': 'workspace:*' },
        name: '@ai-usage/usage-engine-runtime',
      },
      "import '@ai-usage/usage-merge';\n",
    );

    const violations = await collectViolations(root);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: '@ai-usage/web',
          specifier: '@ai-usage/usage-merge',
        }),
      ]),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({
        packageName: '@ai-usage/usage-engine-runtime',
        specifier: '@ai-usage/usage-merge',
      }),
    );
  });

  test('forbids mixed usage-store roots and production testing adapters', async () => {
    const root = await createFixture();
    const mixedStoreSpecifier = ['@ai-usage', 'usage-store'].join('/');
    await writePackage(
      root,
      'apps',
      'web',
      { name: '@ai-usage/web' },
      `import '${mixedStoreSpecifier}';\nimport '@ai-usage/usage-engine-control/testing';\n`,
    );

    const violations = await collectViolations(root);
    expect(violations.map(({ specifier }) => specifier)).toEqual([
      '@ai-usage/usage-store',
      '@ai-usage/usage-engine-control/testing',
    ]);
  });

  test('allows only the usage-engine app to compose engine-runtime', async () => {
    const root = await createFixture();
    const runtimeInternal = `${['@ai-usage', 'usage-engine-runtime'].join('/')}/internal`;
    await writePackage(
      root,
      'apps',
      'web',
      {
        dependencies: { '@ai-usage/usage-engine-runtime': 'workspace:*' },
        name: '@ai-usage/web',
      },
      `import '${runtimeInternal}';\n`,
    );
    await writePackage(
      root,
      'apps',
      'usage-engine',
      { name: '@ai-usage/usage-engine' },
      "import '@ai-usage/usage-engine-runtime';\n",
    );

    const violations = await collectViolations(root);
    expect(violations).toContainEqual(
      expect.objectContaining({
        file: 'apps/web/package.json',
        packageName: '@ai-usage/web',
        specifier: '@ai-usage/usage-engine-runtime',
      }),
    );
    expect(violations).toContainEqual(
      expect.objectContaining({ packageName: '@ai-usage/web', specifier: '@ai-usage/usage-engine-runtime/internal' }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({ packageName: '@ai-usage/usage-engine', specifier: '@ai-usage/usage-engine-runtime' }),
    );
  });

  test('keeps usage-store independent from engine subpaths and every app package', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'dashboard', { name: '@ai-usage/dashboard' });
    await writePackage(
      root,
      'packages',
      'usage-store',
      {
        dependencies: { '@ai-usage/usage-engine-control': 'workspace:*' },
        name: '@ai-usage/usage-store',
      },
      "import '@ai-usage/usage-engine-control/client';\nimport '@ai-usage/dashboard/server';\n",
    );

    const violations = await collectViolations(root);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: '@ai-usage/usage-store',
          specifier: '@ai-usage/usage-engine-control/client',
        }),
        expect.objectContaining({ packageName: '@ai-usage/usage-store', specifier: '@ai-usage/dashboard/server' }),
      ]),
    );
  });

  test('does not treat production testing directories as test-only', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    const productionTestingDirectory = path.join(root, 'apps/web/src/testing');
    await mkdir(productionTestingDirectory, { recursive: true });
    await writeFile(
      path.join(productionTestingDirectory, 'client.ts'),
      "import '@ai-usage/usage-engine-control/testing';\n",
    );

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'apps/web/src/testing/client.ts',
        packageName: '@ai-usage/web',
        specifier: '@ai-usage/usage-engine-control/testing',
      }),
    );
  });

  test('rejects usage-store writer imports from arbitrary domain packages', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'orphan-writer',
      { name: '@ai-usage/orphan-writer' },
      "import '@ai-usage/usage-store/writer';\n",
    );

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/orphan-writer/src/index.ts',
        packageName: '@ai-usage/orphan-writer',
        specifier: '@ai-usage/usage-store/writer',
      }),
    );
  });

  test('allows only the three Web local-machine operations and test-only fixtures', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      { name: '@ai-usage/web' },
      [
        "import '@ai-usage/local-machine/campaign-label-config';",
        "import '@ai-usage/local-machine/session-detail';",
        "import '@ai-usage/local-machine/skills-config';",
        `import '${localMachineRoot}';`,
        "import '@ai-usage/local-machine/testing/harness-home';",
      ].join('\n'),
    );
    const e2eDirectory = path.join(root, 'apps/web/e2e');
    await mkdir(e2eDirectory, { recursive: true });
    await writeFile(path.join(e2eDirectory, 'fixture.ts'), "import '@ai-usage/local-machine/testing/harness-home';\n");

    expect((await collectViolations(root)).map(({ specifier }) => specifier)).toEqual([
      '@ai-usage/local-machine',
      '@ai-usage/local-machine/testing/harness-home',
    ]);
  });

  test('keeps the complete Web local-machine dependency closure collector-free', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      {
        dependencies: { [webBridgePackage]: 'workspace:*' },
        name: '@ai-usage/web',
      },
      `import '${webBridgePackage}';\n`,
    );
    await writePackage(
      root,
      'packages',
      'web-bridge',
      {
        dependencies: { '@ai-usage/local-machine': 'workspace:*' },
        name: webBridgePackage,
      },
      "import '@ai-usage/local-machine/session-detail';\n",
    );
    await writePackage(
      root,
      'packages',
      'local-machine',
      {
        dependencies: { '@ai-usage/local-collectors': 'workspace:*' },
        name: '@ai-usage/local-machine',
      },
      "import '@ai-usage/local-collectors/codex-history';\n",
    );

    expect(await collectViolations(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'packages/local-machine/package.json',
          message: expect.stringContaining(
            '@ai-usage/web -> @ai-usage/web-bridge -> @ai-usage/local-machine -> @ai-usage/local-collectors',
          ),
          packageName: '@ai-usage/web',
          specifier: '@ai-usage/local-collectors',
        }),
        expect.objectContaining({
          file: 'packages/local-machine/package.json',
          packageName: '@ai-usage/local-machine',
          specifier: '@ai-usage/local-collectors',
        }),
        expect.objectContaining({
          file: 'packages/local-machine/src/index.ts',
          packageName: '@ai-usage/local-machine',
          specifier: '@ai-usage/local-collectors/codex-history',
        }),
      ]),
    );
  });

  test('follows undeclared production workspace imports in the Web closure', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      {
        dependencies: { [webBridgePackage]: 'workspace:*' },
        name: '@ai-usage/web',
      },
      `import '${webBridgePackage}';\n`,
    );
    await writePackage(
      root,
      'packages',
      'web-bridge',
      { name: webBridgePackage },
      "import '@ai-usage/local-collectors/codex-history';\n",
    );
    await writePackage(root, 'packages', 'local-collectors', { name: '@ai-usage/local-collectors' });

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/web-bridge/src/index.ts',
        message: expect.stringContaining('@ai-usage/web -> @ai-usage/web-bridge -> @ai-usage/local-collectors'),
        packageName: '@ai-usage/web',
        specifier: '@ai-usage/local-collectors',
      }),
    );
  });

  test('keeps CLI collection behind control and durable reads behind the reader facade', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'cli',
      { name: '@ai-usage/cli' },
      [
        `import '${localCollectorsClaudeHistory}';`,
        "import '@ai-usage/usage-engine/main';",
        "import '@ai-usage/usage-store/reader';",
        `import '${usageStoreInternal}';`,
      ].join('\n'),
    );

    expect((await collectViolations(root)).map(({ specifier }) => specifier)).toEqual([
      localCollectorsClaudeHistory,
      '@ai-usage/usage-engine/main',
      '@ai-usage/usage-store/internal',
    ]);
  });

  test('allows CLI only the collector-free report-data portable facade', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'cli',
      { name: '@ai-usage/cli' },
      [
        `import '${reportDataPackage}';`,
        `import '${reportDataPackage}/served-revision-query';`,
        `import '${reportDataPortableReport}';`,
      ].join('\n'),
    );

    expect((await collectViolations(root)).map(({ specifier }) => specifier)).toEqual([
      reportDataPackage,
      `${reportDataPackage}/served-revision-query`,
    ]);
  });

  test('rejects forbidden workspace imports anywhere in the portable-report closure', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'report-data', { name: reportDataPackage });
    const sourceDirectory = path.join(root, 'packages/report-data/src');
    await Promise.all([
      writeFile(path.join(sourceDirectory, 'portable-report.ts'), "export { value } from './bridge';\n"),
      writeFile(
        path.join(sourceDirectory, 'bridge.ts'),
        `import '${workspacePackageScope}local-collectors';\nexport const value = true;\n`,
      ),
    ]);

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/report-data/src/bridge.ts',
        packageName: reportDataPackage,
        specifier: `${workspacePackageScope}local-collectors`,
      }),
    );
  });

  test('follows emitted JavaScript specifiers to TypeScript sources in the portable-report closure', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'report-data', { name: reportDataPackage });
    const sourceDirectory = path.join(root, 'packages/report-data/src');
    await Promise.all([
      writeFile(path.join(sourceDirectory, 'portable-report.ts'), "export { value } from './bridge.js';\n"),
      writeFile(
        path.join(sourceDirectory, 'bridge.ts'),
        `import '${workspacePackageScope}local-collectors';\nexport const value = true;\n`,
      ),
    ]);

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/report-data/src/bridge.ts',
        packageName: reportDataPackage,
        specifier: `${workspacePackageScope}local-collectors`,
      }),
    );
  });

  test('fails closed when a portable-report relative import cannot be resolved', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'report-data', { name: reportDataPackage });
    await writeFile(
      path.join(root, 'packages/report-data/src/portable-report.ts'),
      "export { missing } from './missing.js';\n",
    );

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/report-data/src/portable-report.ts',
        packageName: reportDataPackage,
        specifier: './missing.js',
      }),
    );
  });

  test('scans direct forbidden imports in Svelte source', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    const routeDirectory = path.join(root, 'apps/web/src/routes');
    await mkdir(routeDirectory, { recursive: true });
    await writeFile(
      path.join(routeDirectory, '+page.svelte'),
      "<script>import '@ai-usage/local-collectors/codex-history';</script>\n",
    );

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'apps/web/src/routes/+page.svelte',
        packageName: '@ai-usage/web',
        specifier: '@ai-usage/local-collectors/codex-history',
      }),
    );
  });

  test('scans dynamic forbidden imports in Svelte source', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    const sourceDirectory = path.join(root, 'apps/web/src/lib');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      path.join(sourceDirectory, 'dynamic.svelte'),
      `<script>const merge = import('${['@ai-usage', 'usage-merge', 'internal'].join('/')}'); void merge;</script>
`,
    );

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'apps/web/src/lib/dynamic.svelte',
        packageName: '@ai-usage/web',
        specifier: '@ai-usage/usage-merge/internal',
      }),
    );
  });

  test('scans forbidden re-exports in Svelte source', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    const sourceDirectory = path.join(root, 'apps/web/src/lib');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      path.join(sourceDirectory, 're-export.svelte'),
      '<script context="module">export { merge } from \'@ai-usage/usage-merge\';</script>\n',
    );

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'apps/web/src/lib/re-export.svelte',
        packageName: '@ai-usage/web',
        specifier: '@ai-usage/usage-merge',
      }),
    );
  });

  test('follows indirect production workspace reachability through Svelte source', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    await writePackage(root, 'packages', 'web-bridge', { name: webBridgePackage });
    await writePackage(root, 'packages', 'local-collectors', { name: '@ai-usage/local-collectors' });
    const webSource = path.join(root, 'apps/web/src/+page.svelte');
    const bridgeSource = path.join(root, 'packages/web-bridge/src/bridge.svelte');
    await Promise.all([
      writeFile(webSource, `<script>import '${webBridgePackage}';</script>\n`),
      writeFile(
        bridgeSource,
        '<script context="module">export { collect } from \'@ai-usage/local-collectors/codex-history\';</script>\n',
      ),
    ]);

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/web-bridge/src/bridge.svelte',
        message: expect.stringContaining('@ai-usage/web -> @ai-usage/web-bridge -> @ai-usage/local-collectors'),
        packageName: '@ai-usage/web',
        specifier: '@ai-usage/local-collectors',
      }),
    );
  });

  test('resolves .svelte modules in recursive source-closure scans', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'report-data', { name: reportDataPackage });
    const sourceDirectory = path.join(root, 'packages/report-data/src');
    await Promise.all([
      writeFile(path.join(sourceDirectory, 'portable-report.ts'), "export { value } from './bridge.svelte';\n"),
      writeFile(
        path.join(sourceDirectory, 'bridge.svelte'),
        '<script context="module">export { value } from \'@ai-usage/local-collectors\';</script>\n',
      ),
    ]);

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/report-data/src/bridge.svelte',
        packageName: reportDataPackage,
        specifier: '@ai-usage/local-collectors',
      }),
    );
  });

  test('ignores every generated canonical SvelteKit tree', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    const generatedDirectories = ['.output-build', '.svelte-kit'];

    for (const generatedDirectory of generatedDirectories) {
      const directory = path.join(root, 'apps/web', generatedDirectory);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'forbidden.svelte'), "<script>import '@ai-usage/usage-merge';</script>\n");
    }

    expect(await collectViolations(root)).toEqual([]);
  });

  test('keeps postgres-store limited to pure platform contracts and PostgreSQL infrastructure', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'postgres-store',
      {
        dependencies: { '@ai-usage/usage-store': 'workspace:*' },
        name: postgresStorePackage,
      },
      [
        "import '@ai-usage/usage-store/reader';",
        "import 'bun:sqlite';",
        "import 'node:fs/promises';",
        "import 'node:http';",
        "import '../../../tools/pg-harness';",
      ].join('\n'),
    );

    const violations = await collectViolations(root);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'packages/postgres-store/package.json', specifier: '@ai-usage/usage-store' }),
        expect.objectContaining({ file: 'packages/postgres-store/src/index.ts', specifier: 'bun:sqlite' }),
        expect.objectContaining({ file: 'packages/postgres-store/src/index.ts', specifier: 'node:fs/promises' }),
        expect.objectContaining({ file: 'packages/postgres-store/src/index.ts', specifier: 'node:http' }),
        expect.objectContaining({
          file: 'packages/postgres-store/src/index.ts',
          specifier: '../../../tools/pg-harness',
        }),
      ]),
    );
  });

  test('keeps platform identity, authorization, and Project services free from runtime adapters', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'platform-core',
      { dependencies: { '@ai-usage/usage-store': 'workspace:*' }, name: platformCorePackage },
      "import 'bun:sqlite';\nimport 'node:fs/promises';\n",
    );
    await writePackage(root, 'packages', 'authorization', {
      dependencies: { '@ai-usage/usage-store': 'workspace:*' },
      name: authorizationPackage,
    });
    await writePackage(root, 'packages', 'authorization-contract', {
      dependencies: { '@ai-usage/usage-store': 'workspace:*' },
      name: authorizationContractPackage,
    });
    await writePackage(
      root,
      'packages',
      'project-application',
      { dependencies: { pg: '1.0.0' }, name: projectApplicationPackage },
      "import 'pg';\n",
    );

    expect(await collectViolations(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: platformCorePackage, specifier: '@ai-usage/usage-store' }),
        expect.objectContaining({ packageName: platformCorePackage, specifier: 'bun:sqlite' }),
        expect.objectContaining({ packageName: platformCorePackage, specifier: 'node:fs/promises' }),
        expect.objectContaining({ packageName: authorizationPackage, specifier: '@ai-usage/usage-store' }),
        expect.objectContaining({ packageName: authorizationContractPackage, specifier: '@ai-usage/usage-store' }),
        expect.objectContaining({ packageName: projectApplicationPackage, specifier: 'pg' }),
      ]),
    );
  });

  test('allows only apps/usage-engine to own the local Memory SQLite adapter', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      { dependencies: { [memorySqlitePackage]: 'workspace:*' }, name: '@ai-usage/web' },
      `import '${memorySqlitePackage}/identity';\n`,
    );
    await writePackage(
      root,
      'apps',
      'usage-engine',
      { dependencies: { [memorySqlitePackage]: 'workspace:*' }, name: '@ai-usage/usage-engine' },
      `import '${memorySqlitePackage}/identity';\n`,
    );

    const violations = await collectViolations(root);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: '@ai-usage/web', specifier: memorySqlitePackage }),
        expect.objectContaining({ packageName: '@ai-usage/web', specifier: `${memorySqlitePackage}/identity` }),
      ]),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({ packageName: '@ai-usage/usage-engine', specifier: memorySqlitePackage }),
    );
  });

  test('keeps the local Memory adapter independent from PostgreSQL, Usage SQLite, and HTTP', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'memory-sqlite',
      {
        dependencies: { [postgresStorePackage]: 'workspace:*', '@ai-usage/usage-store': 'workspace:*' },
        name: memorySqlitePackage,
      },
      "import '@ai-usage/postgres-store/writer';\nimport '@ai-usage/usage-store/writer';\nimport 'node:http';\n",
    );

    expect(await collectViolations(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: memorySqlitePackage, specifier: postgresStorePackage }),
        expect.objectContaining({ packageName: memorySqlitePackage, specifier: '@ai-usage/usage-store' }),
        expect.objectContaining({ packageName: memorySqlitePackage, specifier: `${postgresStorePackage}/writer` }),
        expect.objectContaining({ packageName: memorySqlitePackage, specifier: '@ai-usage/usage-store/writer' }),
        expect.objectContaining({ packageName: memorySqlitePackage, specifier: 'node:http' }),
      ]),
    );
  });

  test('keeps the named Memory service independent from every storage adapter', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'memory-service',
      {
        dependencies: { [memorySqlitePackage]: 'workspace:*', [postgresStorePackage]: 'workspace:*' },
        name: memoryServicePackage,
      },
      `import '${memorySqlitePackage}/identity';\nimport '${postgresStoreWriter}';\n`,
    );

    expect(await collectViolations(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: memoryServicePackage, specifier: memorySqlitePackage }),
        expect.objectContaining({ packageName: memoryServicePackage, specifier: postgresStorePackage }),
        expect.objectContaining({ packageName: memoryServicePackage, specifier: `${memorySqlitePackage}/identity` }),
        expect.objectContaining({ packageName: memoryServicePackage, specifier: postgresStoreWriter }),
      ]),
    );
  });

  test('allows only apps/server to import PostgreSQL writer and migration capabilities', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'orphan-platform-writer',
      { name: '@ai-usage/orphan-platform-writer' },
      `import '${postgresStoreWriter}';\nimport '${postgresStoreMigrations}';\n`,
    );
    await writePackage(
      root,
      'apps',
      'server',
      { name: '@ai-usage/server' },
      `import '${postgresStoreWriter}';\nimport '${postgresStoreMigrations}';\n`,
    );

    const violations = await collectViolations(root);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: '@ai-usage/orphan-platform-writer',
          specifier: postgresStoreWriter,
        }),
        expect.objectContaining({
          packageName: '@ai-usage/orphan-platform-writer',
          specifier: postgresStoreMigrations,
        }),
      ]),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({ packageName: '@ai-usage/server', specifier: postgresStoreWriter }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({ packageName: '@ai-usage/server', specifier: postgresStoreMigrations }),
    );
  });

  test('allows postgres-store testing and benchmark adapters only from test and fixture source', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'platform-consumer',
      { name: '@ai-usage/platform-consumer' },
      `import '${postgresStorePerformanceTesting}';\nimport '${postgresStoreTesting}';\n`,
    );
    await writeFile(
      path.join(root, 'packages/platform-consumer/src/allowed.test.ts'),
      `import '${postgresStorePerformanceTesting}';\nimport '${postgresStoreTesting}';\n`,
    );

    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/platform-consumer/src/index.ts',
        packageName: '@ai-usage/platform-consumer',
        specifier: postgresStoreTesting,
      }),
    );
    expect(await collectViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/platform-consumer/src/index.ts',
        packageName: '@ai-usage/platform-consumer',
        specifier: postgresStorePerformanceTesting,
      }),
    );
    expect(await collectViolations(root)).not.toContainEqual(
      expect.objectContaining({
        file: 'packages/platform-consumer/src/allowed.test.ts',
        specifier: postgresStoreTesting,
      }),
    );
  });

  test('keeps apps/server independent from local Usage and machine runtimes', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'server',
      {
        dependencies: { '@ai-usage/local-collectors': 'workspace:*', '@ai-usage/usage-store': 'workspace:*' },
        name: '@ai-usage/server',
      },
      "import '@ai-usage/local-machine/testing/harness-home';\nimport '@ai-usage/usage-store/writer';\n",
    );

    expect(await collectViolations(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: '@ai-usage/server', specifier: '@ai-usage/local-collectors' }),
        expect.objectContaining({ packageName: '@ai-usage/server', specifier: '@ai-usage/usage-store' }),
        expect.objectContaining({
          packageName: '@ai-usage/server',
          specifier: '@ai-usage/local-machine/testing/harness-home',
        }),
        expect.objectContaining({ packageName: '@ai-usage/server', specifier: '@ai-usage/usage-store/writer' }),
      ]),
    );
  });

  test('keeps Web and CLI production dependency closures authorization-implementation- and PostgreSQL-free', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      {
        dependencies: { [memoryServicePackage]: 'workspace:*', [platformBridgePackage]: 'workspace:*' },
        name: '@ai-usage/web',
      },
      `import '${memoryServicePackage}/client';\nimport '${platformBridgePackage}';\n`,
    );
    await writePackage(root, 'packages', 'platform-bridge', {
      dependencies: { [authorizationPackage]: 'workspace:*', [postgresStorePackage]: 'workspace:*' },
      name: platformBridgePackage,
    });
    await writePackage(root, 'packages', 'authorization-contract', {
      dependencies: { [platformCorePackage]: 'workspace:*' },
      name: authorizationContractPackage,
    });
    await writePackage(root, 'packages', 'memory-service', {
      dependencies: { [authorizationContractPackage]: 'workspace:*' },
      name: memoryServicePackage,
    });
    await writePackage(
      root,
      'apps',
      'cli',
      { name: '@ai-usage/cli' },
      `import '${authorizationPackage}';\nimport '${postgresStorePackage}/reader';\n`,
    );

    expect(await collectViolations(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('@ai-usage/web -> @ai-usage/platform-bridge -> @ai-usage/postgres-store'),
          packageName: '@ai-usage/web',
          specifier: postgresStorePackage,
        }),
        expect.objectContaining({ packageName: '@ai-usage/cli', specifier: `${postgresStorePackage}/reader` }),
        expect.objectContaining({ packageName: '@ai-usage/cli', specifier: authorizationPackage }),
        expect.objectContaining({
          message: expect.stringContaining('@ai-usage/web -> @ai-usage/platform-bridge -> @ai-usage/authorization'),
          packageName: '@ai-usage/web',
          specifier: authorizationPackage,
        }),
      ]),
    );
  });

  test('keeps opaque authorization scope internals inside the persistence adapter and tests', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'route-adapter',
      { name: '@ai-usage/route-adapter' },
      `import '${authorizationScopeInternal}';\n`,
    );
    await writePackage(
      root,
      'packages',
      'postgres-store',
      { name: postgresStorePackage },
      `import '${authorizationScopeInternal}';\n`,
    );
    await writePackage(
      root,
      'packages',
      'memory-sqlite',
      { name: memorySqlitePackage },
      `import '${authorizationScopeInternal}';\n`,
    );
    await writeFile(
      path.join(root, 'packages/route-adapter/src/scope.test.ts'),
      `import '${authorizationScopeInternal}';\n`,
    );

    const violations = await collectViolations(root);
    expect(violations).toContainEqual(
      expect.objectContaining({
        file: 'packages/route-adapter/src/index.ts',
        packageName: '@ai-usage/route-adapter',
        specifier: authorizationScopeInternal,
      }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({
        file: 'packages/postgres-store/src/index.ts',
        specifier: authorizationScopeInternal,
      }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({
        file: 'packages/memory-sqlite/src/index.ts',
        specifier: authorizationScopeInternal,
      }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({
        file: 'packages/route-adapter/src/scope.test.ts',
        specifier: authorizationScopeInternal,
      }),
    );
  });

  test('keeps Better Auth and its Drizzle adapter inside their dedicated owners', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'identity',
      {
        dependencies: { 'better-auth': '1.7.2' },
        name: identityPackage,
      },
      "import { betterAuth } from 'better-auth';\nvoid betterAuth;\n",
    );
    await writeFile(
      path.join(root, 'packages/identity/src/shared-authentication.ts'),
      "import { betterAuth } from 'better-auth';\nvoid betterAuth;\n",
    );
    await writePackage(
      root,
      'packages',
      'route-adapter',
      {
        dependencies: { '@better-auth/drizzle-adapter': '1.7.2', 'better-auth': '1.7.2' },
        name: '@ai-usage/route-adapter',
      },
      "import 'better-auth';\nimport '@better-auth/drizzle-adapter';\n",
    );

    const violations = await collectViolations(root);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageName: '@ai-usage/route-adapter', specifier: 'better-auth' }),
        expect.objectContaining({
          packageName: '@ai-usage/route-adapter',
          specifier: '@better-auth/drizzle-adapter',
        }),
        expect.objectContaining({
          file: 'packages/identity/src/index.ts',
          packageName: identityPackage,
          specifier: 'better-auth',
        }),
      ]),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({ file: 'packages/identity/src/shared-authentication.ts', specifier: 'better-auth' }),
    );
  });

  test('allows shared authentication composition only in the server and PostgreSQL adapter', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' }, `import '${identitySharedAuthentication}';\n`);
    await writePackage(
      root,
      'apps',
      'server',
      { name: '@ai-usage/server' },
      `import '${identitySharedAuthentication}';\n`,
    );
    await writePackage(
      root,
      'packages',
      'postgres-store',
      { name: postgresStorePackage },
      `import type {} from '${identitySharedAuthentication}';\n`,
    );

    const violations = await collectViolations(root);
    expect(violations).toContainEqual(
      expect.objectContaining({ packageName: '@ai-usage/web', specifier: identitySharedAuthentication }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({ packageName: '@ai-usage/server', specifier: identitySharedAuthentication }),
    );
    expect(violations).not.toContainEqual(
      expect.objectContaining({ packageName: postgresStorePackage, specifier: identitySharedAuthentication }),
    );
  });

  test('accepts the current workspace graph', async () => {
    expect(await collectViolations(repositoryRoot)).toEqual([]);
  });
});
