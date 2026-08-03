import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';

const components = [
  'machine-comparison.svelte',
  'machine-fleet.svelte',
  'manual-transfer-progress.svelte',
  'manual-transfer.svelte',
  'sync-root.svelte',
] as const;

describe('Sync Svelte SSR components', () => {
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

  it('retains equivalent desktop/mobile comparison fields and bounded fleet guidance', async () => {
    const comparison = await readFile(new URL('./machine-comparison.svelte', import.meta.url), 'utf8');
    const fleet = await readFile(new URL('./machine-fleet.svelte', import.meta.url), 'utf8');
    for (const label of ['Machine', 'Sessions', 'Fleet share', 'Newest session', 'Freshness', 'Current']) {
      expect(comparison).toContain(label);
    }
    expect(comparison).toContain('Machine contribution summaries');
    expect(fleet).toContain('data-invalid-stored-rows');
    expect(fleet).toContain('STALE_MACHINE_COLLECTION_GUIDANCE.command');
    expect(fleet).not.toContain('/home/');
  });

  it('keeps preview confirmation explicit and clears stale previews', async () => {
    const transfer = await readFile(new URL('./manual-transfer.svelte', import.meta.url), 'utf8');
    expect(transfer).toContain('Preview ready. Review the changes before confirming.');
    expect(transfer).toContain("result.error.reason === 'preview-stale'");
    expect(transfer).toContain('Peer provenance is preserved; local history is not replaced wholesale.');
  });
});
