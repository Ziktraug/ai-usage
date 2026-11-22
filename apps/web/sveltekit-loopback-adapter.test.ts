import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ADAPTER_ENVIRONMENT_PREFIX,
  bindRuntimeOrigin,
  LOOPBACK_HOSTNAME,
  loopbackBunAdapterOptions,
  RUNTIME_ORIGIN_VARIABLE,
  runtimeOriginHandoffSource,
} from './sveltekit-loopback-adapter';

// The shape `@sveltejs/adapter-bun@1.0.0` writes to `<out>/adapter-bun.js` when `paths.origin` is unset.
const generatedHandoff = [
  "import { dirname } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'export const dir = dirname(fileURLToPath(import.meta.url));',
  'export const app_dir = "_app";',
  'export const base = "/";',
  'export const embed = false;',
  'export const env_prefix = "";',
  'export const origin = undefined;',
  'export const server_options = {};',
  'export const assets = [];',
  '',
].join('\n');

const temporaryDirectories: string[] = [];
const originalRuntimeOrigin = process.env[RUNTIME_ORIGIN_VARIABLE];

afterEach(async () => {
  if (originalRuntimeOrigin === undefined) {
    delete process.env[RUNTIME_ORIGIN_VARIABLE];
  } else {
    process.env[RUNTIME_ORIGIN_VARIABLE] = originalRuntimeOrigin;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const boundOutput = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-loopback-adapter-'));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, 'adapter-bun.js'), generatedHandoff);
  await bindRuntimeOrigin(directory);
  return directory;
};

let importSequence = 0;
const importHandoff = async (directory: string): Promise<Record<string, unknown>> =>
  (await import(`${pathToFileURL(path.join(directory, 'adapter-bun.js')).href}?case=${++importSequence}`)) as Record<
    string,
    unknown
  >;

describe('loopback Bun adapter origin binding', () => {
  test('fronts the generated hand-off module and keeps it byte-for-byte', async () => {
    const directory = await boundOutput();

    expect((await readdir(directory)).sort()).toEqual(['adapter-bun.generated.js', 'adapter-bun.js']);
    expect(await readFile(path.join(directory, 'adapter-bun.generated.js'), 'utf8')).toBe(generatedHandoff);
    expect(await readFile(path.join(directory, 'adapter-bun.js'), 'utf8')).toContain(
      "export * from './adapter-bun.generated.js';",
    );
  });

  test('exports the listener origin from ORIGIN and re-exports every other hand-off value', async () => {
    const directory = await boundOutput();
    process.env[RUNTIME_ORIGIN_VARIABLE] = 'http://127.0.0.1:48123';

    const handoff = await importHandoff(directory);

    expect(handoff.origin).toBe('http://127.0.0.1:48123');
    expect(handoff.app_dir).toBe('_app');
    expect(handoff.base).toBe('/');
    expect(handoff.env_prefix).toBe('');
    expect(handoff.server_options).toEqual({});
  });

  // `start.mjs` spells the listener as `http://127.0.0.1:<PORT>`, and `URL.origin` drops a default
  // port, which is also how browsers spell it in `Origin`.
  test.each([
    ['http on port 80', 'http://127.0.0.1:80', 'http://127.0.0.1'],
    ['https on port 443', 'https://127.0.0.1:443', 'https://127.0.0.1'],
    ['an already canonical default port', 'http://127.0.0.1', 'http://127.0.0.1'],
  ])('exports the canonical origin for %s', async (_scenario, value, canonical) => {
    const directory = await boundOutput();
    process.env[RUNTIME_ORIGIN_VARIABLE] = value;

    const handoff = await importHandoff(directory);

    expect(handoff.origin).toBe(canonical);
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['path-qualified', 'http://127.0.0.1:48123/'],
    ['path-qualified default-port', 'http://127.0.0.1:80/'],
    ['credentialed', 'http://user@127.0.0.1:80'],
    ['zero-padded default-port', 'http://127.0.0.1:080'],
    ['non-http', 'file:///tmp/listener'],
  ])('refuses to start with a %s ORIGIN', async (_scenario, value) => {
    const directory = await boundOutput();
    if (value === undefined) {
      delete process.env[RUNTIME_ORIGIN_VARIABLE];
    } else {
      process.env[RUNTIME_ORIGIN_VARIABLE] = value;
    }

    await expect(importHandoff(directory)).rejects.toThrow('ORIGIN must be the canonical origin of this listener');
  });

  test.each([
    ['no origin export', generatedHandoff.replace('export const origin = undefined;\n', '')],
    ['a configured origin', generatedHandoff.replace('origin = undefined', 'origin = "http://127.0.0.1:3000"')],
    ['two origin exports', `${generatedHandoff}export const origin = undefined;\n`],
  ])('fails the build when the hand-off module has %s', (_scenario, source) => {
    expect(() => runtimeOriginHandoffSource(source)).toThrow(
      'The Bun adapter hand-off module no longer exports exactly one unconfigured origin',
    );
  });
});

const ENVIRONMENT_PREFIX_SHAPE = /^[A-Z][A-Z0-9_]*_$/;
const START_PORT = '48123';

/**
 * Runs `start.mjs` as production starts it, with the built server module it imports last replaced
 * by one that prints the environment it would start under, so no build output is needed.
 */
const startEnvironment = async (inherited: Record<string, string>): Promise<Record<string, string>> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-start-environment-'));
  temporaryDirectories.push(directory);
  const preload = path.join(directory, 'stub-server.ts');
  await writeFile(
    preload,
    [
      'Bun.plugin({',
      "  name: 'stub built server',",
      '  setup(build) {',
      "    build.onResolve({ filter: /\\/\\.output-build\\/sveltekit\\/index\\.js$/ }, () => ({ namespace: 'stub-server', path: 'index' }));",
      "    build.onLoad({ filter: /.*/, namespace: 'stub-server' }, () => ({",
      "      contents: 'process.stdout.write(JSON.stringify(process.env));',",
      "      loader: 'js',",
      '    }));',
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', preload, 'start.mjs'], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? '', ...inherited },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 || stderr !== '') {
    throw new Error(`start.mjs exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as Record<string, string>;
};

const prefixedEntries = (environment: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(environment).filter(([name]) => name.startsWith(ADAPTER_ENVIRONMENT_PREFIX)));

describe('loopback Bun adapter environment', () => {
  // Every variable `@sveltejs/adapter-bun@1.0.0` reads, without its prefix. It refuses to start
  // when a variable carries the prefix but names none of these, so the runtime origin stays
  // outside the prefixed namespace.
  const adapterVariables = [
    'ADDRESS_HEADER',
    'BODY_SIZE_LIMIT',
    'CONNECTION_IDLE_TIMEOUT',
    'DEVELOPMENT',
    'HOST',
    'HOST_HEADER',
    'IPV6_ONLY',
    'PORT',
    'PORT_HEADER',
    'PROTOCOL_HEADER',
    'REUSE_PORT',
    'SHUTDOWN_TIMEOUT',
    'SOCKET_PATH',
    'XFF_DEPTH',
  ];

  test('reads the adapter configuration only under a prefix the runtime origin stays outside', () => {
    expect(ADAPTER_ENVIRONMENT_PREFIX).toMatch(ENVIRONMENT_PREFIX_SHAPE);
    expect(RUNTIME_ORIGIN_VARIABLE.startsWith(ADAPTER_ENVIRONMENT_PREFIX)).toBe(false);
    expect(adapterVariables.some((name) => name.startsWith(ADAPTER_ENVIRONMENT_PREFIX))).toBe(false);
  });

  test('start.mjs purges every inherited prefixed variable and writes only its own under the same prefix', async () => {
    const environment = await startEnvironment({
      [`${ADAPTER_ENVIRONMENT_PREFIX}HOST`]: '0.0.0.0',
      [`${ADAPTER_ENVIRONMENT_PREFIX}SOCKET_PATH`]: '/tmp/inherited.sock',
      [`${ADAPTER_ENVIRONMENT_PREFIX}UNREAD`]: 'inherited',
      PORT: START_PORT,
    });

    expect(Object.keys(prefixedEntries(environment)).sort()).toEqual(
      ['BODY_SIZE_LIMIT', 'CONNECTION_IDLE_TIMEOUT', 'HOST', 'PORT', 'SHUTDOWN_TIMEOUT'].map(
        (name) => `${ADAPTER_ENVIRONMENT_PREFIX}${name}`,
      ),
    );
    expect(environment[`${ADAPTER_ENVIRONMENT_PREFIX}PORT`]).toBe(START_PORT);
  });

  test('start.mjs leaves unprefixed names alone: the adapter never reads them, so none is denied', async () => {
    const environment = await startEnvironment({ HOST: '0.0.0.0', PORT: START_PORT, SOCKET_PATH: '/tmp/unread.sock' });

    expect(environment.HOST).toBe('0.0.0.0');
    expect(environment.SOCKET_PATH).toBe('/tmp/unread.sock');
    expect(environment[`${ADAPTER_ENVIRONMENT_PREFIX}HOST`]).toBe(LOOPBACK_HOSTNAME);
  });
});

describe('loopback Bun adapter listener default', () => {
  // The adapter serialises `serverOptions` into the build as Bun.serve's defaults; only a prefixed
  // HOST overrides the hostname, so the built server listens on loopback even without start.mjs.
  test('builds numeric loopback in as the listener hostname, beside the prefix and output options', () => {
    expect(loopbackBunAdapterOptions({ out: '.output-build/sveltekit', precompress: true })).toEqual({
      envPrefix: ADAPTER_ENVIRONMENT_PREFIX,
      out: '.output-build/sveltekit',
      precompress: true,
      serverOptions: { hostname: '127.0.0.1' },
    });
  });

  test('start.mjs sets the same loopback address and rebuilds the trusted origin from it at runtime', async () => {
    const environment = await startEnvironment({ ORIGIN: 'http://attacker.invalid', PORT: START_PORT });

    expect(environment[`${ADAPTER_ENVIRONMENT_PREFIX}HOST`]).toBe(LOOPBACK_HOSTNAME);
    expect(environment[RUNTIME_ORIGIN_VARIABLE]).toBe(`http://${LOOPBACK_HOSTNAME}:${START_PORT}`);
  });
});
