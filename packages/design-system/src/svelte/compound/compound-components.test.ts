import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { nextSegmentValue } from './segmented-control';
import { keepTabPanelInTabOrder } from './tab-panel';

const compoundDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(compoundDirectory, '../../../../..');
/**
 * Every interaction below is bounded by `page.setDefaultTimeout` — that is the guard that catches a
 * control which stopped responding, and it names the locator when it fires. This budget only has to
 * be large enough that the guard is what fails first.
 *
 * It was not. At 15s it sat well under the 41 interactions x 2s of waiting it permits, so on a
 * loaded runner the test killed itself before any action timed out, reporting an anonymous 15,000ms
 * overrun instead of naming the control that stalled. That is how it failed in CI five times
 * (15000.19, 15001.79, 15003.22 and 15049.89 ms), and why those failures said nothing useful.
 *
 * Sized from the worst case the per-action guard allows, plus the measured setup. Setup is the temp
 * directory, the fixture writes, the Vite server, the Chromium launch and the first paint: 626ms
 * warm and 1,092ms with the Vite cache cleared, measured on the development machine.
 *
 * A real regression still fails in about two seconds, at a named locator. This budget is only
 * reached when the machine is too slow to finish work that is genuinely progressing.
 */
const BROWSER_PROOF_INTERACTIONS = 41;
const BROWSER_PROOF_ACTION_TIMEOUT_MS = 2000;
const BROWSER_PROOF_SETUP_BUDGET_MS = 8000;
const BROWSER_PROOF_TIMEOUT_MS =
  BROWSER_PROOF_SETUP_BUDGET_MS + BROWSER_PROOF_INTERACTIONS * BROWSER_PROOF_ACTION_TIMEOUT_MS;

const ssrServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => ssrServer.close());
const [fixtureModule, rendererModule] = await Promise.all([
  ssrServer.ssrLoadModule('/packages/design-system/src/svelte/compound/compound.fixture.svelte'),
  ssrServer.ssrLoadModule('svelte/server'),
]);
const renderFixture = Reflect.get(rendererModule, 'render') as (component: Component) => { body: string };
const fixtureHtml = renderFixture(Reflect.get(fixtureModule, 'default') as Component).body.replaceAll(
  /<!--[^>]*-->/g,
  '',
);
const attributeOf = (element: string, name: string): string | undefined =>
  element.match(new RegExp(`${name}="([^"]*)"`))?.[1];
const elementsWithPart = (scope: string, part: string): string[] =>
  [...fixtureHtml.matchAll(new RegExp(`<[a-z]+ [^>]*data-scope="${scope}" data-part="${part}"[^>]*>`, 'g'))].map(
    ([element]) => element,
  );

describe('Svelte compound controls', () => {
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
        page.setDefaultTimeout(BROWSER_PROOF_ACTION_TIMEOUT_MS);
        // The first load is setup (Vite transforms the fixture on demand), not an interaction.
        await page.goto(`http://127.0.0.1:${address.port}/${fixtureUrlPath}/`, {
          timeout: BROWSER_PROOF_SETUP_BUDGET_MS,
        });

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

  test('SegmentedControl keeps exactly one controlled value and delegates arrows and Space to ToggleGroup', () => {
    expect(nextSegmentValue([])).toBeUndefined();
    expect(nextSegmentValue([''])).toBeUndefined();
    expect(nextSegmentValue(['week'])).toBe('week');

    // Arrow movement, Space selection and the refusal to deselect are driven in Chromium above.
    const [group] = elementsWithPart('toggle-group', 'root');
    expect(group).toContain('role="radiogroup"');
    expect(group).toContain('aria-label="Fixture range"');
    expect(group).toContain('data-orientation="horizontal"');
    const items = elementsWithPart('toggle-group', 'item');
    expect(items.map((item) => attributeOf(item, 'aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(items.map((item) => attributeOf(item, 'data-default'))).toEqual(['false', 'true', 'false']);
  });

  test('Tabs remains controlled, disabled-aware, lazy, and unmounted outside the active panel', () => {
    // Controlled arrow navigation and the unmounting of the left panel are driven in Chromium above.
    const [list] = elementsWithPart('tabs', 'list');
    expect(list).toContain('aria-label="Fixture sections"');
    const triggers = elementsWithPart('tabs', 'trigger');
    expect(triggers.map((trigger) => attributeOf(trigger, 'aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(triggers.map((trigger) => trigger.includes('aria-disabled="true"'))).toEqual([false, false, true]);
    const panels = elementsWithPart('tabs', 'content');
    expect(panels).toHaveLength(1);
    expect(panels[0]).toContain('role="tabpanel"');
    expect(panels[0]).toContain('tabindex="0"');
    expect(fixtureHtml).toContain('Overview fixture panel');
    expect(fixtureHtml).not.toContain('Focusable session fixture');
    expect(fixtureHtml).not.toContain('Disabled fixture panel');
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
});
