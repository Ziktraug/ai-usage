import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';
import { compactRevision, pendingAriaBusyAttributes, revisionDisplayBounds } from './model';

const components = [
  'source-actions.svelte',
  'source-card.svelte',
  'source-control-provider.svelte',
  'source-control-summary.svelte',
  'sources-page.svelte',
] as const;

describe('Sources Svelte components', () => {
  for (const component of components) {
    test(`compiles ${component} for server rendering`, async () => {
      const sourcePath = new URL(component, import.meta.url);
      const compiled = compile(await readFile(sourcePath, 'utf8'), {
        filename: sourcePath.pathname,
        generate: 'server',
        modernAst: true,
        runes: true,
      });
      expect(compiled.warnings.filter((warning) => warning.code !== 'css_unused_selector')).toEqual([]);
      expect(compiled.js.code.length).toBeGreaterThan(0);
    });
  }

  test('exposes pending state only while a source command is active', () => {
    expect(pendingAriaBusyAttributes(false)).toEqual({});
    expect(pendingAriaBusyAttributes(true)).toEqual({ 'aria-busy': 'true' });
  });

  test('keeps revision compaction stable at and beyond the named boundary', () => {
    const boundaryRevision = 'r'.repeat(revisionDisplayBounds.maxInlineLength);
    expect(compactRevision(boundaryRevision)).toBe(boundaryRevision);
    expect(compactRevision(`${boundaryRevision}x`)).toBe(
      `${'r'.repeat(revisionDisplayBounds.prefixLength)}…${'r'.repeat(revisionDisplayBounds.suffixLength - 1)}x`,
    );
  });

  test('centralizes per-source enable/run behavior and covers summary busy semantics', async () => {
    const actions = await readFile(new URL('./source-actions.svelte', import.meta.url), 'utf8');
    const card = await readFile(new URL('./source-card.svelte', import.meta.url), 'utf8');
    const page = await readFile(new URL('./sources-page.svelte', import.meta.url), 'utf8');
    const summary = await readFile(new URL('./source-control-summary.svelte', import.meta.url), 'utf8');

    expect(actions).toContain("command: 'set-enabled'");
    expect(actions).toContain("command: 'run-now'");
    expect(actions).toContain('{...pendingAriaBusyAttributes(pending)}');
    expect(card).toContain('<SourceActions');
    expect(page).toContain('<SourceActions');
    expect(summary).toContain('{...pendingAriaBusyAttributes(runPending)}');
  });
});
