import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './browser-test';

const ANY_VALUE_PATTERN = /.+/;
const MANAGEMENT_DESTINATION_PATTERN = /Skills|Sources|Sync/;

const activeDestinationFor = (path: string, heading: string): string => {
  if (path === '/') {
    return 'Overview';
  }
  return path.startsWith('/skills') ? 'Skills' : heading;
};

const shellRoutes = [
  { heading: 'Usage report', marker: 'report', path: '/' },
  { heading: 'Skill management', marker: 'skills-global', path: '/skills/global' },
  { heading: 'Skill management', marker: 'skills-global-detail', path: '/skills/global/alpha%20skill' },
  { heading: 'Skill management', marker: 'skills-matrix', path: '/skills/matrix' },
  { heading: 'Skill management', marker: 'skills-project', path: '/skills/projects/project%2Fopaque' },
  {
    heading: 'Skill management',
    marker: 'skills-project-detail',
    path: '/skills/projects/project%2Fopaque/skill%20name',
  },
  { heading: 'Sources', marker: 'sources', path: '/sources' },
  { heading: 'Sync', marker: 'sync', path: '/sync' },
] as const;

test('server-renders and reloads every Svelte shell route with accessible navigation', async ({ page, request }) => {
  for (const route of shellRoutes) {
    const response = await request.get(route.path);
    expect(response.status()).toBe(200);
    expect(response.headers()['x-ai-usage-shadow']).toBe('sveltekit');
    const html = await response.text();
    expect(html).toContain(`data-route-shell="${route.marker}"`);
    expect(html).toContain(route.heading);
  }
  const fallback = await request.get('/skills', { maxRedirects: 0 });
  expect(fallback.status()).toBe(307);
  expect(fallback.headers().location).toBe('/skills/global');
  const trailingSlash = await request.get('/sources/', { maxRedirects: 0 });
  expect(trailingSlash.status()).toBe(308);
  expect(trailingSlash.headers().location).toBe('/sources');

  for (const route of shellRoutes) {
    await page.goto(route.path);
    await expect(page).toHaveTitle('ai-usage report');
    await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
    await expect(page.locator(`[data-route-shell="${route.marker}"]`)).toBeAttached();
    await expect(page.getByRole('complementary', { name: 'Application navigation' })).toBeVisible();
    const activeDestination = activeDestinationFor(route.path, route.heading);
    await expect(page.getByRole('link', { name: activeDestination, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
      0,
    );
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  }

  await page.goto('/skills/projects/project%2Fopaque/skill%20name?foreign=kept#anchor');
  await page.reload();
  expect(page.url()).toContain('/skills/projects/project%2Fopaque/skill%20name?foreign=kept#anchor');

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
  await expect(page).toHaveURL('/skills/global');
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await page.goBack();
  await expect(page).toHaveURL('/');

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(page.locator('[data-app-navigation="mobile"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
    0,
  );
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

test('blocks dirty navigation through Keep, Discard, reload, focus, and cleanup', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/skills/global/alpha%20skill');
  const editor = page.getByLabel('Synthetic SKILL.md draft');
  await editor.fill('Unsaved synthetic draft');
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return window.dispatchEvent(event);
    }),
  ).toBe(false);

  const manage = page.getByRole('button', { name: 'Manage' });
  await manage.click();
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page).toHaveURL('/skills/global/alpha%20skill');
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Discard changes' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await manage.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveValue('Unsaved synthetic draft');
  await expect(editor).toBeFocused();
  await expect(manage).toHaveAttribute('aria-expanded', 'true');

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
  await expect(page).toHaveURL('/skills/global/alpha%20skill');
  const remountedEditor = page.getByLabel('Synthetic SKILL.md draft');
  await remountedEditor.fill('Second synthetic draft');
  await page.getByRole('link', { name: 'Sync' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(remountedEditor).toBeFocused();
});

test('restores Svelte history and scroll without feedback loops', async ({ page }) => {
  await page.goto('/?foreign=kept#anchor');
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

test('renders retryable route errors and the default accessible Not Found shell', async ({ context, page }) => {
  await context.setExtraHTTPHeaders({ 'x-ai-usage-shadow-error': 'once' });
  const failed = await page.goto('/');
  expect(failed?.status()).toBe(503);
  await expect(page.getByRole('heading', { level: 2, name: 'Report unavailable' })).toBeVisible();
  await expect(page.getByText('Report data could not be loaded.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('[data-route-shell="report"]')).toBeAttached();

  await context.setExtraHTTPHeaders({});
  const missing = await page.goto('/definitely-missing');
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'Not Found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to report' })).toHaveAttribute('href', '/');
});

test('redirects Svelte demo routes before protected acquisition', async ({ context, page, request }) => {
  await context.setExtraHTTPHeaders({ 'x-ai-usage-shadow-mode': 'demo' });
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
        'x-ai-usage-shadow-acquisition-tripwire': 'armed',
        'x-ai-usage-shadow-mode': 'demo',
      },
    });
    expect(protectedResponse.status()).toBe(404);
    expect(protectedResponse.headers()['cache-control']).toBe('no-store');
    expect((await protectedResponse.body()).byteLength).toBe(0);
  }
});
