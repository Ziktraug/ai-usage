import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { $ } from 'bun';

describe('report app CSS bundle', () => {
  test('inlines generated Panda CSS in the single-file HTML build', async () => {
    const appDir = path.resolve(import.meta.dir, '..');
    await $`bun run build`.cwd(appDir).quiet();

    const htmlPath = path.join(appDir, 'dist/index.html');
    expect(existsSync(htmlPath)).toBe(true);

    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('--colors-canvas');
    expect(html).toContain('--colors-mint');
    expect(html).not.toContain('@layer reset,base,tokens,recipes,utilities;</style>');
  }, 30_000);
});
