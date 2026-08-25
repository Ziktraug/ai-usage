import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { type Browser, chromium, type Locator, type Page } from 'playwright';
import { type BrowserFixtureServer, startBrowserFixtureServer } from '../browser-fixture-server';

const ACTION_TIMEOUT_MS = 5000;
const DEFAULT_TOOLTIP_CLOSED_DELAY_MS = 150;
const CHROME_LAUNCH_TIMEOUT_MS = 5000;

const fixtureHtml = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8">',
  '    <link rel="icon" href="data:,">',
  '    <link rel="stylesheet" href="/packages/design-system/styled-system/styles.css">',
  '    <title>D2 overlays fixture</title>',
  '  </head>',
  '  <body>',
  '    <main id="app"></main>',
  '    <script type="module" src="/d2-overlays-entry.ts"></script>',
  '  </body>',
  '</html>',
].join('\n');

const fixtureEntry = [
  "import { mount } from 'svelte';",
  "import Fixture from '/packages/design-system/src/svelte/overlays/overlay-fixture.svelte';",
  "mount(Fixture, { target: document.querySelector('#app') });",
  'window.__d2OverlaysReady = true;',
].join('\n');
const virtualEntryId = '\0d2-overlays-entry';
const repositoryDirectory = fileURLToPath(new URL('../../../../../', import.meta.url));

const fail = (message: string): never => {
  throw new Error(`D2 browser fixture: ${message}`);
};

const assertEqual = <Value>(actual: Value, expected: Value, label: string): void => {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
};

const assertCount = async (locator: Locator, expected: number, label: string): Promise<void> => {
  assertEqual(await locator.count(), expected, label);
};

