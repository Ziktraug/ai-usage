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
const retiredLanPackage = `${workspacePackageScope}lan-pairing`;
const retiredSyncPackage = `${workspacePackageScope}sync`;
const webBridgePackage = ['@ai-usage', 'web-bridge'].join('/');

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

// A fixture holds only the packages its test is about, so the guarded packages the real repository must contain
// are checked only when present. The real-tree test and the CLI keep the default, which requires them.
const collectFixtureViolations = (root: string) => collectViolations(root, { guardedPackages: 'when-present' });

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

/** The framework-neutral Web presentation closure's entrypoints, relative to the Web package. */
const webPresentationEntrypoints = [
  'src/lib/foundation/dashboard/dashboard-analytics.ts',
  'src/lib/foundation/dashboard/dashboard-model.ts',
  'src/lib/features/sessions/dashboard-sort.ts',
  'src/lib/foundation/overview-model.ts',
  'src/lib/features/report/provider-status-model.ts',
  'src/lib/foundation/campaign-label-overrides.ts',
  'src/lib/foundation/session/session-analysis-target.ts',
  'src/lib/foundation/presentation/format.ts',
  'src/lib/foundation/presentation/report-value.ts',
  'src/lib/foundation/machine-freshness-presentation.ts',
] as const;

/** Gives a Web fixture its (empty) presentation closure, so a test of another rule sees only that rule. */
const writeWebPresentationClosure = async (root: string): Promise<void> => {
  const files = webPresentationEntrypoints.map((entrypoint) => path.join(root, 'apps/web', entrypoint));
  await Promise.all(files.map((file) => mkdir(path.dirname(file), { recursive: true })));
  await Promise.all(files.map((file) => writeFile(file, 'export {};\n')));
};

