import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { multiSelectSummary } from './multi-select';
import { nextSegmentValue } from './segmented-control';
import { keepTabPanelInTabOrder } from './tab-panel';

const compoundDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(compoundDirectory, '../../../../..');
const SOLID_RUNTIME_IMPORT_PATTERN = /(?:from|import)s*['"]solid-js/u;

const readCompound = async (name: string): Promise<string> => readFile(resolve(compoundDirectory, name), 'utf8');

const compileCompound = async (name: string): Promise<{ exitCode: number; stderr: string }> => {
  const sourcePath = resolve(compoundDirectory, name);
  const compilerProcess = Bun.spawn(
    [
      'bun',
      '--no-env-file',
      '-e',
      `import { readFile } from "node:fs/promises"; import { compile } from "svelte/compiler"; const sourcePath = process.argv[1]; const source = await readFile(sourcePath, "utf8"); const result = compile(source, { filename: sourcePath, generate: "client", modernAst: true, runes: true }); const warnings = result.warnings.filter((warning) => warning.code !== "css_unused_selector"); if (warnings.length > 0) { console.error(JSON.stringify(warnings)); process.exit(1); }`,
      sourcePath,
    ],
    { cwd: repositoryDirectory, stderr: 'pipe', stdout: 'pipe' },
  );
  const [exitCode, stderr] = await Promise.all([compilerProcess.exited, new Response(compilerProcess.stderr).text()]);
  return { exitCode, stderr };
};

describe('Svelte compound controls', () => {
  test('all components and the direct fixture compile with Svelte 5 runes', async () => {
    for (const component of [
      'multi-select.svelte',
      'segmented-control.svelte',
      'tab-panel.svelte',
      'tabs.svelte',
      'compound.fixture.svelte',
    ]) {
      const result = await compileCompound(component);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    }
  });

  test('MultiSelect preserves controlled multiple selection, hidden form state, open state, and stacking', async () => {
    const source = await readCompound('multi-select.svelte');
    for (const contract of [
      'closeOnSelect={false}',
      '<Select.HiddenSelect />',
      'multiple',
      'onValueChange={(details) => onValueChange(details.value)}',
      'positioning={{ sameWidth: true, gutter: 4 }}',
      '{value}',
      '<Portal>',
      "zIndex: '50 !important'",
      "'&[data-state=checked]'",
      "'&[data-highlighted]'",
      "'[data-state=open] &'",
      '{#each options as option (option)}',
      '<Select.ItemText>{optionLabel(option)}</Select.ItemText>',
    ]) {
      expect(source).toContain(contract);
    }
  });

  test('MultiSelect summary retains placeholder, one-option labels, and plural counts across dynamic labels', () => {
    const labels: Readonly<Record<string, string>> = { alpha: 'Alpha workstation', beta: 'Beta workstation' };
    const label = (value: string): string => labels[value] ?? value;

    expect(multiSelectSummary([], 'All machines', 'machines', label)).toBe('All machines');
    expect(multiSelectSummary(['alpha'], 'All machines', 'machines', label)).toBe('Alpha workstation');
    expect(multiSelectSummary(['alpha', 'beta'], 'All machines', 'machines', label)).toBe('2 machines');
    expect(multiSelectSummary(['dynamic'], 'All machines', 'machines', label)).toBe('dynamic');
  });

  test('SegmentedControl keeps exactly one controlled value and delegates arrows and Space to ToggleGroup', async () => {
    expect(nextSegmentValue([])).toBeUndefined();
    expect(nextSegmentValue([''])).toBeUndefined();
    expect(nextSegmentValue(['week'])).toBe('week');

    const source = await readCompound('segmented-control.svelte');
    for (const contract of [
      'aria-label={ariaLabel}',
      'deselectable={false}',
      'orientation="horizontal"',
      'rovingFocus',
      'value={[value]}',
      'if (nextValue)',
      'onValueChange(nextValue)',
      'data-default={String(item.value === defaultValue)}',
    ]) {
      expect(source).toContain(contract);
    }
  });

  test('Tabs remains controlled, composite, disabled-aware, lazy, and unmounted outside the active panel', async () => {
    const source = await readCompound('tabs.svelte');
    for (const contract of [
      'composite',
      'lazyMount',
      'unmountOnExit',
      '{value}',
      'onValueChange={(details) => onValueChange(details.value)}',
      'disabled={item.disabled}',
      'content={item.content}',
    ]) {
      expect(source).toContain(contract);
    }
  });

  test('the active tab panel is restored to tabIndex zero after the Zag animation frame', () => {
    const callbacks: Array<() => void> = [];
    const panel = { isConnected: true, tabIndex: -1 };

    keepTabPanelInTabOrder(panel, (callback) => callbacks.push(callback));
    expect(panel.tabIndex).toBe(0);
    expect(callbacks).toHaveLength(1);

    panel.tabIndex = -1;
    callbacks[0]?.();
    expect(panel.tabIndex).toBe(0);

    panel.isConnected = false;
    panel.tabIndex = -1;
    callbacks[0]?.();
    expect(panel.tabIndex).toBe(-1);
  });

  test('the panel adapter schedules against its owner window and keeps the explicit tabindex attribute', async () => {
    const source = await readCompound('tab-panel.svelte');
    expect(source).toContain('element.ownerDocument.defaultView?.requestAnimationFrame(callback)');
    expect(source).toContain('<Tabs.Content class={className} tabindex={0} {value} bind:ref={panel}>');
  });

  test('the fixture directly consumes each control and exercises controlled and dynamic inputs', async () => {
    const source = await readCompound('compound.fixture.svelte');
    expect(source).toContain("import MultiSelect from './multi-select.svelte'");
    expect(source).toContain("import SegmentedControl from './segmented-control.svelte'");
    expect(source).toContain("import Tabs from './tabs.svelte'");
    expect(source).toContain('name="fixture-machines"');
    expect(source).toContain('Toggle dynamic option');
    expect(source).toContain('disabled: true');
  });

  test('the compound dependency closure cannot reach Solid', async () => {
    const files = await readdir(compoundDirectory);
    for (const file of files.filter(
      (name) => (name.endsWith('.svelte') || name.endsWith('.ts')) && !name.endsWith('.test.ts'),
    )) {
      const source = await readCompound(file);
      expect(source, file).not.toContain('@ark-ui/solid');
      expect(source, file).not.toMatch(SOLID_RUNTIME_IMPORT_PATTERN);
    }
  });
});
