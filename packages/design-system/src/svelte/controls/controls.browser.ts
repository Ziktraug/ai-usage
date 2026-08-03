import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium, type Locator } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

const fixtureHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>D1 controls fixture</title></head>
  <body>
    <main id="app"></main>
    <script type="module" src="/d1-controls-entry.ts"></script>
  </body>
</html>`;

const fixtureEntry = `import { mount } from 'svelte';
import Fixture from '/packages/design-system/src/svelte/controls/controls.fixture.svelte';
mount(Fixture, { target: document.querySelector('#app') });
window.__d1ControlsReady = true;`;
const virtualEntryId = '\0d1-controls-entry';

const fail = (message: string): never => {
  throw new Error(`D1 browser fixture: ${message}`);
};

const assertEqual = <Value>(actual: Value, expected: Value, label: string): void => {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
};

const assertAttribute = async (locator: Locator, name: string, expected: string, label: string): Promise<void> => {
  assertEqual(await locator.getAttribute(name), expected, label);
};

const fixtureServer = async (): Promise<ViteDevServer> => {
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
    plugins: [
      {
        configureServer(viteServer) {
          viteServer.middlewares.use(async (request, response, next) => {
            if (request.url !== '/d1-controls') {
              next();
              return;
            }
            try {
              const html = await viteServer.transformIndexHtml(request.url, fixtureHtml);
              response.setHeader('content-type', 'text/html; charset=utf-8');
              response.end(html);
            } catch (error) {
              next(error instanceof Error ? error : new Error('Unable to render the D1 fixture'));
            }
          });
        },
        load(id) {
          return id === virtualEntryId ? fixtureEntry : undefined;
        },
        name: 'd1-controls-fixture',
        resolveId(id) {
          return id === '/d1-controls-entry.ts' ? virtualEntryId : undefined;
        },
      },
      svelte(),
    ],
    resolve: { dedupe: ['svelte'] },
    root: process.cwd(),
    server: { host: '127.0.0.1', hmr: false, port: 0, strictPort: true, ws: false },
  });
  await server.listen();
  return server;
};

const server = await fixtureServer();
const address = server.httpServer?.address();
const fixturePort = typeof address === 'object' && address !== null ? address.port : undefined;
if (fixturePort === undefined) {
  await server.close();
  fail('Vite did not expose an ephemeral TCP port');
}

const systemChromium = Bun.which('google-chrome') ?? Bun.which('chromium');
const browser = await chromium.launch(
  systemChromium === null ? { headless: true } : { executablePath: systemChromium, headless: true },
);
const page = await browser.newPage();
const browserErrors: string[] = [];
page.on('console', (message) => {
  if (message.type() === 'error') {
    browserErrors.push(message.text());
  }
});
page.on('pageerror', (error) => browserErrors.push(error.message));
page.on('requestfailed', (request) =>
  browserErrors.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`),
);

try {
  await page.goto(`http://127.0.0.1:${fixturePort}/d1-controls`);
  try {
    await page.waitForFunction('window.__d1ControlsReady === true', undefined, { timeout: 5000 });
  } catch {
    const body = await page.locator('body').innerText();
    fail(`fixture did not mount; browser errors=${JSON.stringify(browserErrors)}; body=${JSON.stringify(body)}`);
  }

  const toggleFixture = page.getByTestId('toggle-fixture');
  const toggle = page.getByRole('button', { name: 'Toggle synthetic feature' });
  const disabledToggle = page.getByRole('button', { name: 'Disabled synthetic feature' });
  await assertAttribute(toggle, 'aria-pressed', 'false', 'toggle starts controlled and unpressed');
  await toggle.click();
  await assertAttribute(toggle, 'aria-pressed', 'true', 'toggle click updates controlled state');
  await assertAttribute(toggleFixture, 'data-changes', '1', 'toggle click invokes pressed callback once');
  await assertAttribute(toggleFixture, 'data-order', 'click,pressed,', 'toggle click ordering');
  await toggle.press('Space');
  await assertAttribute(toggle, 'aria-pressed', 'false', 'Space updates controlled state');
  await assertAttribute(toggleFixture, 'data-changes', '2', 'Space invokes pressed callback once');
  await toggle.press('Enter');
  await assertAttribute(toggle, 'aria-pressed', 'true', 'Enter updates controlled state');
  await assertAttribute(toggleFixture, 'data-changes', '3', 'Enter invokes pressed callback once');
  await disabledToggle.click({ force: true });
  await disabledToggle.press('Space');
  await assertAttribute(disabledToggle, 'aria-pressed', 'false', 'disabled toggle remains unpressed');
  await assertAttribute(toggleFixture, 'data-changes', '3', 'disabled toggle emits no change');

  const badge = page.getByRole('button', { name: 'Filter by Claude Code' });
  const badgeState = page.getByTestId('badge-state');
  await badge.click();
  await assertAttribute(badge, 'aria-pressed', 'true', 'badge click updates pressed state');
  await assertAttribute(badgeState, 'data-changes', '1', 'badge click invokes callback once');
  await assertAttribute(badgeState, 'data-parent-clicks', '0', 'badge click stops parent propagation');
  await badge.press('Enter');
  await assertAttribute(badge, 'aria-pressed', 'false', 'badge Enter updates pressed state');
  await assertAttribute(badgeState, 'data-changes', '2', 'badge Enter invokes callback once');
  await assertAttribute(badgeState, 'data-parent-clicks', '0', 'badge keyboard activation stops propagation');
  assertEqual(
    await page.getByText('Unknown Agent', { exact: true }).evaluate((element) => element.tagName),
    'SPAN',
    'passive badge element',
  );

  const checkboxFixture = page.getByTestId('checkbox-fixture');
  const checkbox = page.getByRole('checkbox', { name: 'Synthetic checkbox' });
  assertEqual(await checkbox.isChecked(), true, 'checkbox starts controlled and checked');
  await checkbox.press('Space');
  assertEqual(await checkbox.isChecked(), false, 'checkbox Space updates controlled state');
  await assertAttribute(checkboxFixture, 'data-changes', '1', 'checkbox callback fires exactly once');

  const segmentFixture = page.getByTestId('segment-fixture');
  assertEqual(await segmentFixture.locator('[title="Alpha: 1"]').count(), 1, 'positive segment is rendered');
  assertEqual(await segmentFixture.locator('.segment-hidden').count(), 0, 'non-positive segment is omitted');
  assertEqual(
    await segmentFixture.getByRole('img', { name: 'Empty proportions' }).locator('div').count(),
    0,
    'empty segment bar has no parts',
  );

  const metricFixture = page.getByTestId('metric-fixture');
  assertEqual(await metricFixture.getByText('Down 2%').count(), 1, 'metric comparison is rendered');
  await assertAttribute(metricFixture.locator('span'), 'aria-hidden', 'true', 'metric arrow is hidden from AT');
} finally {
  await page.close();
  await browser.close();
  await server.close();
}

console.log(
  'D1 browser fixture passed: click/keyboard ordering, propagation, controlled state, semantics, and cleanup.',
);
