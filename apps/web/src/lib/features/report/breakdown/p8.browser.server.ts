import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

const ACTION_TIMEOUT_MS = 5000;
const CHROME_LAUNCH_TIMEOUT_MS = 5000;
const fixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <link rel="icon" href="data:,">
    <link rel="stylesheet" href="/packages/design-system/styled-system/styles.css">
    <title>P8 breakdown and actions fixture</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/p8-browser-entry.ts"></script>
  </body>
</html>`;
const fixtureEntry = [
  "import { mount } from 'svelte';",
  "import Fixture from '/apps/web/src/lib/features/report/breakdown/p8.browser.fixture.svelte';",
  "mount(Fixture, { target: document.querySelector('#app') });",
  'window.__p8BrowserReady = true;',
].join('\n');
const virtualEntryId = '\0p8-browser-entry';
const repositoryDirectory = fileURLToPath(new URL('../../../../../../../', import.meta.url));

const fail = (message: string): never => {
  throw new Error(`P8 browser fixture: ${message}`);
};
const assertEqual = <Value>(actual: Value, expected: Value, label: string): void => {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
};
const assertFocused = async (locator: Locator, label: string): Promise<void> => {
  const focused = await locator.evaluate(async (element) => {
    const MAX_FOCUS_FRAMES = 10;
    for (let frame = 0; frame < MAX_FOCUS_FRAMES; frame += 1) {
      if (element === document.activeElement) {
        return true;
      }
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    }
    return element === document.activeElement;
  });
  assertEqual(focused, true, label);
};
const assertNoA11yViolations = async (page: Page, label: string): Promise<void> => {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.map(({ id, nodes }) => ({
    id,
    targets: nodes.flatMap(({ target }) => target),
  }));
  assertEqual(violations.length, 0, `${label}: ${JSON.stringify(violations)}`);
};
const fixtureServer = async (): Promise<ViteDevServer> =>
  await createServer({
    appType: 'custom',
    configFile: false,
    optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
    plugins: [
      {
        configureServer(viteServer) {
          viteServer.middlewares.use(async (request, response, next) => {
            if (request.url !== '/p8-browser') {
              next();
              return;
            }
            try {
              const html = await viteServer.transformIndexHtml(request.url, fixtureHtml);
              response.setHeader('content-type', 'text/html; charset=utf-8');
              response.end(html);
            } catch (error) {
              next(error instanceof Error ? error : new Error('Unable to render the P8 fixture'));
            }
          });
        },
        load(id) {
          return id === virtualEntryId ? fixtureEntry : undefined;
        },
        name: 'p8-browser-fixture',
        resolveId(id) {
          return id === '/p8-browser-entry.ts' ? virtualEntryId : undefined;
        },
      },
      svelte(),
    ],
    resolve: { dedupe: ['svelte'] },
    root: repositoryDirectory,
    server: { host: '127.0.0.1', hmr: false, port: 0, strictPort: false, ws: false },
  });

type CleanupTask = () => Promise<unknown>;
const cleanup = async (tasks: readonly CleanupTask[]): Promise<unknown[]> => {
  const errors: unknown[] = [];
  for (const task of tasks) {
    const [result] = await Promise.allSettled([task()]);
    if (result.status === 'rejected') {
      errors.push(result.reason);
    }
  }
  return errors;
};

let browser: Browser | undefined;
const browserErrors: string[] = [];
let context: BrowserContext | undefined;
let page: Page | undefined;
let proofError: unknown;
let server: ViteDevServer | undefined;
let systemChrome = '';
let systemChromeVersion = '';

try {
  server = await fixtureServer();
  await server.listen();
  const address = server.httpServer?.address();
  const fixturePort = typeof address === 'object' && address !== null ? address.port : undefined;
  if (fixturePort === undefined) {
    fail('Vite did not expose an ephemeral TCP port');
  }
  systemChrome = Bun.which('google-chrome') ?? '';
  if (systemChrome.length === 0) {
    fail('google-chrome is required; bundled Playwright browsers are not accepted evidence');
  }
  browser = await chromium.launch({
    executablePath: systemChrome,
    headless: true,
    timeout: CHROME_LAUNCH_TIMEOUT_MS,
  });
  systemChromeVersion = browser.version();
  context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  page = await context.newPage();
  page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('requestfailed', (request) =>
    browserErrors.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`),
  );

  await page.goto(`http://127.0.0.1:${fixturePort}/p8-browser`);
  try {
    await page.waitForFunction('window.__p8BrowserReady === true');
  } catch {
    fail(
      `fixture did not mount; browser errors=${JSON.stringify(browserErrors)}; body=${JSON.stringify(await page.locator('body').innerText())}`,
    );
  }
  assertEqual(browserErrors.length, 0, 'browser errors after mount');
  const fixture = page.locator('main[data-quota-requests]');
  await assertNoA11yViolations(page, 'initial rendered surface has no automatic accessibility violations');

  const filters = page.getByTestId('filters');
  assertEqual(await fixture.getAttribute('data-search-machine'), 'raw-machine-id', 'raw machine identity is retained');
  assertEqual(await filters.getByText('Machine: Laptop ×').count(), 1, 'machine label is presentation-only');
  const query = filters.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await query.focus();
  await query.press('End');
  await query.pressSequentially('xy');
  assertEqual(
    await fixture.getAttribute('data-navigation-mode'),
    'replace',
    'query edit run replaces after first input',
  );
  await query.press('Enter');
  await filters.getByRole('button', { name: 'Filter by origin' }).click();
  const originPopover = page.locator('[data-scope="popover"][data-part="content"]');
  await originPopover.waitFor({ state: 'visible' });
  const originCheckbox = originPopover.getByRole('checkbox').first();
  await originCheckbox.focus();
  await originCheckbox.press('Space');
  assertEqual(
    await fixture.getAttribute('data-search-origin'),
    '',
    'unchecking the sole selected Origin Checkbox updates URL state to the canonical All value',
  );
  await originPopover.getByRole('button', { name: 'Default' }).click();
  await originPopover.getByRole('button', { name: 'All' }).click();
  await page.keyboard.press('Escape');
  await originPopover.waitFor({ state: 'hidden' });
  await filters.getByTitle('Clear Machine filter').click();
  assertEqual(await fixture.getAttribute('data-search-machine'), '', 'active machine pill clears raw identity');
  await filters.getByRole('button', { name: 'Clear all' }).click();

  const breakdown = page.getByTestId('breakdown');
  assertEqual(await breakdown.getByRole('tab').count(), 4, 'four controlled breakdown tabs render');
  assertEqual(await breakdown.locator('[data-price-state="measured"]').count(), 1, 'measured value row renders');
  assertEqual(
    await breakdown.locator('[data-price-state="partially measured"]').count(),
    1,
    'partial value row renders',
  );
  assertEqual(await breakdown.locator('[data-price-state="unavailable"]').count(), 1, 'unavailable value row renders');
  assertEqual(await breakdown.locator('[data-price-state="zero"]').count(), 1, 'zero value row renders');
  await breakdown.getByRole('radio', { name: 'Tokens' }).click();
  await breakdown.getByRole('tab', { name: 'Harnesses & providers' }).click();
  const expandHarness = breakdown.getByRole('button', { name: 'Expand providers for codex' });
  await expandHarness.click();
  assertEqual(
    await breakdown.getByRole('button', { name: 'Collapse providers for codex' }).getAttribute('aria-expanded'),
    'true',
    'harness disclosure is controlled',
  );
  const hierarchySearch = breakdown.getByRole('searchbox', { name: 'Search this breakdown' });
  await hierarchySearch.fill('openai');
  assertEqual(
    await breakdown.getByRole('group', { name: 'Providers for codex' }).count(),
    1,
    'child search expands hierarchy',
  );
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    breakdown.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  const downloadPath = (await download.path()) ?? fail('visible breakdown download has no path');
  const downloadedBreakdown = await Bun.file(downloadPath).text();
  assertEqual(downloadedBreakdown.includes('openai'), true, 'visible sorted hierarchy row is exported');
  assertEqual(downloadedBreakdown.includes('claude'), false, 'hidden hierarchy row is excluded from CSV');

  await breakdown.getByRole('tab', { name: 'Projects' }).click();
  assertEqual(await breakdown.getByRole('table').count(), 1, 'desktop project table renders');
  const qualityAction = breakdown.getByRole('button', { name: 'No detected project' });
  await qualityAction.click();
  const managementSummary = breakdown.getByText('Manage project groups', { exact: true });
  await assertFocused(managementSummary, 'quality action focuses existing project management summary');
  const projectName = breakdown.getByRole('textbox', { name: 'Name for Existing group' });
  await projectName.fill('Renamed group');
  await breakdown.getByRole('button', { name: 'Rename' }).click();
  await breakdown.getByText('Synthetic project save failed').waitFor();
  await breakdown.getByRole('button', { name: 'Rename' }).click();
  await breakdown.getByText('Renamed Existing group').waitFor();
  assertEqual(await fixture.getAttribute('data-project-save-state'), 'saved', 'project save recovers after an error');
  await page.setViewportSize({ height: 800, width: 390 });
  await breakdown.getByRole('list', { name: 'Project summaries' }).waitFor({ state: 'visible' });
  assertEqual(
    await breakdown.getByRole('list', { name: 'Project summaries' }).count(),
    1,
    'mobile project cards render',
  );
  await page.setViewportSize({ height: 900, width: 1280 });
  await breakdown.getByRole('tab', { name: 'Cursor AI' }).click();
  await breakdown.getByText('No Cursor commit attribution data in this payload').waitFor();

  const campaign = page.getByTestId('campaign');
  const campaignInput = campaign.getByRole('textbox', { name: 'Campaign label' });
  await campaignInput.fill('Renamed campaign');
  await campaign.getByRole('button', { name: 'Rename' }).click();
  assertEqual(await campaignInput.inputValue(), 'Renamed campaign', 'campaign rename updates effective label');
  await campaign.getByRole('button', { name: 'Reset' }).click();
  assertEqual(await campaignInput.inputValue(), 'Campaign A', 'campaign reset restores canonical label');

  const sharingSuccess = page.getByTestId('sharing-success');
  await sharingSuccess.getByRole('button', { name: 'Copy link' }).click();
  await sharingSuccess.getByRole('status').waitFor();
  assertEqual(
    await fixture.getAttribute('data-copied-url'),
    'https://example.test/report?tab=models&provider=openai',
    'sharing copies exact URL',
  );
  await sharingSuccess.getByRole('button', { name: 'Export CSV' }).click();
  assertEqual(
    await fixture.getAttribute('data-downloaded-csv'),
    'label,value\nvisible,1\n',
    'sharing downloads visible CSV',
  );
  const sharingFailure = page.getByTestId('sharing-failure');
  await sharingFailure.getByRole('button', { name: 'Copy link' }).click();
  await sharingFailure.getByRole('alert').waitFor();
  assertEqual(await sharingFailure.getByRole('button', { name: 'Export CSV' }).isEnabled(), true, 'CSV stays enabled');
  await sharingFailure.getByRole('button', { name: 'Export CSV' }).click();
  assertEqual(await sharingFailure.getByRole('alert').innerText(), 'Could not export CSV', 'CSV failure is announced');
  assertEqual(await sharingFailure.getByRole('button', { name: 'Copy link' }).isEnabled(), true, 'copy stays enabled');

  const quotaControls = page.getByTestId('quota-controls');
  const demoTrigger = quotaControls.getByRole('button', { name: 'Open demo quota history' });
  await demoTrigger.click();
  const quotaDialog = page.getByRole('dialog', { name: 'Codex quota history' });
  await quotaDialog.waitFor({ state: 'visible' });
  const closeQuota = quotaDialog.getByRole('button', { name: 'Close Codex quota history' });
  await assertFocused(closeQuota, 'quota drawer applies initial focus');
  assertEqual(await fixture.getAttribute('data-quota-requests'), '0', 'demo/open performs no request');
  await closeQuota.click();
  await quotaDialog.waitFor({ state: 'hidden' });
  await assertFocused(demoTrigger, 'first controlled close restores its opener');

  await quotaControls.getByRole('button', { name: 'Use live quota mode' }).click();
  const liveTrigger = quotaControls.getByRole('button', { name: 'Open live quota history' });
  await liveTrigger.click();
  await quotaDialog.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.querySelector('main[data-quota-requests]')?.getAttribute('data-quota-requests') === '1',
  );
  await assertFocused(closeQuota, 'live quota open applies initial focus');
  await quotaDialog.getByRole('button', { name: '7d' }).click();
  await page.waitForFunction(
    () => document.querySelector('main[data-quota-requests]')?.getAttribute('data-quota-requests') === '2',
  );
  await quotaDialog.getByLabel('Provider').selectOption('codex');
  await quotaDialog.getByRole('button', { name: 'Reset filters' }).click();
  assertEqual(await quotaDialog.getByLabel('Provider').inputValue(), '', 'quota filters reset');
  assertEqual((await quotaDialog.getByText(/largest gap/).count()) > 0, true, 'quota gap evidence renders');
  assertEqual((await quotaDialog.getByRole('table').count()) > 0, true, 'accessible quota observation table renders');
  await assertNoA11yViolations(page, 'open quota drawer has no automatic accessibility violations');
  await page.keyboard.press('Escape');
  await quotaDialog.waitFor({ state: 'hidden' });
  await assertFocused(liveTrigger, 'Escape restores the live opener');

  await demoTrigger.click();
  await quotaDialog.waitFor({ state: 'visible' });
  await closeQuota.click();
  await quotaDialog.waitFor({ state: 'hidden' });
  await assertFocused(demoTrigger, 'a later false-to-true transition captures its new opener');
  assertEqual(browserErrors.length, 0, 'browser errors after interactions');
} catch (error) {
  proofError = error;
}

const cleanupTasks: CleanupTask[] = [];
if (page !== undefined) {
  cleanupTasks.push(() => page?.close() ?? Promise.resolve());
}
if (context !== undefined) {
  cleanupTasks.push(() => context?.close() ?? Promise.resolve());
}
if (browser !== undefined) {
  cleanupTasks.push(() => browser?.close() ?? Promise.resolve());
}
if (server !== undefined) {
  cleanupTasks.push(() => server?.close() ?? Promise.resolve());
}
const cleanupErrors = await cleanup(cleanupTasks);
if (proofError !== undefined || cleanupErrors.length > 0) {
  throw new AggregateError(
    proofError === undefined ? cleanupErrors : [proofError, ...cleanupErrors],
    'P8 browser proof or cleanup failed',
  );
}

console.log(
  `P8 browser fixture passed using ${systemChrome} (${systemChromeVersion}): filters/origin/active pills; controlled tabs/value/hierarchy/CSV; responsive projects/mutations; campaign/sharing announcements; quota on-demand/range/reset/table/focus; axe/cleanup.`,
);
