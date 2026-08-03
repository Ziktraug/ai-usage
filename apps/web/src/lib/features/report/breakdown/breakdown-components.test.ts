import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';

const breakdownDirectory = import.meta.dir;
const actionsDirectory = resolve(breakdownDirectory, '../actions');
const CLIENT_SOURCE_PATTERN = /\.(?:svelte|ts)$/;
const svelteFiles = [breakdownDirectory, actionsDirectory].flatMap((directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.svelte'))
    .map((name) => join(directory, name)),
);
const sourceFor = (name: string): string => readFileSync(svelteFiles.find((path) => path.endsWith(name)) ?? '', 'utf8');
const stylesSource = readFileSync(join(breakdownDirectory, 'styles.ts'), 'utf8');

describe('P8 Svelte breakdown/action surfaces', () => {
  for (const path of svelteFiles) {
    test(`compiles ${path.slice(path.lastIndexOf('/') + 1)} for server rendering`, () => {
      const compiled = compile(readFileSync(path, 'utf8'), {
        filename: path,
        generate: 'server',
        modernAst: true,
        runes: true,
      });
      expect(compiled.warnings.filter(({ code }) => code !== 'css_unused_selector')).toEqual([]);
      expect(compiled.js.code.length).toBeGreaterThan(0);
    });
  }

  test('retains all four breakdown destinations and visible-only sharing controls', () => {
    const source = sourceFor('dashboard-breakdown.svelte');
    expect(source).toContain("label: 'Models'");
    expect(source).toContain("label: 'Harnesses & providers'");
    expect(source).toContain("label: 'Projects'");
    expect(source).toContain("label: 'Cursor AI'");
    expect(sourceFor('report-sharing-actions.svelte')).toContain('Copy link');
    expect(sourceFor('report-sharing-actions.svelte')).toContain('Export CSV');
  });

  test('retains hierarchy disclosure, responsive project projections, and quota reset/gap evidence', () => {
    const hierarchy = sourceFor('harness-provider-panel.svelte');
    expect(hierarchy).toContain('Providers for');
    expect(hierarchy).toContain('onToggle');
    const projects = sourceFor('project-summary.svelte');
    expect(projects).toContain('Project summaries');
    expect(projects).toContain('desktopTableSurface');
    const quota = sourceFor('quota-history-panel.svelte');
    expect(quota).toContain('quota observation chart');
    expect(quota).toContain('stroke-dasharray');
    expect(quota).toContain('<caption');
    expect(quota).toContain('Reset filters');
  });
  test('keeps mobile report filters in one coherent two-column stack without changing focus order', () => {
    const filterBar = sourceFor('filter-bar.svelte');
    const searchIndex = filterBar.indexOf(
      'aria-label="Filter sessions by title, project, model, provider, or harness"',
    );
    const controlsIndex = filterBar.indexOf('<div class={controls}>');
    const harnessIndex = filterBar.indexOf('label="Filter by harness"');
    const originIndex = filterBar.indexOf('<OriginFilter');
    const machineIndex = filterBar.indexOf('label="Filter by machine"');
    const sourceSummaryIndex = filterBar.indexOf('{@render sourceControlSummary()}');

    expect(searchIndex).toBeGreaterThanOrEqual(0);
    expect(controlsIndex).toBeGreaterThan(searchIndex);
    expect(harnessIndex).toBeGreaterThan(controlsIndex);
    expect(originIndex).toBeGreaterThan(harnessIndex);
    expect(machineIndex).toBeGreaterThan(originIndex);
    expect(sourceSummaryIndex).toBeGreaterThan(machineIndex);
    expect(stylesSource).toContain("flexDirection: { base: 'column', sm: 'row' }");
    expect(stylesSource).toContain("flexWrap: { base: 'nowrap', sm: 'wrap' }");
    expect(stylesSource).toContain("display: { base: 'grid', sm: 'contents' }");
    expect(stylesSource).toContain("gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'");
    expect(stylesSource).toContain("'& > :last-child:nth-child(odd)': { gridColumn: { base: '1 / -1', sm: 'auto' } }");
    expect(stylesSource).toContain("w: { base: 'full', sm: 'auto' }");
  });
});

describe('P8 Svelte client isolation', () => {
  test('keeps every owned client leaf free of Solid, server, Node, and writer imports', () => {
    const sourceFiles = [breakdownDirectory, actionsDirectory].flatMap((directory) =>
      readdirSync(directory)
        .filter(
          (name) => CLIENT_SOURCE_PATTERN.test(name) && !name.endsWith('.browser.ts') && !name.endsWith('.test.ts'),
        )
        .map((name) => join(directory, name)),
    );
    const forbidden = [
      '@ai-usage/design-system/report',
      '@ai-usage/design-system/solid',
      '@ai-usage/report-data',
      '@ai-usage/usage-engine-runtime',
      '@ai-usage/usage-merge',
      '@ai-usage/usage-store',
      '@ark-ui/solid',
      '@orpc/server',
      'node:',
      'solid-js',
    ];
    const violations: string[] = [];
    for (const path of sourceFiles) {
      const source = readFileSync(path, 'utf8');
      for (const specifier of forbidden) {
        if (source.includes(`from '${specifier}`) || source.includes(`import '${specifier}`)) {
          violations.push(`${path} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
