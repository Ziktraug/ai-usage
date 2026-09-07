import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  expect,
  test,
  waitForFocusedReportSettled,
  waitForHydratedNavigation,
  waitForHydratedReport,
  waitForHydratedSkills,
} from './browser-test';
import { createServerStateNetworkTrace } from './server-state-network';

const ANY_VALUE_PATTERN = /.+/;
const MANAGEMENT_DESTINATION_PATTERN = /Skills|Sources|Sync/;

const navigateAndWaitForRouteData = async (page: Page, link: Locator, pathname: string): Promise<void> => {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === pathname && response.request().resourceType() === 'fetch';
  });
  await link.click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
};

const activeDestinationFor = (path: string, heading: string): string => {
  if (path === '/') {
    return 'Overview';
  }
  return path.startsWith('/skills') ? 'Skills' : heading;
};

// Report acquisition is document-scoped, so a history restore reuses the data it already holds
// instead of refetching `/__data.json`. Wait on the restored report itself rather than on a network
// round trip that correctly no longer happens.
const restoreReportHistory = async (page: Page, expectedUrl: string): Promise<void> => {
  await page.goBack();
  await expect(page).toHaveURL(expectedUrl);
  await waitForFocusedReportSettled(page);
};

const shellRoutes = [
  { heading: 'Usage overview', marker: 'report', path: '/' },
  { heading: 'Skills', marker: null, path: '/skills' },
  { heading: 'Sources', marker: 'sources', path: '/sources' },
  { heading: 'Sync', marker: 'sync', path: '/sync' },
] as const;

/**
 * The two per-skill URLs open a drawer over the worktable (plan 113) rather than a page of their
 * own, so they are asserted for the payload they server-render, for hydration, and for the drawer
 * they open — the shell chrome itself is covered by the routes above.
 */
const drawerRoutes = ['/skills/global/alpha-skill', '/skills/projects/project%2Fopaque/skill-name'] as const;

