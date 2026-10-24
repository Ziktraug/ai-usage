import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ADAPTER_ENVIRONMENT_PREFIX,
  bindRuntimeOrigin,
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
// The statement in `start.mjs` that writes each adapter value under the prefix, spelled as source.
const PREFIXED_WRITE = ['process.env[`$', '{ADAPTER_ENVIRONMENT_PREFIX}$', '{key}`] = value;'].join('');

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

  test('start.mjs purges every inherited prefixed variable before writing its own under the same prefix', async () => {
    const start = await readFile(path.join(import.meta.dir, 'start.mjs'), 'utf8');

    expect(start).toContain(`const ADAPTER_ENVIRONMENT_PREFIX = '${ADAPTER_ENVIRONMENT_PREFIX}';`);
    const purge = start.indexOf('key.startsWith(ADAPTER_ENVIRONMENT_PREFIX)');
    const write = start.indexOf(PREFIXED_WRITE);
    expect(purge).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(purge);
    // Unprefixed names never reach the adapter, so no deny-list of them is kept.
    expect(start).not.toContain('untrustedAdapterEnvironmentKeys');
  });
});
