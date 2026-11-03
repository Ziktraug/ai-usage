import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const checkFixture = async (source: string, compilerOptions: Record<string, unknown> = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-effect-check-'));
  temporaryDirectories.push(directory);
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  await writeFile(path.join(directory, 'fixture.ts'), source);
  const configPath = path.join(directory, 'tsconfig.json');
  await writeFile(
    configPath,
    JSON.stringify({
      extends: path.join(root, 'tsconfig.effect.json'),
      compilerOptions,
      files: ['./fixture.ts'],
      include: [],
      exclude: [],
    }),
  );
  const subprocess = Bun.spawn(
    [process.execPath, '--no-env-file', 'run', 'check:effect', '--project', configPath, '--pretty', 'false'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, output: stdout + stderr };
};

describe('advisory Effect diagnostics', () => {
  test('checks a valid Effect program without diagnostics', async () => {
    const result = await checkFixture('import { Effect } from "effect"; export const program = Effect.succeed("ok");');
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('TS377');
  });

  test('reports an unused Effect without making the advisory check fail', async () => {
    const result = await checkFixture('import { Effect } from "effect"; Effect.succeed("forgotten");');
    expect(result.output).toContain('floatingEffect');
    expect(result.exitCode).toBe(0);
  });

  test('enables typed-error and selected simplification diagnostics', async () => {
    const result = await checkFixture(`
      import { Effect } from "effect";
      export const parsed = Effect.try(() => JSON.parse("{}"));
      export const empty = Effect.succeed(undefined);
    `);
    expect(result.output).toContain('effectTryWithoutCatch');
    expect(result.output).toContain('globalJsonInEffect');
    expect(result.output).toContain('effectSucceedWithUndefined');
    expect(result.exitCode).toBe(0);
  });

  test('omits unselected style suggestions', async () => {
    const result = await checkFixture(`
      import { Effect } from "effect";
      export const program = Effect.succeed(1).pipe(Effect.map(() => undefined));
    `);
    expect(result.output).not.toContain('effectMapVoid');
    expect(result.exitCode).toBe(0);
  });

  test('retains the compiler failure when a TypeScript error accompanies an Effect diagnostic', async () => {
    const result = await checkFixture(`
      import { Effect } from "effect";
      Effect.succeed("forgotten");
      export const value: string = 1;
    `);
    expect(result.output).toContain('floatingEffect');
    expect(result.output).toContain('TS2322');
    expect(result.exitCode).not.toBe(0);
  });

  test('fails on an invalid compiler configuration', async () => {
    const result = await checkFixture('export {};', { invalidEffectPilotOption: true });
    expect(result.output).toContain('invalidEffectPilotOption');
    expect(result.exitCode).not.toBe(0);
  });

  test('fails on an unknown Effect rule instead of silently disabling the requested check', async () => {
    const config: { compilerOptions: { plugins: { diagnosticSeverity: Record<string, string> }[] } } = await Bun.file(
      path.join(root, 'tsconfig.effect.json'),
    ).json();
    const plugin = config.compilerOptions.plugins[0]!;
    const result = await checkFixture('export {};', {
      plugins: [{ ...plugin, diagnosticSeverity: { ...plugin.diagnosticSeverity, misspelledEffectRule: 'warning' } }],
    });
    expect(result.output).toContain('unknownRuleName');
    expect(result.output).toContain('misspelledEffectRule');
    expect(result.exitCode).not.toBe(0);
  });
});
