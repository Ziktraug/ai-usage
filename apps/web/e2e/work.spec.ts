import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, waitForHydratedReport } from './browser-test';

const waitForHydratedWork = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-work-session][data-work-hydrated="true"]').first()).toBeVisible();
};

test('Work uses bounded synthetic observations, accessible detail links and a side-effect-free routing simulation', async ({
  page,
}) => {
  await page.goto('/');
  await waitForHydratedReport(page);
  await page.getByRole('navigation', { name: 'Work space' }).getByRole('link', { name: 'Work', exact: true }).click();
  await waitForHydratedWork(page);
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  await expect(
    page.getByText('Synthetic demonstration · no local history is read. Routing eligibility is fixture data.'),
  ).toBeVisible();
  const sourceSummary = page.locator('summary').filter({ hasText: 'Sources and limits' });
  await sourceSummary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Known waits are unavailable.', { exact: false })).toBeVisible();
  const session = page.locator('[data-work-session]').filter({ hasText: 'Build report UI' }).first();
  await expect(session).toContainText('Last recorded activity across related sessions');
  await session.getByRole('link', { name: 'Open session detail' }).click();
  await expect(page.getByRole('dialog', { name: 'Session details', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/work');
  await waitForHydratedWork(page);
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') {
      posts.push(new URL(request.url()).pathname);
    }
  });
  await page.locator('[data-work-session]').first().getByRole('button', { name: 'Simulate review assignment' }).click();
  await expect(page.getByRole('heading', { name: 'Review assignment simulation', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Routing result' })).toContainText('Chosen: Claude Code');
  await page.getByLabel('Harness preference').selectOption('codex');
  await expect(page.getByRole('region', { name: 'Routing result' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Routing result' })).toContainText('Chosen: Codex');
  await expect(page.getByRole('region', { name: 'Routing result' })).toContainText('No execution was started');
  await page.locator('summary').filter({ hasText: 'Synthetic evidence examples' }).click();
  await expect(page.getByText('Projection-boundary fixtures; these are not collected native outcomes.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Requested PR observed open' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proposal unanswered' })).toBeVisible();
  expect(posts).toEqual([]);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('Work remains usable on mobile with collapsed related sessions and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work', exact: true })).toBeVisible();
  await expect(
    page.locator('[data-app-navigation="mobile"]').getByRole('link', { name: 'Work', exact: true }),
  ).toBeVisible();
  const related = main.locator('summary').filter({ hasText: 'related sessions and technical reviews' }).first();
  const disclosure = related.locator('..');
  await expect(related).toBeVisible();
  await expect(disclosure).not.toHaveAttribute('open', '');
  await related.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('open', '');
  await expect(disclosure.getByRole('list').getByRole('link').first()).toBeVisible();
  await related.focus();
  await page.keyboard.press('Space');
  await expect(disclosure).not.toHaveAttribute('open', '');
  await expect(disclosure.getByRole('list')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('open', '');
  await expect(disclosure.getByRole('list').getByRole('link').first()).toBeVisible();
  await main.getByRole('button', { name: 'Simulate review assignment' }).first().click();
  await page.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Routing result' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('Work preserves a related-session disclosure opened by keyboard before hydration', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scriptsBlocked = Promise.withResolvers<void>();
  const releaseScripts = Promise.withResolvers<void>();
  // Hold the real application scripts so the early native gesture is deterministic.
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') {
      scriptsBlocked.resolve();
      await releaseScripts.promise;
    }
    await route.continue();
  });

  try {
    await page.goto('/work', { waitUntil: 'commit' });
    await scriptsBlocked.promise;
    const card = page
      .locator('[data-work-session]')
      .filter({ hasText: 'related sessions and technical reviews' })
      .first();
    const related = card.locator('summary').filter({ hasText: 'related sessions and technical reviews' });
    const disclosure = related.locator('..');
    await expect(card).toHaveAttribute('data-work-hydrated', 'false');
    await expect(disclosure).not.toHaveAttribute('open', '');
    await related.focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.getByRole('list')).toHaveCount(0);

    releaseScripts.resolve();
    await expect(card).toHaveAttribute('data-work-hydrated', 'true');
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.getByRole('list').getByRole('link').first()).toBeVisible();
  } finally {
    releaseScripts.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
