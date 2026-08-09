import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { type Browser, chromium, type Locator, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

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

const fixtureServer = async (): Promise<ViteDevServer> =>
  createServer({
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
    server: { host: '127.0.0.1', hmr: false, port: 0, strictPort: true, ws: false },
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
  page = await browser.newPage();
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
  await assertFocused(drawer.getByRole('button', { name: 'Close drawer' }), 'Drawer applies initial focus');
  await outsideTarget.evaluate((element) => (element as HTMLElement).focus());
  await assertContainsFocus(drawer, 'modal Drawer trap prevents background focus leakage');
  await page.keyboard.press('Escape');
  await assertHidden(drawer, 'Drawer did not close on Escape');
  await assertFocused(drawerTrigger, 'Drawer Escape returns focus to its trigger');

  await drawerTrigger.click();
  await drawer.waitFor({ state: 'visible' });
  const drawerBox = (await drawer.boundingBox()) ?? fail('Drawer did not expose responsive geometry');
  assertEqual(drawerBox.width <= 440, true, 'Drawer uses its bounded desktop width');
  const drawerBackdrop = page.locator('[data-scope="drawer"][data-part="backdrop"][data-state="open"]');
  await drawerBackdrop.click({ position: { x: Math.max(1, drawerBox.x / 2), y: Math.max(1, drawerBox.y + 8) } });
  await assertHidden(drawer, 'Drawer did not close on outside interaction');
  await assertFocused(drawerTrigger, 'Drawer outside dismissal returns focus to its trigger');

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

  const popoverSelector = 'div[popover="auto"]';
  const popoverTrigger = page.getByRole('button', { name: 'Open fixture popover' });
  await assertEqual(
    await page
      .locator(popoverSelector)
      .first()
      .evaluate((element) => getComputedStyle(element).display),
    'none',
    'Popover is hidden before opening',
  );
  await assertCount(page.locator(`${popoverSelector} > *`), 0, 'Popover retains only its empty native container');
  await popoverTrigger.click();
  const popover = page.locator(popoverSelector);
  await popover.waitFor({ state: 'visible' });
  await assertReducedMotion(popover, 'Popover disables animation for reduced motion');
  await assertFocused(
    popover.getByRole('button', { name: 'Popover fixture action' }),
    'Popover moves focus into its content',
  );

  const popoverTopLayer = await popover.evaluate((element) => element.matches(':popover-open'));
  assertEqual(popoverTopLayer, true, 'Popover is promoted to the top layer when open');

  const popoverGeometry = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
    };
  });
  const triggerGeometry = await popoverTrigger.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      centerX: rect.left + rect.width / 2,
      height: rect.height,
      width: rect.width,
    };
  });
  const popoverCenterX = popoverGeometry.left + popoverGeometry.width / 2;
  assertEqual(
    Math.abs(popoverCenterX - triggerGeometry.centerX) <= 1,
    true,
    'Popover center is horizontally aligned with the trigger center',
  );
  assertEqual(
    Math.abs(popoverGeometry.top - (triggerGeometry.bottom + 4)) <= 1,
    true,
    'Popover top is 4px below the trigger bottom (gutter respected)',
  );
  assertEqual(
    popoverGeometry.left >= 4 && popoverGeometry.right <= (await page.evaluate(() => window.innerWidth)) - 4,
    true,
    'Popover stays inside the viewport with at least 4px of edge padding',
  );

  const popoverSizeToggle = popover.getByRole('button', { name: 'Toggle popover size' });
  await popoverSizeToggle.click();
  await popover.evaluate(async (element) => {
    const MAX_OBSERVER_FRAMES = 10;
    for (let frame = 0; frame < MAX_OBSERVER_FRAMES; frame += 1) {
      if (element.scrollHeight > element.clientHeight) {
        return;
      }
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    }
  });
  const expandedPopoverGeometry = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      top: rect.top,
    };
  });
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  assertEqual(expandedPopoverGeometry.top >= 4, true, 'Tall Popover keeps its top inside the viewport');
  assertEqual(
    expandedPopoverGeometry.bottom <= viewportHeight - 4,
    true,
    'Tall Popover keeps its bottom inside the viewport',
  );
  assertEqual(expandedPopoverGeometry.overflowY, 'auto', 'Tall Popover exposes scrollable overflow');
  assertEqual(
    expandedPopoverGeometry.scrollHeight > expandedPopoverGeometry.clientHeight,
    true,
    'Tall Popover content remains reachable by scrolling',
  );

  await popoverSizeToggle.click();
  await popover.evaluate(async (element) => {
    const trigger = document.querySelector<HTMLElement>(`[aria-controls="${element.id}"]`);
    const MAX_OBSERVER_FRAMES = 10;
    for (let frame = 0; frame < MAX_OBSERVER_FRAMES; frame += 1) {
      if (
        trigger &&
        element.scrollHeight <= element.clientHeight &&
        Math.abs(element.getBoundingClientRect().top - (trigger.getBoundingClientRect().bottom + 4)) <= 1
      ) {
        return;
      }
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    }
  });
  const compactPopoverTop = await popover.evaluate((element) => element.getBoundingClientRect().top);
  assertEqual(
    Math.abs(compactPopoverTop - (triggerGeometry.bottom + 4)) <= 1,
    true,
    'Popover repositions after content shrinks without a viewport event',
  );

  await popoverTrigger.evaluate((element) => {
    element.style.transform = 'translateX(16px)';
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(50);
  const resizedGeometry = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { centerX: rect.left + rect.width / 2, top: rect.top };
  });
  assertEqual(
    Math.abs(resizedGeometry.centerX - (triggerGeometry.centerX + 16)) <= 1,
    true,
    'Popover repositions to track changed trigger geometry after a resize event',
  );
  await popoverTrigger.evaluate((element) => {
    element.style.transform = '';
    window.dispatchEvent(new Event('resize'));
  });

  await page.evaluate(() => window.scrollBy(0, 32));
  await popover.evaluate(async (element) => {
    const trigger = document.querySelector<HTMLElement>(`[aria-controls="${element.id}"]`);
    const MAX_SCROLL_FRAMES = 10;
    for (let frame = 0; frame < MAX_SCROLL_FRAMES; frame += 1) {
      if (
        trigger &&
        Math.abs(element.getBoundingClientRect().top - Math.max(4, trigger.getBoundingClientRect().bottom + 4)) <= 1
      ) {
        return;
      }
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    }
  });
  const postScrollGeometry = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { centerX: rect.left + rect.width / 2, top: rect.top };
  });
  const postScrollTriggerBottom = await popoverTrigger.evaluate((element) => element.getBoundingClientRect().bottom);
  assertEqual(
    Math.abs(postScrollGeometry.top - Math.max(4, postScrollTriggerBottom + 4)) <= 1,
    true,
    'Popover recomputes top placement in response to a capture-phase scroll event',
  );
  await page.evaluate(() => window.scrollBy(0, -32));

  await page.keyboard.press('Escape');
  await assertHidden(popover, 'Popover did not hide after Escape');
  await assertFocused(popoverTrigger, 'Popover Escape returns focus to its trigger');

  await popoverTrigger.click();
  await popover.waitFor({ state: 'visible' });
  await outsideTarget.click();
  await assertHidden(popover, 'Popover did not close after outside interaction');
  await assertFocused(outsideTarget, 'Popover outside dismissal preserves outside focus');

  const tooltipSelector = '[role="tooltip"]';
  const tooltipTarget = page.getByRole('button', { name: 'Tooltip target' });
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip is hidden before interaction');
  await tooltipTarget.hover();
  await page.waitForTimeout(DEFAULT_TOOLTIP_CLOSED_DELAY_MS);
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip honors its 300ms default open delay');
  const tooltip = page.locator(tooltipSelector).filter({ hasText: 'Tooltip fixture content' });
  await tooltip.first().waitFor({ state: 'attached' });
  await assertReducedMotion(tooltip, 'Tooltip disables animation for reduced motion');
  const tooltipId = await tooltip.getAttribute('id');
  assertEqual(
    await tooltipTarget.getAttribute('aria-describedby'),
    tooltipId,
    'Tooltip trigger button is associated with its content via aria-describedby',
  );
  const tooltipParentTag = await tooltip.evaluate((element) => element.parentElement?.tagName ?? null);
  assertEqual(tooltipParentTag, 'BODY', 'Tooltip content is portaled to document.body');
  const initialTooltipWidth = await tooltip.evaluate((element) => element.getBoundingClientRect().width);
  await tooltip.evaluate((element) => {
    const dynamicContent = document.createElement('span');
    dynamicContent.dataset.tooltipDynamicContent = 'true';
    dynamicContent.style.display = 'block';
    dynamicContent.style.width = '900px';
    dynamicContent.style.height = '300px';
    dynamicContent.textContent = 'Expanded tooltip content';
    element.appendChild(dynamicContent);
  });
  await tooltip.evaluate(async (element) => {
    const MAX_OBSERVER_FRAMES = 10;
    for (let frame = 0; frame < MAX_OBSERVER_FRAMES; frame += 1) {
      if (element.getBoundingClientRect().width > 800) {
        return;
      }
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    }
  });
  const expandedTooltipGeometry = await tooltip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top, width: rect.width };
  });
  const viewport = await page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth }));
  assertEqual(expandedTooltipGeometry.width > initialTooltipWidth, true, 'Tooltip observes dynamic content growth');
  assertEqual(
    expandedTooltipGeometry.left >= 4 && expandedTooltipGeometry.right <= viewport.width - 4,
    true,
    'Dynamically grown Tooltip remains horizontally viewport-safe',
  );
  assertEqual(
    expandedTooltipGeometry.top >= 4 && expandedTooltipGeometry.bottom <= viewport.height - 4,
    true,
    'Dynamically grown Tooltip remains vertically viewport-safe',
  );
  await tooltip.evaluate((element) => element.querySelector('[data-tooltip-dynamic-content]')?.remove());
  await tooltip.evaluate(async (element, initialWidth) => {
    const MAX_OBSERVER_FRAMES = 10;
    for (let frame = 0; frame < MAX_OBSERVER_FRAMES; frame += 1) {
      if (element.getBoundingClientRect().width <= initialWidth + 1) {
        return;
      }
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    }
  }, initialTooltipWidth);
  assertEqual(
    (await tooltip.evaluate((element) => element.getBoundingClientRect().width)) <= initialTooltipWidth + 1,
    true,
    'Tooltip observes dynamic content shrinkage',
  );
  await page.keyboard.press('Escape');
  await assertHidden(tooltip, 'Tooltip did not hide after Escape');
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip is hidden after Escape');

  await outsideTarget.hover();
  await tooltipTarget.focus();
  await tooltip.waitFor({ state: 'visible' });
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await assertHidden(tooltip, 'Tooltip closes on resize while open');
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip is removed from the DOM after a resize');

  await outsideTarget.focus();
  await tooltipTarget.focus();
  await tooltip.waitFor({ state: 'visible' });
  await page.evaluate(() => window.scrollBy(0, 16));
  await assertHidden(tooltip, 'Tooltip closes on capture-phase scroll while open');
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip is removed from the DOM after a scroll');
  await outsideTarget.focus();
  await tooltipTarget.focus();
  await tooltip.waitFor({ state: 'visible' });
  await outsideTarget.focus();
  await assertHidden(tooltip, 'Tooltip did not hide after focus left its trigger');
  await assertCount(page.locator(tooltipSelector), 0, 'Tooltip is hidden after focus leaves its trigger');

  const provenanceTitle = 'Partial data: The provider omitted part of this interval.';
  const provenanceMarker = page.getByRole('img', { name: provenanceTitle });
  await assertCount(provenanceMarker, 1, 'provenance marker exposes its accessible fallback');
  await provenanceMarker.hover();
  const provenanceTooltip = page.getByRole('tooltip').filter({ hasText: provenanceTitle });
  await provenanceTooltip.waitFor({ state: 'visible' });
  assertEqual(
    await provenanceMarker.getAttribute('aria-describedby'),
    await provenanceTooltip.getAttribute('id'),
    'provenance marker is associated with its explanatory tooltip',
  );
  await page.keyboard.press('Escape');

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
    '): Drawer/Popover/Tooltip focus, Escape, outside, lazy, portal, reduced-motion, provenance, and cleanup parity.',
);
