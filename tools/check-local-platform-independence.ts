import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const commandOutputLimit = 6000;
const repositoryRoot = path.resolve(import.meta.dir, '..');

export interface LocalPlatformIndependenceResult {
  readonly authenticationFactoryCalls: number;
  readonly commands: readonly string[];
  readonly factoryCalls: number;
  readonly platformFactoryCalls: number;
}

export class LocalPlatformIndependenceError extends Error {
  readonly code: 'command-failed' | 'factory-consulted';
  readonly command: string | null;
  readonly detail: string | null;

  constructor(
    code: 'command-failed' | 'factory-consulted',
    options: { readonly command?: string; readonly detail?: string } = {},
  ) {
    super('The local platform-independence gate failed.');
    this.name = 'LocalPlatformIndependenceError';
    this.code = code;
    this.command = options.command ?? null;
    this.detail = options.detail?.slice(0, commandOutputLimit) ?? null;
  }
}

interface GuardCommand {
  readonly arguments: readonly string[];
  readonly label: string;
}

const guardCommands: readonly GuardCommand[] = Object.freeze([
  {
    arguments: ['test', 'packages/report-core/src/analytics.test.ts'],
    label: 'local-package',
  },
  {
    arguments: ['test', 'packages/memory-sqlite'],
    label: 'memory-identity',
  },
  {
    arguments: ['test', 'packages/memory-service'],
    label: 'memory-service',
  },
  {
    arguments: ['test', 'apps/usage-engine'],
    label: 'usage-engine',
  },
  {
    arguments: ['test', 'apps/cli/src/usage-read-model.test.ts'],
    label: 'cli-read',
  },
  {
    arguments: ['--no-env-file', 'tools/run-web-demo.ts', '--prepare-only'],
    label: 'web-demo-prepare',
  },
  {
    arguments: ['--no-env-file', 'run', '--cwd', 'apps/web', 'build'],
    label: 'web-build',
  },
]);

const sharedAuthenticationEnvironmentKeys = new Set([
  'AI_USAGE_AUTH_SECRETS',
  'AI_USAGE_DEVICE_TOKEN_KEYS',
  'AI_USAGE_FIRST_OWNER_BOOTSTRAP',
  'AI_USAGE_GITHUB_CLIENT_ID',
  'AI_USAGE_GITHUB_CLIENT_SECRET',
]);

const withoutPlatformEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !key.startsWith('AI_USAGE_PLATFORM_') && !sharedAuthenticationEnvironmentKeys.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
};

const shellPath = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const readFactoryCalls = async (
  markerPath: string,
): Promise<{ readonly authentication: number; readonly platform: number }> => {
  const text = await readFile(markerPath, 'utf8');
  const lines = text.split('\n');
  return {
    authentication: lines.filter((line) => line === 'authentication-factory-called').length,
    platform: lines.filter((line) => line === 'platform-factory-called').length,
  };
};

const runGuardedCommand = async (
  shimPath: string,
  command: GuardCommand,
  environment: Record<string, string>,
): Promise<void> => {
  const child = Bun.spawn({
    cmd: [shimPath, ...command.arguments],
    cwd: repositoryRoot,
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, 120_000);
  timeout.unref();
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  clearTimeout(timeout);
  if (timedOut || exitCode !== 0) {
    throw new LocalPlatformIndependenceError('command-failed', {
      command: command.label,
      detail: stderr || stdout,
    });
  }
};

export const runLocalPlatformIndependenceGate = async (): Promise<LocalPlatformIndependenceResult> => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'ai-usage-local-platform-'));
  const markerPath = path.join(temporaryRoot, 'factory-calls.log');
  const preloadPath = path.join(temporaryRoot, 'failing-platform-factory.ts');
  const shimPath = path.join(temporaryRoot, 'bun');
  const testingModuleUrl = pathToFileURL(
    path.join(repositoryRoot, 'packages', 'postgres-store', 'src', 'testing.ts'),
  ).href;
  const identityTestingModuleUrl = pathToFileURL(
    path.join(repositoryRoot, 'packages', 'identity', 'src', 'testing.ts'),
  ).href;
  const bunExecutable = process.execPath;
  const environment = withoutPlatformEnvironment(process.env);
  environment.PATH = `${temporaryRoot}${path.delimiter}${environment.PATH ?? ''}`;

  try {
    await Promise.all([
      writeFile(markerPath, '', 'utf8'),
      writeFile(
        preloadPath,
        [
          `import { appendFileSync } from 'node:fs';`,
          `import { installSharedAuthenticationServiceFactoryForTesting } from ${JSON.stringify(identityTestingModuleUrl)};`,
          `import { installPlatformStoreFactoryForTesting } from ${JSON.stringify(testingModuleUrl)};`,
          'installPlatformStoreFactoryForTesting(() => {',
          `  appendFileSync(${JSON.stringify(markerPath)}, 'platform-factory-called\\n', 'utf8');`,
          `  return Promise.reject(new Error('Injected platform factory must not be consulted in local mode.'));`,
          '});',
          'installSharedAuthenticationServiceFactoryForTesting(() => {',
          `  appendFileSync(${JSON.stringify(markerPath)}, 'authentication-factory-called\\n', 'utf8');`,
          `  throw new Error('Injected authentication factory must not be consulted in local mode.');`,
          '});',
          '',
        ].join('\n'),
        'utf8',
      ),
      writeFile(
        shimPath,
        [
          '#!/bin/sh',
          'if [ "$1" = "test" ]; then',
          '  shift',
          `  exec ${shellPath(bunExecutable)} test --preload=${shellPath(preloadPath)} "$@"`,
          'fi',
          `exec ${shellPath(bunExecutable)} --preload=${shellPath(preloadPath)} "$@"`,
          '',
        ].join('\n'),
        'utf8',
      ),
    ]);
    await chmod(shimPath, 0o700);

    const completedCommands: string[] = [];
    for (const command of guardCommands) {
      await runGuardedCommand(shimPath, command, environment);
      completedCommands.push(command.label);
    }

    const calls = await readFactoryCalls(markerPath);
    const factoryCalls = calls.authentication + calls.platform;
    if (factoryCalls !== 0) {
      throw new LocalPlatformIndependenceError('factory-consulted');
    }
    return {
      authenticationFactoryCalls: calls.authentication,
      commands: completedCommands,
      factoryCalls,
      platformFactoryCalls: calls.platform,
    };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

if (import.meta.main) {
  const result = await runLocalPlatformIndependenceGate();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