describe('package boundary guard', () => {
  test('rejects retired package manifest dependencies', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'example', {
      dependencies: { [retiredSyncPackage]: 'workspace:*' },
      name: '@ai-usage/example',
    });

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    const violations = await collectFixtureViolations(root);
    expect(violations.map((violation) => violation.specifier)).toEqual([
      retiredSyncPackage,
      `${retiredLanPackage}/client`,
    ]);
  });

  test('rejects a recreated retired package even without dependencies', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'sync', { name: retiredSyncPackage });

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toEqual(
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

    const violations = await collectFixtureViolations(root);
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

    expect(await collectFixtureViolations(root)).toEqual(
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

    expect(await collectFixtureViolations(root)).toEqual(
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

    const violations = await collectFixtureViolations(root);
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
    await writeWebPresentationClosure(root);
    await writeFile(
      path.join(root, 'apps/web/src/hooks.server.ts'),
      "import '@ai-usage/usage-store/performance-testing';\n",
    );

    expect(await collectFixtureViolations(root)).toEqual([]);
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

    const violations = await collectFixtureViolations(root);
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

    const violations = await collectFixtureViolations(root);
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
    await writeWebPresentationClosure(root);

    const violations = await collectFixtureViolations(root);
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

    const violations = await collectFixtureViolations(root);
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

    const violations = await collectFixtureViolations(root);
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
      expect.objectContaining({
        file: 'packages/orphan-writer/src/index.ts',
        packageName: '@ai-usage/orphan-writer',
        specifier: '@ai-usage/usage-store/writer',
      }),
    );
  });

  test('allows only the Web local-machine operations and test-only fixtures', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'apps',
      'web',
      { name: '@ai-usage/web' },
      [
        "import '@ai-usage/local-machine/bounded-process';",
        "import '@ai-usage/local-machine/campaign-label-config';",
        "import '@ai-usage/local-machine/session-detail';",
        "import '@ai-usage/local-machine/skills-config';",
        `import '${localMachineRoot}';`,
        "import '@ai-usage/local-machine/testing/harness-home';",
      ].join('\n'),
    );
    await writeWebPresentationClosure(root);
    const e2eDirectory = path.join(root, 'apps/web/e2e');
    await mkdir(e2eDirectory, { recursive: true });
    await writeFile(path.join(e2eDirectory, 'fixture.ts'), "import '@ai-usage/local-machine/testing/harness-home';\n");

    expect((await collectFixtureViolations(root)).map(({ specifier }) => specifier)).toEqual([
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

    expect(await collectFixtureViolations(root)).toEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect((await collectFixtureViolations(root)).map(({ specifier }) => specifier)).toEqual([
      localCollectorsClaudeHistory,
      '@ai-usage/usage-engine/main',
      '@ai-usage/usage-store/internal',
    ]);
  });

  test('allows CLI only the collector-free report-data portable and Work context facades', async () => {
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
        `import '${reportDataPackage}/work-context-read';`,
      ].join('\n'),
    );

    expect((await collectFixtureViolations(root)).map(({ specifier }) => specifier)).toEqual([
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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

    expect(await collectFixtureViolations(root)).toContainEqual(
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
    await writeWebPresentationClosure(root);
    const generatedDirectories = ['.output-build', '.svelte-kit'];

    for (const generatedDirectory of generatedDirectories) {
      const directory = path.join(root, 'apps/web', generatedDirectory);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'forbidden.svelte'), "<script>import '@ai-usage/usage-merge';</script>\n");
    }

    expect(await collectFixtureViolations(root)).toEqual([]);
  });

  test('keeps the MCP adapter on the skills package and away from storage', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'mcp-adapter',
      {
        dependencies: { '@ai-usage/skills': 'workspace:*', '@ai-usage/usage-store': 'workspace:*' },
        name: '@ai-usage/mcp-adapter',
      },
      "import '@ai-usage/skills';\nimport 'bun:sqlite';\n",
    );

    const violations = await collectFixtureViolations(root);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'packages/mcp-adapter/package.json',
          packageName: '@ai-usage/mcp-adapter',
          specifier: '@ai-usage/usage-store',
        }),
        expect.objectContaining({
          file: 'packages/mcp-adapter/src/index.ts',
          packageName: '@ai-usage/mcp-adapter',
          specifier: 'bun:sqlite',
        }),
      ]),
    );
    expect(violations).not.toContainEqual(expect.objectContaining({ specifier: '@ai-usage/skills' }));
  });

  test('keeps Web foundation production modules from importing features', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    await writeWebPresentationClosure(root);
    const foundation = path.join(root, 'apps/web/src/lib/foundation');
    await mkdir(path.join(foundation, 'presentation'), { recursive: true });
    await Promise.all([
      writeFile(path.join(foundation, 'relative.ts'), "import { a } from '../features/work/work-load';\n"),
      writeFile(
        path.join(foundation, 'presentation/aliased.svelte'),
        "<script>import { b } from '#lib/features/report/report-export';</script>\n",
      ),
      writeFile(
        path.join(foundation, 'neighbour.ts'),
        "import { c } from './runtime-mode';\nimport '../query/keys';\n",
      ),
      writeFile(path.join(foundation, 'composed.test.ts'), "import { d } from '../features/work/work-load';\n"),
    ]);

    const violations = await collectFixtureViolations(root);
    expect(violations).toEqual([
      expect.objectContaining({
        file: 'apps/web/src/lib/foundation/presentation/aliased.svelte',
        specifier: '#lib/features/report/report-export',
      }),
      expect.objectContaining({
        file: 'apps/web/src/lib/foundation/relative.ts',
        specifier: '../features/work/work-load',
      }),
    ]);
  });

  test('reports violations in path order whatever order the filesystem lists entries in', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    await writeWebPresentationClosure(root);
    const foundation = path.join(root, 'apps/web/src/lib/foundation/ordering');
    // Created one by one in an order that is neither ascending nor descending, so neither a creation-order nor
    // a reverse-creation-order listing is already sorted; hashed listings (ext4) are unsorted too.
    const creationOrder = ['c.ts', 'd/k.ts', 'a.ts', 'b/z.ts', 'f.ts', 'd/e/m.ts', 'b/a.ts'];
    for (const file of creationOrder) {
      await mkdir(path.dirname(path.join(foundation, file)), { recursive: true });
      await writeFile(path.join(foundation, file), "import { a } from '#lib/features/work/work-load';\n");
    }

    const violations = await collectFixtureViolations(root);
    expect(violations.map(({ file }) => file)).toEqual(
      ['a.ts', 'b/a.ts', 'b/z.ts', 'c.ts', 'd/e/m.ts', 'd/k.ts', 'f.ts'].map(
        (file) => `apps/web/src/lib/foundation/ordering/${file}`,
      ),
    );
  });

  test('keeps the framework-neutral Web presentation closure free of frameworks, Node and server code', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    const lib = path.join(root, 'apps/web/src/lib');
    await Promise.all(
      [
        'foundation/presentation',
        'foundation/dashboard',
        'foundation/session',
        'features/sessions',
        'features/report',
      ].map((directory) => mkdir(path.join(lib, directory), { recursive: true })),
    );
    const entrypoints = [
      'foundation/dashboard/dashboard-analytics.ts',
      'foundation/dashboard/dashboard-model.ts',
      'features/sessions/dashboard-sort.ts',
      'foundation/overview-model.ts',
      'features/report/provider-status-model.ts',
      'foundation/campaign-label-overrides.ts',
      'foundation/session/session-analysis-target.ts',
      'foundation/machine-freshness-presentation.ts',
      'foundation/presentation/report-value.ts',
    ];
    await Promise.all([
      ...entrypoints.map((entrypoint) => writeFile(path.join(lib, entrypoint), 'export {};\n')),
      writeFile(
        path.join(lib, 'foundation/presentation/format.ts'),
        "import { model } from './model';\nimport '@tanstack/table-core';\nimport '@ai-usage/report-core/session-query';\n",
      ),
      writeFile(
        path.join(lib, 'foundation/presentation/model.ts'),
        "import { writable } from 'svelte/store';\nimport { page } from '$app/state';\nimport { aliased } from '#lib/foundation/aliased.ts';\nimport View from './view.svelte';\n",
      ),
      writeFile(path.join(lib, 'foundation/aliased.ts'), "import path from 'node:path';\n"),
      writeFile(path.join(lib, 'foundation/presentation/view.svelte'), '<p>view</p>\n'),
    ]);

    expect(
      (await collectFixtureViolations(root)).map(({ file, specifier }) => `${file} -> ${specifier}`).toSorted(),
    ).toEqual([
      'apps/web/src/lib/foundation/aliased.ts -> node:path',
      'apps/web/src/lib/foundation/presentation/model.ts -> $app/state',
      'apps/web/src/lib/foundation/presentation/model.ts -> svelte/store',
      'apps/web/src/lib/foundation/presentation/view.svelte -> apps/web/src/lib/foundation/presentation/view.svelte',
    ]);
  });

  test('reports a missing closure entrypoint while the rest of its closure exists', async () => {
    const root = await createFixture();
    await writePackage(root, 'apps', 'web', { name: '@ai-usage/web' });
    await mkdir(path.join(root, 'apps/web/src/lib/foundation/presentation'), { recursive: true });
    await writeFile(path.join(root, 'apps/web/src/lib/foundation/presentation/format.ts'), 'export {};\n');

    const missing = (await collectFixtureViolations(root)).filter(({ message }) =>
      message.endsWith('entrypoint is missing.'),
    );
    expect(missing).toHaveLength(9);
    expect(missing).toContainEqual(
      expect.objectContaining({
        file: 'apps/web/src/lib/foundation/presentation/report-value.ts',
        packageName: '@ai-usage/web',
      }),
    );
  });

  test('keeps the passive design closure on plain TypeScript and the generated css entry', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'design-system', { name: '@ai-usage/design-system' });
    const source = path.join(root, 'packages/design-system/src');
    await Promise.all([
      mkdir(path.join(source, 'components')),
      mkdir(path.join(source, 'svelte/passive'), { recursive: true }),
    ]);
    const passiveModules = [
      'chart',
      'empty-state',
      'field',
      'layout',
      'overview',
      'panel',
      'skills',
      'status',
      'table',
      'time-slider',
    ];
    await Promise.all([
      ...passiveModules.map((name) =>
        writeFile(path.join(source, `components/${name}.ts`), "import { css } from '@ai-usage/design-system/css';\n"),
      ),
      writeFile(
        path.join(source, 'components/button.ts'),
        "import { fill } from '../svelte/passive/harness-fill';\nimport Badge from './badge.svelte';\n",
      ),
      writeFile(
        path.join(source, 'svelte/passive/harness-fill.ts'),
        "import { Dialog } from '@ark-ui/svelte/dialog';\nimport { clsx } from 'clsx';\nimport { onMount } from 'svelte';\n",
      ),
      writeFile(path.join(source, 'components/badge.svelte'), '<span>badge</span>\n'),
    ]);

    expect(
      (await collectFixtureViolations(root)).map(({ file, specifier }) => `${file} -> ${specifier}`).toSorted(),
    ).toEqual([
      'packages/design-system/src/components/badge.svelte -> packages/design-system/src/components/badge.svelte',
      'packages/design-system/src/svelte/passive/harness-fill.ts -> @ark-ui/svelte/dialog',
      'packages/design-system/src/svelte/passive/harness-fill.ts -> clsx',
      'packages/design-system/src/svelte/passive/harness-fill.ts -> svelte',
    ]);
  });

  describe('module closures', () => {
    const closureFixtures = [
      {
        directory: 'packages/report-data',
        entrypoints: ['src/portable-report.ts'],
        label: 'report-data',
        name: 'portable-report',
        packageName: reportDataPackage,
      },
      {
        directory: 'apps/web',
        entrypoints: webPresentationEntrypoints,
        label: '@ai-usage/web',
        name: 'framework-neutral Web presentation',
        packageName: '@ai-usage/web',
      },
      {
        directory: 'packages/design-system',
        entrypoints: [
          'src/components/button.ts',
          'src/components/chart.ts',
          'src/components/empty-state.ts',
          'src/components/field.ts',
          'src/components/layout.ts',
          'src/components/overview.ts',
          'src/components/panel.ts',
          'src/components/skills.ts',
          'src/components/status.ts',
          'src/components/table.ts',
          'src/components/time-slider.ts',
        ],
        label: '@ai-usage/design-system',
        name: 'passive design',
        packageName: '@ai-usage/design-system',
      },
    ] as const;

    /** A package whose closure entrypoints all exist and are empty, except `first`, which holds `firstSource`. */
    const writeClosure = async (fixture: (typeof closureFixtures)[number], firstSource: string): Promise<string> => {
      const root = await createFixture();
      const [parent, directory] = fixture.directory.split('/') as ['apps' | 'packages', string];
      await writePackage(root, parent, directory, { name: fixture.packageName });
      const [first, ...others] = fixture.entrypoints;
      await Promise.all(
        fixture.entrypoints.map((entrypoint) =>
          mkdir(path.dirname(path.join(root, fixture.directory, entrypoint)), { recursive: true }),
        ),
      );
      await Promise.all([
        writeFile(path.join(root, fixture.directory, first), firstSource),
        ...others.map((entrypoint) => writeFile(path.join(root, fixture.directory, entrypoint), 'export {};\n')),
      ]);
      return root;
    };

    const closureViolations = async (root: string, packageName: string) =>
      (await collectFixtureViolations(root))
        .filter((violation) => violation.packageName === packageName)
        .map(({ file, message, specifier }) => ({ file, message, specifier }));

    test.each(closureFixtures.map((fixture) => [fixture.name, fixture] as const))(
      'the %s closure fails closed on a relative import that resolves to nothing',
      async (_name, fixture) => {
        const root = await writeClosure(fixture, "export { missing } from './missing';\n");

        expect(await closureViolations(root, fixture.packageName)).toEqual([
          {
            file: `${fixture.directory}/${fixture.entrypoints[0]}`,
            message: `The ${fixture.name} import closure must resolve relative modules inside ${fixture.label}.`,
            specifier: './missing',
          },
        ]);
      },
    );

    test.each(closureFixtures.map((fixture) => [fixture.name, fixture] as const))(
      'the %s closure refuses a relative import that leaves its package',
      async (_name, fixture) => {
        const depth = fixture.entrypoints[0].split('/').length + 1;
        const specifier = `${'../'.repeat(depth)}elsewhere/outside`;
        const root = await writeClosure(fixture, `export { outside } from '${specifier}';\n`);
        await mkdir(path.join(root, 'elsewhere'));
        await writeFile(path.join(root, 'elsewhere/outside.ts'), 'export const outside = true;\n');

        expect(await closureViolations(root, fixture.packageName)).toEqual([
          {
            file: `${fixture.directory}/${fixture.entrypoints[0]}`,
            message: `The ${fixture.name} import closure must resolve relative modules inside ${fixture.label}.`,
            specifier,
          },
        ]);
      },
    );

    test.each(closureFixtures.map((fixture) => [fixture.name, fixture] as const))(
      'the %s closure reports a policy whose entrypoints have all disappeared',
      async (_name, fixture) => {
        const root = await createFixture();
        const [parent, directory] = fixture.directory.split('/') as ['apps' | 'packages', string];
        await writePackage(root, parent, directory, { name: fixture.packageName });

        expect(await closureViolations(root, fixture.packageName)).toEqual([
          {
            file: fixture.directory,
            message: `The ${fixture.name} import closure has none of its ${fixture.entrypoints.length} entrypoints: update its policy in tools/package-boundary-module-closures.ts instead of leaving the closure unchecked.`,
            specifier: fixture.entrypoints.join(', '),
          },
        ]);
      },
    );

    test('the framework-neutral Web presentation closure excludes server modules by name, directory and alias', async () => {
      const webFixture = closureFixtures[1];
      const root = await writeClosure(
        webFixture,
        "import './quota.server.ts';\nimport '../server/clock';\nimport '#lib/server/rpc/client';\n",
      );
      const lib = path.join(root, 'apps/web/src/lib');
      await Promise.all([
        mkdir(path.join(lib, 'foundation/server'), { recursive: true }),
        mkdir(path.join(lib, 'server/rpc'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(lib, 'foundation/dashboard/quota.server.ts'), 'export {};\n'),
        writeFile(path.join(lib, 'foundation/server/clock.ts'), 'export {};\n'),
        writeFile(path.join(lib, 'server/rpc/client.ts'), 'export {};\n'),
      ]);
      const serverModule = (file: string) => ({
        file,
        message:
          'The framework-neutral Web presentation closure may contain only TypeScript modules outside server code.',
        specifier: file,
      });

      expect(
        (await closureViolations(root, webFixture.packageName)).toSorted((left, right) =>
          left.file.localeCompare(right.file),
        ),
      ).toEqual([
        serverModule('apps/web/src/lib/foundation/dashboard/quota.server.ts'),
        serverModule('apps/web/src/lib/foundation/server/clock.ts'),
        serverModule('apps/web/src/lib/server/rpc/client.ts'),
      ]);
    });
  });

  test('accepts the current workspace graph', async () => {
    expect(await collectViolations(repositoryRoot)).toEqual([]);
  });
});

