import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { $ } from 'bun';

describe('report app CSS bundle', () => {
  test('emits generated Panda CSS in the Start client build', async () => {
    const appDir = path.resolve(import.meta.dir, '..');
    await $`bun run build`.cwd(appDir).quiet();

    const assetsDir = path.join(appDir, '.output/public/assets');
    expect(existsSync(assetsDir)).toBe(true);

    const cssFile = readdirSync(assetsDir).find((file) => file.endsWith('.css'));
    expect(cssFile).toBeTruthy();

    const css = readFileSync(path.join(assetsDir, cssFile!), 'utf8');
    expect(css).toContain('--colors-canvas');
    expect(css).toContain('--colors-accent');
    expect(css).toContain('[data-theme=dark]');
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).not.toContain('@layer reset,base,tokens,recipes,utilities;');
  }, 30_000);
});
