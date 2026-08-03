import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';

const components = [
  'report-header.svelte',
  'report-pending-surface.svelte',
  'report-root.svelte',
  'report-status.svelte',
  'report-warnings.svelte',
  'report-workspace.svelte',
] as const;

describe('report Svelte SSR components', () => {
  for (const component of components) {
    it(`compiles ${component} for server rendering`, async () => {
      const sourcePath = new URL(component, import.meta.url);
      const source = await readFile(sourcePath, 'utf8');
      const compiled = compile(source, {
        filename: sourcePath.pathname,
        generate: 'server',
        modernAst: true,
        runes: true,
      });
      expect(compiled.warnings.filter((warning) => warning.code !== 'css_unused_selector')).toEqual([]);
      expect(compiled.js.code.length).toBeGreaterThan(0);
    });
  }

  it('retains complete output while a destination refresh is pending', async () => {
    const source = await readFile(new URL('./report-workspace.svelte', import.meta.url), 'utf8');
    expect(source.indexOf('{#if hasOutput}')).toBeLessThan(source.indexOf('{:else if pending}'));
    expect(source).toContain('data-report-complete-output');
    expect(source).toContain('<ReportStatus {pending} {refreshError} />');
  });
});