const writeSource = async (root: string, relativeFile: string, source: string): Promise<void> => {
  await mkdir(path.dirname(path.join(root, relativeFile)), { recursive: true });
  await writeFile(path.join(root, relativeFile), source);
};

const violationLocations = async (root: string): Promise<readonly string[]> =>
  (await collectFixtureViolations(root)).map(({ file, specifier }) => `${file} ${specifier}`).toSorted();

describe('web contract production closure', () => {
  const webContractPackage = { name: `${workspacePackageScope}web-contract` };
  const forbiddenWebRouter = ['@ai-usage', 'web', 'server', 'router'].join('/');

  test('rejects direct, re-exported and literal dynamic runtime imports', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'web-contract',
      webContractPackage,
      `import 'node:fs';\nexport { router } from '${forbiddenWebRouter}';\nexport const load = () => import('bun:sqlite');\n`,
    );

    expect(await violationLocations(root)).toEqual(
      [
        'packages/web-contract/src/index.ts node:fs',
        `packages/web-contract/src/index.ts ${forbiddenWebRouter}`,
        'packages/web-contract/src/index.ts bun:sqlite',
      ].toSorted(),
    );
  });

  test('follows relative imports to a forbidden dependency in a leaf module', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'web-contract', webContractPackage, "import './leaf';\n");
    await writeSource(root, 'packages/web-contract/src/leaf.ts', "import '@orpc/server';\n");

    expect(await violationLocations(root)).toEqual(['packages/web-contract/src/leaf.ts @orpc/server']);
  });

  test('fails closed for relative imports that leave src or do not resolve', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'web-contract',
      webContractPackage,
      "import '../scripts/generate';\nimport './missing';\n",
    );
    await writeSource(root, 'packages/web-contract/scripts/generate.ts', 'export {};\n');

    expect(await violationLocations(root)).toEqual([
      'packages/web-contract/src/index.ts ../scripts/generate',
      'packages/web-contract/src/index.ts ./missing',
    ]);
  });

  test('permits only reviewed pure contract dependencies, internal leaves and test sources', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'web-contract', webContractPackage, "export { value } from './value';\n");
    await writeSource(
      root,
      'packages/web-contract/src/value.ts',
      "import { oc } from '@orpc/contract';\nimport * as v from 'valibot';\nimport type { Row } from '@ai-usage/report-core/rows';\nexport const value = oc.input(v.string());\n",
    );
    await writeSource(root, 'packages/web-contract/src/value.test.ts', "import 'bun:test';\nimport 'node:fs';\n");

    expect(await collectFixtureViolations(root)).toEqual([]);
  });

  test('follows production imports into fixture and .mts modules and rejects test-source imports', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'web-contract',
      webContractPackage,
      "import './helpers.test';\nimport './helpers.test.js';\nimport './leaf.mjs';\n",
    );
    await writeSource(root, 'packages/web-contract/src/contract.ts', "export * from './fixtures/runtime';\n");
    await writeSource(root, 'packages/web-contract/src/fixtures/runtime.ts', "import 'node:fs';\n");
    await writeSource(root, 'packages/web-contract/src/helpers.test.ts', 'export {};\n');
    await writeSource(root, 'packages/web-contract/src/leaf.mts', "import 'bun:sqlite';\n");

    expect(await violationLocations(root)).toEqual(
      [
        'packages/web-contract/src/fixtures/runtime.ts node:fs',
        'packages/web-contract/src/index.ts ./helpers.test',
        'packages/web-contract/src/index.ts ./helpers.test.js',
        'packages/web-contract/src/leaf.mts bun:sqlite',
      ].toSorted(),
    );
  });

  test('recognises dynamic import and require calls written with a space', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'web-contract',
      webContractPackage,
      "export const load = () => import ('node:fs');\nexport const open = () => require ('bun:sqlite');\n",
    );

    expect(await violationLocations(root)).toEqual(
      ['packages/web-contract/src/index.ts node:fs', 'packages/web-contract/src/index.ts bun:sqlite'].toSorted(),
    );
  });

  test('permits only the exact reviewed Skills contract entrypoints', async () => {
    const root = await createFixture();
    const unreviewedSkillsSpecifier = ['@ai-usage/skills', 'not-reviewed'].join('/');
    await writePackage(
      root,
      'packages',
      'web-contract',
      webContractPackage,
      `import '@ai-usage/skills/config';\nimport '@ai-usage/skills/shared';\nimport '@ai-usage/skills/application';\nimport '@ai-usage/skills';\nimport '${unreviewedSkillsSpecifier}';\n`,
    );

    expect(await violationLocations(root)).toEqual(
      [
        'packages/web-contract/src/index.ts @ai-usage/skills/application',
        'packages/web-contract/src/index.ts @ai-usage/skills',
        `packages/web-contract/src/index.ts ${unreviewedSkillsSpecifier}`,
      ].toSorted(),
    );
  });
});