const assertHidden = async (locator: Locator, label: string): Promise<void> => {
  try {
    await locator.waitFor({ state: 'hidden' });
  } catch {
    fail(label);
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

const assertContainsFocus = async (locator: Locator, label: string): Promise<void> => {
  assertEqual(await locator.evaluate((element) => element.contains(document.activeElement)), true, label);
};

const assertPortalled = async (content: Locator, label: string): Promise<void> => {
  assertEqual(await content.evaluate((element) => element.parentElement?.parentElement === document.body), true, label);
};

const assertReducedMotion = async (content: Locator, label: string): Promise<void> => {
  assertEqual(await content.evaluate((element) => getComputedStyle(element).animationName), 'none', label);
};

const fixtureServer = (): Promise<BrowserFixtureServer> =>
  startBrowserFixtureServer({
    appType: 'custom',
    configFile: false,
    optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
    plugins: [
      {
        configureServer(viteServer) {
          viteServer.middlewares.use(async (request, response, next) => {
            if (request.url !== '/d2-overlays') {
              next();
              return;
            }
            try {
              const html = await viteServer.transformIndexHtml(request.url, fixtureHtml);
              response.setHeader('content-type', 'text/html; charset=utf-8');
              response.end(html);
            } catch (error) {
              next(error instanceof Error ? error : new Error('Unable to render the D2 fixture'));
            }
          });
        },
        load(id) {
          return id === virtualEntryId ? fixtureEntry : undefined;
        },
        name: 'd2-overlays-fixture',
        resolveId(id) {
          return id === '/d2-overlays-entry.ts' ? virtualEntryId : undefined;
        },
      },
      svelte(),
    ],
    resolve: { dedupe: ['svelte'] },
    root: repositoryDirectory,
  });

type CleanupTask = () => Promise<unknown>;

const runCleanupTasks = async (tasks: readonly CleanupTask[]): Promise<unknown[]> => {
  const cleanupErrors: unknown[] = [];
  for (const task of tasks) {
    const [result] = await Promise.allSettled([task()]);
    if (result.status === 'rejected') {
      cleanupErrors.push(result.reason);
    }
  }
  return cleanupErrors;
};

let browser: Browser | undefined;
const browserErrors: string[] = [];
let page: Page | undefined;
let proofError: unknown;
let server: BrowserFixtureServer | undefined;
let systemChrome = '';
let systemChromeVersion = '';

try {
  server = await fixtureServer();
  const fixturePort = server.port;

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
  page = await browser.newPage();
  await page.setViewportSize({ height: 844, width: 390 });
  page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.text().includes('derived_inert')) {
      browserErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('requestfailed', (request) =>
    browserErrors.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`),
  );

  await page.goto(`http://127.0.0.1:${fixturePort}/d2-overlays`);
  try {
    await page.waitForFunction('window.__d2OverlaysReady === true');
  } catch {
    const body = await page.locator('body').innerText();
    fail(`fixture did not mount; browser errors=${JSON.stringify(browserErrors)}; body=${JSON.stringify(body)}`);
  }
  assertEqual(browserErrors.length, 0, 'browser console, page, and request errors after mount');

  const outsideTarget = page.locator('main button').filter({ hasText: 'Outside overlay target' });
  const drawerTrigger = page.getByRole('button', { name: 'Open drawer', exact: true });
  const drawerSelector = '[data-scope="drawer"][data-part="content"][data-state="open"]';
  await assertCount(page.locator(drawerSelector), 0, 'Drawer starts closed');
  await drawerTrigger.click();
  const drawer = page.getByRole('dialog', { name: 'Fixture drawer' });
  await drawer.waitFor({ state: 'visible' });
  await assertPortalled(drawer, 'Drawer content is portalled under body');
  await assertReducedMotion(drawer, 'Drawer disables animation for reduced motion');
  assertEqual(await drawer.getAttribute('aria-modal'), 'true', 'mobile Drawer is modal');
  const drawerBackdrop = page.locator('[data-scope="drawer"][data-part="backdrop"][data-state="open"]');
  await assertCount(drawerBackdrop, 1, 'mobile Drawer mounts one backdrop');
  assertEqual(
    Number(await drawer.evaluate((element) => getComputedStyle(element).zIndex)) > 50,
    true,
    'mobile Drawer is above application navigation',
  );
  assertEqual(
    Number(await drawerBackdrop.evaluate((element) => getComputedStyle(element).zIndex)) > 50,
    true,
    'mobile Drawer backdrop is above application navigation',
  );
  await assertFocused(drawer.getByRole('button', { name: 'Close drawer' }), 'Drawer applies initial focus');
  await page.keyboard.press('Tab');
  await assertFocused(drawer.getByRole('button', { name: 'Close drawer' }), 'mobile Drawer wraps Tab');
  await page.keyboard.press('Shift+Tab');
  await assertFocused(drawer.getByRole('button', { name: 'Close drawer' }), 'mobile Drawer wraps Shift+Tab');
  await outsideTarget.evaluate((element) => (element as HTMLElement).focus());
  await assertContainsFocus(drawer, 'modal Drawer trap prevents background focus leakage');
  await page.keyboard.press('Escape');
  await assertHidden(drawer, 'Drawer did not close on Escape');
  await assertFocused(drawerTrigger, 'Drawer Escape returns focus to its trigger');

  await drawerTrigger.click();
  await drawer.waitFor({ state: 'visible' });
  const drawerBox = (await drawer.boundingBox()) ?? fail('Drawer did not expose responsive geometry');
  assertEqual(Math.round(drawerBox.width), 390, 'mobile Drawer spans the viewport');
  await drawerBackdrop.click({ position: { x: 195, y: Math.max(1, drawerBox.y / 2) } });
  await assertHidden(drawer, 'Drawer did not close on outside interaction');
  await page
    .locator('[data-scope="drawer"][data-part="content"][data-state="closed"]')
    .first()
    .waitFor({ state: 'attached' });
  await assertFocused(drawerTrigger, 'Drawer outside dismissal returns focus to its trigger');

  await page.setViewportSize({ height: 900, width: 1024 });
  await page.locator('[data-mobile-drawer="false"]').waitFor();
  await drawerTrigger.click();
  await page.locator('[data-drawer-open="true"]').waitFor();
  try {
    await drawer.waitFor({ state: 'visible' });
  } catch {
    const drawerStates = await page.locator('[data-scope="drawer"]').evaluateAll((elements) =>
      elements.map((element) => ({
        ariaModal: element.getAttribute('aria-modal'),
        display: getComputedStyle(element).display,
        part: element.getAttribute('data-part'),
        state: element.getAttribute('data-state'),
        visibility: getComputedStyle(element).visibility,
      })),
    );
    const fixtureState = await page.getByRole('region', { name: 'Overlay component fixture' }).evaluate((element) => ({
      drawerOpen: element.getAttribute('data-drawer-open'),
      mobileDrawer: element.getAttribute('data-mobile-drawer'),
    }));
    fail(
      `desktop Drawer did not become visible; fixture=${JSON.stringify(fixtureState)}; states=${JSON.stringify(drawerStates)}`,
    );
  }
  assertEqual(await drawer.getAttribute('aria-modal'), 'false', 'desktop Drawer is non-modal');
  await assertCount(drawerBackdrop, 0, 'desktop Drawer omits the backdrop');
  await assertFocused(drawerTrigger, 'desktop Drawer preserves its outside trigger focus');
  const desktopDrawerBox = (await drawer.boundingBox()) ?? fail('desktop Drawer did not expose responsive geometry');
  assertEqual(Math.round(desktopDrawerBox.width), 440, 'desktop Drawer uses its bounded width');
  await outsideTarget.focus();
  await assertFocused(outsideTarget, 'desktop non-modal Drawer permits outside focus');
  await drawer.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await assertHidden(drawer, 'desktop Drawer did not close on Escape');
  await assertFocused(drawerTrigger, 'desktop Drawer Escape returns focus to its trigger');

  const persistentDrawerTrigger = page.getByRole('button', { name: 'Open persistent drawer' });
  await persistentDrawerTrigger.click();
  const persistentDrawer = page.getByRole('dialog', { name: 'Persistent fixture drawer' });
  await persistentDrawer.waitFor({ state: 'visible' });
  await outsideTarget.click();
  await persistentDrawer.waitFor({ state: 'visible' });
  await assertFocused(outsideTarget, 'non-modal Drawer allows deliberate background focus');
  await persistentDrawer.getByRole('button', { name: 'Close persistent drawer' }).focus();
  await page.keyboard.press('Escape');
  await persistentDrawer.waitFor({ state: 'hidden' });

  const popoverSelector = '[data-scope="popover"][data-part="content"]';
  const popoverTrigger = page.getByRole('button', { name: 'Open fixture popover' });
  await assertCount(page.locator(popoverSelector), 0, 'Popover is lazy before opening');
  await popoverTrigger.click();
  const popover = page.locator(popoverSelector);
  await popover.waitFor({ state: 'visible' });
  assertEqual(await popover.getAttribute('aria-label'), 'Fixture popover actions', 'Popover names its dialog content');
  await assertPortalled(popover, 'Popover content is portalled under body');
  await assertReducedMotion(popover, 'Popover disables animation for reduced motion');
  assertEqual(
    await popover.locator('xpath=..').evaluate((element) => getComputedStyle(element).zIndex),
    '70',
    'Popover occupies the documented layer above Drawer',
  );
  await assertFocused(
    popover.getByRole('button', { name: 'Popover fixture action' }),
    'Popover moves focus into its content',
  );
  await page.keyboard.press('Tab');
  await assertFocused(
    popover.getByRole('button', { name: 'Popover fixture secondary action' }),
    'Popover advances focus with Tab',
  );
  await page.keyboard.press('Shift+Tab');
  await assertFocused(
    popover.getByRole('button', { name: 'Popover fixture action' }),
    'Popover reverses focus with Shift+Tab',
  );
  await page.keyboard.press('Escape');
  await assertHidden(popover, 'Popover did not hide after Escape');
  await assertCount(page.locator(popoverSelector), 0, 'Popover unmounts after Escape');
  await assertFocused(popoverTrigger, 'Popover Escape returns focus to its trigger');

  await popoverTrigger.click();
  await popover.waitFor({ state: 'visible' });
  await outsideTarget.click();
  await assertHidden(popover, 'Popover did not close after outside interaction');
  await assertCount(page.locator(popoverSelector), 0, 'Popover unmounts after outside interaction');
  await assertFocused(outsideTarget, 'Popover outside dismissal preserves outside focus');

  const tooltipSelector = '[data-scope="tooltip"][data-part="content"]';
  const tooltipTarget = page.getByRole('button', { name: 'Tooltip target' });
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip is lazy before interaction');
  await tooltipTarget.hover();
  await page.waitForTimeout(DEFAULT_TOOLTIP_CLOSED_DELAY_MS);
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip honors its 300ms default open delay');
  const tooltip = page.getByRole('tooltip').filter({ hasText: 'Tooltip fixture content' });
  await tooltip.waitFor({ state: 'visible' });
  await assertPortalled(tooltip, 'Tooltip content is portalled under body');
  await assertReducedMotion(tooltip, 'Tooltip disables animation for reduced motion');
  assertEqual(
    await tooltip.evaluate((element) => getComputedStyle(element).zIndex),
    '70',
    'Tooltip occupies the documented layer above Drawer',
  );
  const tooltipId = await tooltip.getAttribute('id');
  assertEqual(
    await tooltipTarget.getAttribute('aria-describedby'),
    tooltipId,
    'Tooltip trigger is associated with its content',
  );
  await page.keyboard.press('Escape');
  await assertHidden(tooltip, 'Tooltip did not hide after Escape');
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip unmounts after Escape');

  await tooltipTarget.focus();
  await tooltip.waitFor({ state: 'visible' });
  await outsideTarget.focus();
  await assertHidden(tooltip, 'Tooltip did not hide after focus left its trigger');
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip unmounts after focus leaves its trigger');

  const provenanceTitle = 'Partial data: The provider omitted part of this interval.';
  const provenanceMarker = page.getByRole('button', { name: provenanceTitle });
  await assertCount(provenanceMarker, 1, 'provenance marker exposes a keyboard-accessible trigger');
  await provenanceMarker.hover();
  const provenanceTooltip = page.getByRole('tooltip').filter({ hasText: provenanceTitle });
  await provenanceTooltip.waitFor({ state: 'visible' });
  assertEqual(
    await provenanceMarker.getAttribute('aria-describedby'),
    await provenanceTooltip.getAttribute('id'),
    'provenance marker is associated with its explanatory tooltip',
  );
  await page.keyboard.press('Escape');

  await assertCount(page.locator(popoverSelector), 0, 'Popover has no retained lazy content');
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip has no retained lazy content');
  await assertCount(page.locator(drawerSelector), 0, 'Drawers have no open content at cleanup');
  assertEqual(browserErrors.length, 0, 'browser console, page, and request errors after interactions');
} catch (error) {
  proofError = error;
}

const cleanupTasks: CleanupTask[] = [];
if (page !== undefined) {
  cleanupTasks.push(() => page?.close() ?? Promise.resolve());
}
if (browser !== undefined) {
  cleanupTasks.push(() => browser?.close() ?? Promise.resolve());
}
if (server !== undefined) {
  cleanupTasks.push(() => server?.close() ?? Promise.resolve());
}
const cleanupErrors = await runCleanupTasks(cleanupTasks);

if (proofError !== undefined || cleanupErrors.length > 0) {
  throw new AggregateError(
    proofError === undefined ? cleanupErrors : [proofError, ...cleanupErrors],
    'D2 browser proof or cleanup failed',
  );
}

console.log(
  'D2 browser fixture passed using ' +
    systemChrome +
    ' (' +
    systemChromeVersion +
    '): Drawer/Popover/Tooltip focus, Tab, Shift+Tab, Escape, outside, lazy, portal, reduced-motion, provenance, and cleanup parity.',
);
