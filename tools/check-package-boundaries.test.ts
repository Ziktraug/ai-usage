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

  test('accepts the current workspace graph', async () => {
    expect(await collectViolations(repositoryRoot)).toEqual([]);
  });
});