describe('zstd decoder ownership', () => {
  const localCollectorsPackage = { name: `${workspacePackageScope}local-collectors` };

  test('rejects one-shot zstd decoders in local-machine and local-collectors production source', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'local-machine',
      { name: localMachineRoot },
      "import { ZstdDecompress, zstdDecompressSync } from 'node:zlib';\n",
    );
    await writePackage(
      root,
      'packages',
      'local-collectors',
      localCollectorsPackage,
      'export const decode = (bytes: Uint8Array) => Bun.zstdDecompress(bytes);\n',
    );
    await writeSource(
      root,
      'packages/local-collectors/src/testing/stream.ts',
      "import { createZstdDecompress } from 'node:zlib';\n",
    );

    expect(await violationLocations(root)).toEqual(
      [
        'packages/local-machine/src/index.ts ZstdDecompress',
        'packages/local-machine/src/index.ts zstdDecompressSync',
        'packages/local-collectors/src/index.ts zstdDecompress',
        'packages/local-collectors/src/testing/stream.ts createZstdDecompress',
      ].toSorted(),
    );
  });

  test('scans fixture directories and every source that is not a .test file', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'local-collectors', localCollectorsPackage);
    await writeSource(
      root,
      'packages/local-collectors/src/fixtures/decode.ts',
      'export const decode = (bytes: Uint8Array) => Bun.zstdDecompressSync(bytes);\n',
    );
    await writeSource(root, 'packages/local-collectors/src/decode.spec.ts', 'Bun.zstdDecompress(new Uint8Array(0));\n');

    expect(await violationLocations(root)).toEqual(
      [
        'packages/local-collectors/src/decode.spec.ts zstdDecompress',
        'packages/local-collectors/src/fixtures/decode.ts zstdDecompressSync',
      ].toSorted(),
    );
  });

  test('allows the streaming decoder only in the local-history reader', async () => {
    const root = await createFixture();
    const streaming = "export const stream = new DecompressionStream('zstd');\n";
    await writePackage(root, 'packages', 'local-machine', { name: localMachineRoot }, streaming);
    await writeSource(root, 'packages/local-machine/src/local-history.ts', streaming);
    await writeSource(root, 'packages/local-collectors/src/index.ts', streaming);
    await writeFile(
      path.join(root, 'packages/local-collectors/package.json'),
      `${JSON.stringify(localCollectorsPackage)}\n`,
    );

    expect(await violationLocations(root)).toEqual([
      'packages/local-collectors/src/index.ts DecompressionStream',
      'packages/local-machine/src/index.ts DecompressionStream',
    ]);
  });

  test('leaves compressors, test sources and other packages alone', async () => {
    const root = await createFixture();
    await writePackage(
      root,
      'packages',
      'local-machine',
      { name: localMachineRoot },
      'export const archive = (text: string) => Bun.zstdCompressSync(text);\n',
    );
    await writeSource(
      root,
      'packages/local-machine/src/archive.test.ts',
      "Bun.zstdDecompressSync(new Uint8Array(0));\nnew DecompressionStream('zstd');\n",
    );
    await writePackage(
      root,
      'packages',
      'example',
      { name: '@ai-usage/example' },
      "import { zstdDecompressSync } from 'node:zlib';\n",
    );

    expect(await collectFixtureViolations(root)).toEqual([]);
  });
});

