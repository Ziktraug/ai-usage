import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawerClass } from './svelte/overlays/styles';

const packageDirectory = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLASS_SELECTOR = /\.((?:\\.|[\w-])+)/g;
const ESCAPED_CHARACTER = /\\(.)/g;

const classNamesIn = (css: string): Set<string> =>
  new Set([...css.matchAll(CLASS_SELECTOR)].map(([, escaped]) => (escaped ?? '').replace(ESCAPED_CHARACTER, '$1')));

// apps/web consumes this package through Panda's `designSystem` option and never scans its source.
// A consumer with no source of its own must therefore receive the theme and every style the package
// extracted from the `panda lib` manifest alone; Panda 2 silently drops a build info file listed in
// `include`, so this is the contract that keeps design-system components styled in the app.
test('a Panda consumer gets the design-system theme and styles from the panda lib manifest alone', async () => {
  const consumerDirectory = await mkdtemp(path.join(tmpdir(), 'design-system-consumer-'));
  try {
    const emptySource = path.join(consumerDirectory, 'empty.ts');
    const configFile = path.join(consumerDirectory, 'panda.config.mjs');
    const stylesheet = path.join(consumerDirectory, 'styles.css');
    await Bun.write(emptySource, 'export {};\n');
    // A plain object, not defineConfig: the config file lives outside the workspace's node_modules.
    const config = {
      designSystem: '@ai-usage/design-system',
      include: [emptySource],
      outdir: path.join(consumerDirectory, 'styled-system'),
    };
    await Bun.write(configFile, `export default ${JSON.stringify(config)};\n`);

    const result = Bun.spawnSync(
      [
        process.execPath,
        '--bun',
        'panda',
        'cssgen',
        '--cwd',
        packageDirectory,
        '--config',
        configFile,
        '--outfile',
        stylesheet,
        '--log-level',
        'warn',
      ],
      { cwd: packageDirectory, env: { ...process.env, CI: '1' }, stderr: 'pipe', stdout: 'pipe' },
    );

    // A missing or stale manifest surfaces here as a design_system_* diagnostic.
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    const css = await Bun.file(stylesheet).text();
    expect(css).toContain('--colors-surface:');
    expect(css).toContain('@keyframes drawerIn');
    const emitted = classNamesIn(css);
    expect(drawerClass.split(' ').filter((className) => !emitted.has(className))).toEqual([]);
  } finally {
    await rm(consumerDirectory, { force: true, recursive: true });
  }
});