test('server-renders and reloads every Svelte shell route with accessible navigation', async ({ page, request }) => {
  test.setTimeout(60_000);
  const browserSkillsRequests: string[] = [];
  page.on('request', (browserRequest) => {
    const pathname = new URL(browserRequest.url()).pathname;
    if (
      pathname.startsWith('/rpc/skills/') &&
      browserRequest.headers()['x-ai-usage-request-owner'] === 'skills-shell'
    ) {
      browserSkillsRequests.push(pathname);
    }
  });
  for (const route of shellRoutes) {
    const response = await request.get(route.path);
    expect(response.status()).toBe(200);
    expect(response.headers()['x-ai-usage-sveltekit']).toBe('active');
    const html = await response.text();
    if (route.marker === null) {
      expect(html).toContain('data-skills-workspace');
    } else {
      expect(html).toContain(`data-route-shell="${route.marker}"`);
    }
    expect(html).toContain(route.heading);
  }
  for (const path of drawerRoutes) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    const html = await response.text();
    // The worktable and its operation host are the server-rendered payload of a per-skill URL.
    expect(html).toContain('data-skills-workspace');
    expect(html).toContain('data-skills-worktable');
    expect(html).toContain('data-skills-management-health-slot');
    expect(html).toContain('Skills');
  }
  // The scope and matrix URLs became groups of the worktable (plan 113); their addresses still work.
  for (const retired of ['/skills/global', '/skills/matrix', '/skills/projects/project%2Fopaque']) {
    const fallback = await request.get(retired, { maxRedirects: 0 });
    expect(fallback.status()).toBe(307);
    expect(fallback.headers().location).toBe('/skills');
  }
  const trailingSlash = await request.get('/sources/', { maxRedirects: 0 });
  expect(trailingSlash.status()).toBe(308);
  expect(trailingSlash.headers().location).toBe('/sources');

  for (const route of shellRoutes) {
    await page.goto(route.path);
    await expect(page).toHaveTitle('ai-usage report');
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    if (route.marker === null) {
      await expect(page.locator('[data-skills-workspace]')).toBeAttached();
      await expect(page.locator('[data-skills-workspace]')).toHaveAttribute('data-skills-hydrated', 'true');
    } else {
      await expect(page.locator(`[data-route-shell="${route.marker}"]`)).toBeAttached();
    }
    await expect(page.getByRole('complementary', { name: 'Application navigation' })).toBeVisible();
    const activeDestination = activeDestinationFor(route.path, route.heading);
    await expect(page.getByRole('link', { name: activeDestination, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  }
  for (const path of drawerRoutes) {
    await page.goto(path);
    await expect(page.locator('[data-skills-workspace]')).toHaveAttribute('data-skills-hydrated', 'true');
    await expect(page.getByRole('dialog')).toBeVisible();
    const drawerAxe = await new AxeBuilder({ page }).analyze();
    expect(drawerAxe.violations).toEqual([]);
  }

  await page.goto('/skills/projects/project%2Fopaque/skill-name?foreign=kept#anchor');
  await expect(page.locator('[data-skills-workspace]')).toHaveAttribute('data-skills-hydrated', 'true');
  await page.reload();
  await expect(page.locator('[data-skills-workspace]')).toHaveAttribute('data-skills-hydrated', 'true');
  expect(page.url()).toContain('/skills/projects/project%2Fopaque/skill-name?foreign=kept#anchor');

  await page.goto('/');
  await page.evaluate(() => {
    document.body.style.minHeight = '4000px';
    window.scrollTo(0, 3000);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3000);
  const railBounds = await page.getByRole('complementary', { name: 'Application navigation' }).boundingBox();
  expect(railBounds?.y).toBe(0);

  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole('link', { name: 'Skills' }).click();
  await expect(page).toHaveURL('/skills');
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await restoreReportHistory(page, '/');

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(page.locator('[data-app-navigation="mobile"]')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
  const manage = page.getByRole('button', { name: 'Manage' });
  await manage.click();
  await expect(manage).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(manage).toBeFocused();
  await expect(manage).toHaveAttribute('aria-expanded', 'false');
  await manage.click();
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page).toHaveURL('/sources');
  await expect(page.getByRole('navigation', { name: 'Manage destinations' })).toHaveCount(0);
  expect(browserSkillsRequests, 'SSR-hydrated Skills routes must not duplicate Query acquisition').toEqual([]);
});

test('collapses the rail to an icon column with instant hover labels below the labelled breakpoint', async ({
  browserFailureGate,
  page,
}) => {
  const rail = page.getByRole('complementary', { name: 'Application navigation' });
  const syncLink = rail.getByRole('link', { name: 'Sync', exact: true });
  const hoverLabel = syncLink.locator('[data-rail-tooltip]');
  // Reading the style straight after `hover()` resolves is the delay assertion: a tooltip gated on
  // a timer would still be hidden here, the way the native `title` it replaced was.
  const hoverLabelDisplay = (): Promise<string> => hoverLabel.evaluate((node) => getComputedStyle(node).display);

  await page.setViewportSize({ height: 900, width: 1080 });
  await page.goto('/');
  await expect(rail).toBeVisible();
  expect((await rail.boundingBox())?.width).toBe(56);
  // The label is painted away, never removed: role/name lookups must keep resolving it.
  await expect(syncLink).toHaveAccessibleName('Sync');
  expect(await hoverLabelDisplay()).toBe('none');
  await syncLink.hover();
  expect(await hoverLabelDisplay()).toBe('block');
  expect(await hoverLabel.evaluate((node) => getComputedStyle(node, '::before').content)).toBe('"Sync"');
  // The hover label is a second rendering of the text. Chrome folds an unhidden copy into the
  // link's accessible name, so this guards against the rail announcing "Sync Sync" while hovered,
  // and against the copy leaking into the text content the primary-navigation suite asserts on.
  await expect(syncLink).toHaveAccessibleName('Sync');
  await expect(syncLink).toHaveText('Sync');

  const releasePreloadAbort = browserFailureGate.allowRequestAbortOnce({
    pathname: '/sync/__data.json',
    resourceType: 'fetch',
  });
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  releasePreloadAbort();
  expect((await rail.boundingBox())?.width).toBe(216);
  await syncLink.hover();
  // The visible label is back, so the hover label must stay down.
  expect(await hoverLabelDisplay()).toBe('none');
  await expect(syncLink).toHaveAccessibleName('Sync');
  await expect(syncLink).not.toHaveAttribute('title', ANY_VALUE_PATTERN);
});

test('resolves stored and system theme before paint and toggles the named preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', ANY_VALUE_PATTERN);
  await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const toggle = page.getByRole('button', { name: 'Switch to light theme' });
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('ai-usage-theme'))).toBe('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await toggle.click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', ANY_VALUE_PATTERN);
  expect(await page.evaluate(() => localStorage.getItem('ai-usage-theme'))).toBeNull();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', ANY_VALUE_PATTERN);
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('ai-usage-theme'))).toBe('light');
  const transitionDuration = await page
    .getByRole('link', { name: 'Overview' })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration));
  expect(transitionDuration).toBeLessThanOrEqual(0.001);
});