describe('engine package public exports', () => {
  const controlPackage = `${workspacePackageScope}usage-engine-control`;
  const controlExports = {
    '.': './src/contracts.ts',
    './client': './src/client.ts',
    './completion': './src/completion.ts',
    './delegation-operations': './src/delegation-operations.ts',
    './handoff': './src/handoff.ts',
    './node': './src/rendezvous.ts',
    './testing': './src/testing.ts',
  };

  test('accepts the reviewed exports map', async () => {
    const root = await createFixture();
    await writePackage(root, 'packages', 'usage-engine-control', { exports: controlExports, name: controlPackage });

    expect(await collectFixtureViolations(root)).toEqual([]);
  });

  test('rejects an added, removed or retargeted subpath and a missing map', async () => {
    const root = await createFixture();
    const { './testing': _removed, ...withoutTesting } = controlExports;
    await writePackage(root, 'packages', 'usage-engine-control', {
      exports: { ...withoutTesting, '.': './src/index.ts', './internal': './src/internal.ts' },
      name: controlPackage,
    });
    await writePackage(root, 'apps', 'usage-engine', { name: `${workspacePackageScope}usage-engine` });

    expect(await violationLocations(root)).toEqual(
      [
        'packages/usage-engine-control/package.json .',
        'packages/usage-engine-control/package.json ./internal',
        'packages/usage-engine-control/package.json ./testing',
        'apps/usage-engine/package.json ./main',
      ].toSorted(),
    );
  });
});

describe('guarded package presence', () => {
  const guardedPackageNames = [
    'local-collectors',
    'local-machine',
    'usage-engine',
    'usage-engine-control',
    'usage-engine-runtime',
    'usage-store',
    'web-contract',
  ].map((name) => `${workspacePackageScope}${name}`);

  test('requires every guarded package by default', async () => {
    const root = await createFixture();

    const violations = await collectViolations(root);
    expect(violations.map(({ packageName }) => packageName).toSorted()).toEqual(guardedPackageNames);
    expect(violations.every(({ message }) => message.includes('is missing from the workspace'))).toBe(true);
  });

  test('rejects a guarded package without src or without production source', async () => {
    const root = await createFixture();
    await writeSource(
      root,
      'packages/web-contract/package.json',
      `${JSON.stringify({ name: `${workspacePackageScope}web-contract` })}\n`,
    );
    await writeSource(root, 'packages/local-machine/package.json', `${JSON.stringify({ name: localMachineRoot })}\n`);
    await writeSource(root, 'packages/local-machine/src/reader.test.ts', 'export {};\n');

    expect(await violationLocations(root)).toEqual([
      'packages/local-machine/src packages/local-machine/src',
      'packages/web-contract/src packages/web-contract/src',
    ]);
  });
});
