import type { Page } from '@playwright/test';
import { expect, openHydratedReport, reportViewsFor, test } from './browser-test';

const DRAW_CLASS = /draw/;
const SORT_URL = /sort=cost/;
const SESSION_URL = /\/sessions\//;

test('Skills intentionally omits the report description line instead of padding an empty row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/skills');
  await page.evaluate(() => document.fonts.ready);
  const height = await page.locator('[data-workspace-header]').evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(105);
  expect(height).toBeLessThanOrEqual(109);
});

const observeTransitions = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const original = document.startViewTransition.bind(document);
    document.startViewTransition = (update) => {
      const root = document.documentElement;
      root.dataset.transitionCount = String(Number(root.dataset.transitionCount ?? 0) + 1);
      const transition = original(update);
      root.dataset.transitionDirection = Array.from(transition.types).join(',');
      transition.finished
        .then(() => {
          root.dataset.transitionFinishedCount = root.dataset.transitionCount;
        })
        .catch(() => undefined);
      transition.ready.catch((error: unknown) => {
        root.dataset.transitionFailure = String(error);
      });
      return transition;
    };
  });
};

test('shell transitions preserve geometry and do not replay the stroke entrance', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await observeTransitions(page);
  const response = await openHydratedReport(page);
  expect(await response?.text()).toContain('draw');
  const header = page.locator('[data-workspace-header]');
  const initialHeight = await header.evaluate((element) => element.getBoundingClientRect().height);
  const initialContour = await header.locator('path').first().getAttribute('d');
  await expect(page.locator('[data-workspace-atmosphere]')).toHaveClass(DRAW_CLASS);
  await expect(page.locator('.atmosphere-motion')).toHaveCSS('will-change', 'transform');
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSAnimation && animation.animationName.includes('drift'))
        .map(
          (animation) =>
            animation.effect instanceof KeyframeEffect && animation.effect.target instanceof HTMLDivElement,
        ),
    ),
  ).toEqual([true]);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-transition-count', '1');
  await expect(header.locator('path').first()).not.toHaveAttribute('d', initialContour ?? '');
  expect(await header.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
  await expect(header).toHaveCSS('min-height', '0px');
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = `${location.pathname}${location.search}&sort=cost`;
    document.body.append(link);
    link.click();
    link.remove();
  });
  await expect(page).toHaveURL(SORT_URL);
  await expect(page.locator('html')).toHaveAttribute('data-transition-count', '1');
  await page.getByRole('link', { exact: true, name: 'Sources' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();
  expect(await header.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight);
  await expect(page.locator('[data-workspace-atmosphere]')).not.toHaveClass(DRAW_CLASS);
  await expect(page.locator('html')).toHaveAttribute('data-transition-finished-count', '2');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-transition-direction', 'backwards');
  await expect(page.locator('html')).toHaveAttribute('data-transition-finished-count', '3');
  await expect(page.locator('html')).not.toHaveAttribute('data-transition-failure');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Usage overview' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-transition-count', '3');
  await expect(page.locator('.atmosphere-motion')).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('[data-workspace-atmosphere]')).toBeHidden();
});

test.describe('server-rendered atmosphere without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('finishes its CSS entrance and stays static for reduced motion and print', async ({ page }) => {
    await page.goto('/');
    const path = page.locator('[data-workspace-atmosphere] path').last();
    await expect(path).toHaveCSS('stroke-dashoffset', '0px');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(path).toHaveCSS('animation-name', 'none');
    await expect(path).toHaveCSS('stroke-dashoffset', '0px');
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('[data-workspace-header]')).toHaveCSS('min-height', '0px');
    await expect(page.locator('[data-workspace-atmosphere]')).toBeHidden();
  });
});

for (const width of [1280, 390]) {
  test(`stationary navigation has unique rendered transition names at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await observeTransitions(page);
    await openHydratedReport(page);
    const hiddenNavigation = page.locator(`[data-app-navigation="${width === 390 ? 'desktop' : 'mobile'}"]`);
    await expect(hiddenNavigation).toHaveCSS('display', 'none');
    expect(await hiddenNavigation.evaluate((element) => element.getClientRects().length)).toBe(0);
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('*'))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => getComputedStyle(element).viewTransitionName)
        .filter((name) => name !== 'none'),
    );
    expect(new Set(names).size).toBe(names.length);
    await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-transition-finished-count', '1');
    await expect(page.locator('html')).not.toHaveAttribute('data-transition-failure');
  });
}

test('session panels preserve the table scroll and drawer focus without starting a transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 440 });
  await observeTransitions(page);
  await openHydratedReport(page, '/?tab=sessions');
  const surface = page.locator('[data-session-surface="desktop"]');
  const row = surface
    .locator('[data-depth="0"][data-session-row-id]')
    .filter({ hasText: 'Recover Claude history' })
    .first();
  await row.focus();
  await surface.evaluate((element) => {
    element.scrollTop = 16;
  });
  const scrollTop = await surface.evaluate((element) => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await row.press('Enter');
  await expect(page).toHaveURL(SESSION_URL);
  const close = page.getByRole('button', { name: 'Close session details' });
  // Desktop details are non-modal: opening keeps keyboard focus on the originating row.
  await expect(row).toBeFocused();
  expect(await surface.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  await expect(page.locator('html')).not.toHaveAttribute('data-transition-count');
  await close.click();
  await expect(row).toBeFocused();
  expect(await surface.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  await expect(page.locator('html')).not.toHaveAttribute('data-transition-count');
});
