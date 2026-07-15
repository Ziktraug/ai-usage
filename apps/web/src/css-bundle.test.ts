import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { $ } from 'bun';

const CLIENT_BUNDLE_BUILD_TIMEOUT_MS = 120_000;

describe('report app client bundle', () => {
  test(
    'emits generated Panda CSS and splits server-only route UI from the report entry',
    async () => {
      const appDir = path.resolve(import.meta.dir, '..');
      await $`bun run build`.cwd(appDir).quiet();

      const assetsDir = path.join(appDir, '.output/public/assets');
      expect(existsSync(assetsDir)).toBe(true);

      const cssFile = readdirSync(assetsDir).find((file) => file.endsWith('.css'));
      if (!cssFile) {
        throw new Error('Expected the report build to emit a CSS asset');
      }

      const css = readFileSync(path.join(assetsDir, cssFile), 'utf8');
      expect(css).toContain('--colors-canvas');
      expect(css).toContain('--colors-accent');
      expect(css).toContain('[data-theme=dark]');
      expect(css).toContain('prefers-color-scheme:dark');
      expect(css).not.toContain('@layer reset,base,tokens,recipes,utilities;');

      const javascriptFiles = readdirSync(assetsDir).filter((file) => file.endsWith('.js'));
      const reportEntry = javascriptFiles.find((file) => file.startsWith('index-'));
      expect(javascriptFiles.length).toBeGreaterThan(2);
      if (!reportEntry) {
        throw new Error('Expected the report build to emit an index JavaScript entry');
      }
      expect(readFileSync(path.join(assetsDir, reportEntry)).byteLength).toBeLessThan(720_000);
    },
    CLIENT_BUNDLE_BUILD_TIMEOUT_MS,
  );
});