test('blocks dirty navigation through Keep, Discard, reload, focus, and cleanup', async ({
  browserFailureGate,
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/skills/global/alpha-skill');
  await expect(page.locator('[data-skills-workspace]')).toHaveAttribute('data-skills-hydrated', 'true');
  const editor = page.getByLabel('alpha-skill SKILL.md');
  await editor.fill('Unsaved synthetic draft');
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return window.dispatchEvent(event);
    }),
  ).toBe(false);

  // The editor lives in a drawer over the worktable (plan 113). It is deliberately not modal, so
  // the application rail stays reachable — and leaving through it is exactly the navigation the
  // unsaved-draft guard has to block.
  // Dismissing the drawer is a navigation back to the worktable, and it is the departure a reader
  // makes most often from a half-written SKILL.md — so it is the one the guard is exercised on.
  // Below the labelled breakpoint the drawer covers the mobile navigation popover, which is why
  // this is not driven through the rail here.
  await page.getByRole('button', { name: 'Close skill detail' }).click();
  await expect(page).toHaveURL('/skills/global/alpha-skill');
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Discard changes' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveValue('Unsaved synthetic draft');
  await expect(editor).toBeFocused();

  await page.setViewportSize({ height: 900, width: 1280 });

  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL('/sources');
  await expect(prompt).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return window.dispatchEvent(event);
    }),
  ).toBe(true);

  await page.goBack();
  await expect(page).toHaveURL('/skills/global/alpha-skill');
  await expect(page.locator('[data-skills-workspace]')).toHaveAttribute('data-skills-hydrated', 'true');
  const remountedEditor = page.getByLabel('alpha-skill SKILL.md');
  await remountedEditor.fill('Second synthetic draft');
  const releaseSyncDataAbort = browserFailureGate.allowRequestAbortOnce({
    pathname: '/sync/__data.json',
    resourceType: 'fetch',
  });
  try {
    await page.getByRole('link', { name: 'Sync' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(remountedEditor).toBeFocused();
  } finally {
    releaseSyncDataAbort();
  }
});

test('restores Svelte history and scroll without feedback loops', async ({ page }) => {
  await page.goto('/?foreign=kept#anchor');
  await waitForHydratedReport(page);
  await expect(page.locator('[data-app-navigation="desktop"][data-hydrated="true"]')).toBeVisible();
  await page.evaluate(() => {
    document.body.style.minHeight = '4000px';
  });
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);
  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole('link', { name: 'Sessions' }).click();
  expect(new URL(page.url()).searchParams.get('foreign')).toBe('kept');
  expect(new URL(page.url()).hash).toBe('#anchor');
  await expect(page.getByRole('link', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(700);
  await page.goForward();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1200);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
});

