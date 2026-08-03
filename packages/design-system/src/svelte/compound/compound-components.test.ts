import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { multiSelectSummary } from './multi-select';
import { nextSegmentValue } from './segmented-control';
import { keepTabPanelInTabOrder } from './tab-panel';

const compoundDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(compoundDirectory, '../../../../..');
const SOLID_RUNTIME_IMPORT_PATTERN = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)['"`]solid-js(?:\/[^'"`]+)?['"`]/u;
const BROWSER_PROOF_TIMEOUT_MS = 15_000;
const POSITIONING_PIXEL_TOLERANCE = 1;

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

  test(
    'the real fixture preserves keyboard, portal, form, and lazy-panel behavior in Chromium',
    async () => {
      const temporaryDirectory = await mkdtemp(resolve(compoundDirectory, '.browser-'));
      let server: Awaited<ReturnType<typeof createServer>> | undefined;
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      let executionError: unknown;
      let executionFailed = false;
      try {
        const fixturePath = resolve(compoundDirectory, 'compound.fixture.svelte');
        const fixtureUrlPath = relative(repositoryDirectory, temporaryDirectory);
        await writeFile(
          resolve(temporaryDirectory, 'index.html'),
          '<div id="app"></div><script type="module" src="./main.ts"></script>',
        );
        await writeFile(
          resolve(temporaryDirectory, 'main.ts'),
          `import { mount } from 'svelte'; import '@ai-usage/design-system/styles.css'; import Fixture from ${JSON.stringify(
            fixturePath,
          )}; mount(Fixture, { target: document.querySelector('#app') });`,
        );

        server = await createServer({
          configFile: false,
          logLevel: 'silent',
          plugins: [svelte()],
          root: repositoryDirectory,
          server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null },
        });
        const chromeExecutable = Bun.which('google-chrome');
        if (!chromeExecutable) {
          throw new Error('The D3 browser proof requires the installed google-chrome executable.');
        }
        await server.listen();
        browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
        const address = server.httpServer?.address();
        if (!(address && typeof address === 'object')) {
          throw new Error('The synthetic D3 Vite server did not expose a TCP address.');
        }
        const page = await browser.newPage();
        page.setDefaultTimeout(2000);
        await page.goto(`http://127.0.0.1:${address.port}/${fixtureUrlPath}/`);

        const multiFixture = page.getByTestId('multi-select-fixture');
        const multiTrigger = page.getByRole('combobox', { name: 'Filter fixture machines' });
        await multiTrigger.focus();
        await multiTrigger.press('ArrowDown');
        await page
          .locator('[data-scope="select"][data-part="item"][data-highlighted]', { hasText: 'Alpha workstation' })
          .waitFor();
        const selectContent = page.locator('[data-scope="select"][data-part="content"]');
        await selectContent.press('Enter');
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="multi-select-fixture"]')?.getAttribute('data-selection') === 'alpha',
        );
        expect(await multiFixture.getAttribute('data-selection')).toBe('alpha');
        expect(await multiTrigger.getAttribute('data-state')).toBe('open');
        const hiddenAlphaOption = page.locator('select[name="fixture-machines"] option[value="alpha"]');
        expect(await hiddenAlphaOption.evaluate((option) => Reflect.get(option, 'selected'))).toBe(true);
        const positioner = page.locator('body > [data-scope="select"][data-part="positioner"]');
        expect(await positioner.count()).toBe(1);
        expect(await positioner.evaluate((element) => getComputedStyle(element).zIndex)).toBe('50');
        const [triggerBounds, positionerBounds] = await Promise.all([
          multiTrigger.boundingBox(),
          positioner.boundingBox(),
        ]);
        if (!(triggerBounds && positionerBounds)) {
          throw new Error('The open D3 Select trigger and positioner must both have measurable bounds.');
        }
        expect(Math.abs(triggerBounds.width - positionerBounds.width)).toBeLessThanOrEqual(POSITIONING_PIXEL_TOLERANCE);
        await selectContent.press('Home');
        await selectContent.press('Enter');
        await page.waitForFunction(
          () => document.querySelector('[data-testid="multi-select-fixture"]')?.getAttribute('data-selection') === '',
        );
        expect(await multiFixture.getAttribute('data-selection')).toBe('');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Toggle dynamic option' }).click();
        await multiTrigger.click();
        expect(
          await page.locator('[data-scope="select"][data-part="item"]', { hasText: 'Gamma workstation' }).count(),
        ).toBe(1);
        await multiTrigger.click();
        await positioner.waitFor({ state: 'hidden' });

        const segmentedFixture = page.getByTestId('segmented-control-fixture');
        const week = page.getByRole('radio', { name: 'Week' });
        await week.focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Month');
        await page.keyboard.press('Space');
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="segmented-control-fixture"]')?.getAttribute('data-value') === 'month',
        );
        expect(await segmentedFixture.getAttribute('data-value')).toBe('month');
        await page.keyboard.press('Space');
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="segmented-control-fixture"]')?.getAttribute('data-value') === 'month',
        );
        expect(await segmentedFixture.getAttribute('data-value')).toBe('month');

        const tabsFixture = page.getByTestId('tabs-fixture');
        const overview = page.getByRole('tab', { name: 'Overview' });
        await overview.focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(
          () => document.querySelector('[data-testid="tabs-fixture"]')?.getAttribute('data-value') === 'sessions',
        );
        expect(await tabsFixture.getAttribute('data-value')).toBe('sessions');
        await page.getByText('Overview fixture panel').waitFor({ state: 'detached' });
        expect(await page.getByText('Overview fixture panel').count()).toBe(0);
        const activePanel = page.getByRole('tabpanel');
        await activePanel.getByRole('button', { name: 'Focusable session fixture' }).waitFor();
        await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame())));
        expect(await activePanel.getAttribute('tabindex')).toBe('0');
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(
          () => document.querySelector('[data-testid="tabs-fixture"]')?.getAttribute('data-value') === 'overview',
        );
        expect(await tabsFixture.getAttribute('data-value')).toBe('overview');
      } catch (error) {
        executionError = error;
        executionFailed = true;
      }

      const browserCleanupResults = await Promise.allSettled([Promise.resolve().then(() => browser?.close())]);
      const remainingCleanupResults = await Promise.allSettled([
        Promise.resolve().then(() => server?.close()),
        Promise.resolve().then(() => rm(temporaryDirectory, { force: true, recursive: true })),
      ]);
      const cleanupResults = [...browserCleanupResults, ...remainingCleanupResults];
      const cleanupErrors: unknown[] = [];
      for (const result of cleanupResults) {
        if (result.status === 'rejected') {
          cleanupErrors.push(result.reason);
        }
      }
      if (executionFailed) {
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [executionError, ...cleanupErrors],
            'The D3 browser proof failed and its cleanup also encountered errors.',
          );
        }
        throw executionError;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'The D3 browser proof cleanup encountered errors.');
      }
    },
    BROWSER_PROOF_TIMEOUT_MS,
  );

  test('MultiSelect preserves controlled multiple selection, hidden form state, open state, and stacking', async () => {
    const source = await readCompound('multi-select.svelte');
    for (const contract of [
      'import { field } from \x27../../components/field\x27',
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
    expect('import \x27solid-js\x27').toMatch(SOLID_RUNTIME_IMPORT_PATTERN);
    expect('import { createSignal } from \x27solid-js\x27').toMatch(SOLID_RUNTIME_IMPORT_PATTERN);
    expect('import { render } from \x27solid-js/web\x27').toMatch(SOLID_RUNTIME_IMPORT_PATTERN);
    expect('const solid = import(\x27solid-js\x27)').toMatch(SOLID_RUNTIME_IMPORT_PATTERN);
    expect('const store = import(`solid-js/store`)').toMatch(SOLID_RUNTIME_IMPORT_PATTERN);
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
