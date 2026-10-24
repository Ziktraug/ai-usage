import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindRuntimeOrigin, RUNTIME_ORIGIN_VARIABLE, runtimeOriginHandoffSource } from './sveltekit-loopback-adapter';

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

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['path-qualified', 'http://127.0.0.1:48123/'],
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