test('restores Session scroll after a cross-route history remount', async ({ page }) => {
  await page.goto('/?tab=sessions');
  await waitForHydratedReport(page);
  await expect(page.locator('[data-app-navigation="desktop"][data-hydrated="true"]')).toBeVisible();
  await expect(page.locator('[data-session-table-owner]')).toBeVisible();
  await page.evaluate(() => {
    document.body.style.minHeight = '4000px';
    window.scrollTo(0, 300);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(300);

  await page.getByRole('link', { name: 'Skills' }).click();
  await expect(page).toHaveURL('/skills');
  await restoreReportHistory(page, '/?tab=sessions');
  await expect(page.locator('[data-session-table-owner]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(300);
});

test('reuses one browser cache across Skills children and Report Skills Sync navigation', async ({ page }) => {
  // This measures cache reuse across navigation, so it must not also measure the app's reaction to
  // a source publication. Publications are broadcast by the shared dev server, so a concurrent
  // spec running a source would land one in this page's stream and legitimately refresh the
  // skill-observation identity — a correct refresh, but not the thing under test here. An inert
  // stream removes that cross-test coupling without weakening either behaviour.
  await page.route('**/api/source-control', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
  });
  const trace = createServerStateNetworkTrace(page);
  await page.goto('/');
  await waitForHydratedReport(page);
  await waitForHydratedNavigation(page);
  trace.checkpoint('cross-route-navigation');

  await navigateAndWaitForRouteData(
    page,
    page.getByRole('link', { exact: true, name: 'Skills' }),
    '/skills/__data.json',
  );
  await waitForHydratedSkills(page);
  await page.locator('a[href="/skills/global/alpha-skill"]').first().click();
  await expect(page).toHaveURL('/skills/global/alpha-skill');
  await waitForHydratedSkills(page);
  // The detail is a drawer over the worktable now. Dismissing it is the reader's way back to the
  // table, and it is a navigation of its own — so this walk closes it before leaving Skills.
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL('/skills');
  await navigateAndWaitForRouteData(page, page.getByRole('link', { exact: true, name: 'Sync' }), '/sync/__data.json');
  await expect(page.locator('main[data-route-shell="sync"]')).toBeVisible();
  await navigateAndWaitForRouteData(page, page.getByRole('link', { exact: true, name: 'Overview' }), '/__data.json');
  await waitForFocusedReportSettled(page);

  const counts = trace.counts('cross-route-navigation');
  expect(counts).toEqual({
    operations: {
      'skills.knownProjectPaths': 1,
      'skills.managedMarkdown': 1,
      'skills.observations': 1,
      'skills.projectInventories': 1,
      'skills.snapshot': 1,
      'sync.fleet': 1,
    },
    owners: { 'web-query-browser': 6 },
    // Three, not four: `/skills` is now a page with no load of its own, so returning to it from a
    // skill's drawer reuses the layout data already held instead of asking for route data again.
    // The invariant this gate exists for — one acquisition per Skills operation — is unchanged.
    routeData: 3,
    totalRpc: 6,
  });
  process.stdout.write(
    `${JSON.stringify({ scenario: 'report-skills-children-sync-report', type: 'plan-069-gate-4', value: counts })}\n`,
  );

  trace.checkpoint('fresh-skills-revisit');
  await page.getByRole('link', { exact: true, name: 'Skills' }).click();
  await waitForHydratedSkills(page);
  expect(trace.counts('fresh-skills-revisit')).toEqual({
    operations: {},
    owners: {},
    // One, not two: the rail's Skills link lands on the worktable directly. It used to redirect
    // through `/skills/global`, and that hop was the second route-data request.
    routeData: 1,
    totalRpc: 0,
  });
  trace.dispose();
});

test('renders retryable route errors and the default accessible Not Found shell', async ({ context, page }) => {
  await context.setExtraHTTPHeaders({ 'x-ai-usage-sveltekit-error': 'once' });
  const failed = await page.goto('/?foreign=kept');
  expect(failed?.status()).toBe(503);
  await expect(page.getByRole('heading', { level: 2, name: 'Report unavailable' })).toBeVisible();
  await expect(page.getByText('Report data could not be loaded.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('[data-route-shell="report"]')).toBeAttached();
  expect(new URL(page.url()).searchParams.get('foreign')).toBe('kept');

  await context.setExtraHTTPHeaders({});
  const missing = await page.goto('/definitely-missing');
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'Not Found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to report' })).toHaveAttribute('href', '/');
});

test('redirects Svelte demo routes before protected acquisition', async ({ context, page, request }) => {
  await context.setExtraHTTPHeaders({ 'x-ai-usage-sveltekit-mode': 'demo' });
  const businessRequests: string[] = [];
  page.on('request', (candidate) => {
    const pathname = new URL(candidate.url()).pathname;
    if (pathname.startsWith('/rpc') || pathname.startsWith('/api/')) {
      businessRequests.push(pathname);
    }
  });
  await page.goto('/skills/global');
  await expect(page).toHaveURL('/');
  await expect(page.locator('[data-route-shell="report"]')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Manage' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: MANAGEMENT_DESTINATION_PATTERN })).toHaveCount(0);
  expect(businessRequests).toEqual([]);

  for (const path of [
    '/rpc/report/current',
    '/api/source-control',
    '/api/source-control/command',
    '/api/manual-merge/download',
    '/api/manual-merge/upload',
  ]) {
    const protectedResponse = await request.get(path, {
      headers: {
        'x-ai-usage-sveltekit-acquisition-tripwire': 'armed',
        'x-ai-usage-sveltekit-mode': 'demo',
      },
    });
    expect(protectedResponse.status()).toBe(404);
    expect(protectedResponse.headers()['cache-control']).toBe('no-store');
    expect((await protectedResponse.body()).byteLength).toBe(0);
  }
});
