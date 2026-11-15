import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './browser-test';

// Stable seeds of the process fixture; journeys in other specs add their own tasks beside them.
const ids = {
  payments: '12000000-0000-4000-8000-000000000001',
  analysis: '12000000-0000-4000-8000-000000000004',
  uploads: '12000000-0000-4000-8000-000000000005',
  running: '12000000-0000-4000-8000-000000000007',
};
const MEDIA = [
  { label: 'light mode', media: { colorScheme: 'light' } },
  { label: 'dark mode', media: { colorScheme: 'dark' } },
  { label: 'light forced-colors mode', media: { colorScheme: 'light', forcedColors: 'active' } },
  { label: 'dark forced-colors mode', media: { colorScheme: 'dark', forcedColors: 'active' } },
  { label: 'light more-contrast mode', media: { colorScheme: 'light', contrast: 'more' } },
  { label: 'dark more-contrast mode', media: { colorScheme: 'dark', contrast: 'more' } },
] as const;
const LIFECYCLE_NAME = /^Lifecycle\. Sessions: .+; Push: .+; Pull request: .+; Ticket: .+$/;
const BAND_PARAMETER = /[?&]band=/;
const YOURS_BAND_URL = /[?&]band=yours/;
const PILOT_VIEW_URL = /[?&]view=pilot/;
const TASK_URL = /[?&]task=/;
const YOURS_BAND = /^Yours\b/;
const IN_FLIGHT_BAND = /^In flight\b/;
const TO_TIDY_BAND = /^To tidy\b/;

const openPilot = async (page: Page): Promise<void> => {
  await page.goto('/work?view=pilot');
  await expect(page.locator('[data-work-threads][data-work-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'My work', exact: true })).toBeVisible();
};
const row = (page: Page, threadId: string) => page.locator(`li[data-work-thread="${threadId}"]`);
const documentOverflow = (): number => document.documentElement.scrollWidth - document.documentElement.clientWidth;

for (const { label, media } of MEDIA) {
  test(`the Pilot view has no detectable accessibility violations in ${label}`, async ({ page }) => {
    await page.emulateMedia(media);
    await openPilot(page);
    await expect(row(page, ids.payments)).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations).toEqual([]);
  });
}

test('the Pilot view files tasks in bands and says each lifecycle in words', async ({ page }) => {
  await openPilot(page);
  const yours = page.getByRole('region', { name: YOURS_BAND });
  const inFlight = page.getByRole('region', { name: IN_FLIGHT_BAND });
  const toTidy = page.getByRole('region', { name: TO_TIDY_BAND });
  await expect(yours.locator(row(page, ids.payments))).toHaveCount(1);
  await expect(inFlight.locator(row(page, ids.running))).toHaveCount(1);
  await expect(toTidy.locator(row(page, ids.analysis))).toHaveCount(1);
  await expect(toTidy.locator(row(page, ids.uploads))).toHaveCount(1);

  const payments = row(page, ids.payments);
  await expect(payments.locator('.wt-row-next')).toHaveText('Next: Address 2 review threads on #1487');
  await expect(row(page, ids.uploads).locator('.wt-row-next')).toHaveText('Next: End follow-up');
  const rail = payments.getByRole('img', { name: LIFECYCLE_NAME });
  await expect(rail).toHaveCount(1);
  await expect(rail.locator('.wt-rail-step')).toHaveCount(8);
  await expect(rail.locator('.wt-rail-step[data-step="review"]')).toHaveAttribute('data-state', 'yours');
  // One control per row: the title link.
  await expect(payments.getByRole('link')).toHaveCount(1);
});

test('the Pilot view keeps its columns inside the daily viewports', async ({ page }) => {
  for (const width of [1680, 1280, 1080, 900, 768]) {
    await page.setViewportSize({ height: 1000, width });
    await openPilot(page);
    await expect(row(page, ids.payments)).toBeVisible();
    await expect.poll(() => page.evaluate(documentOverflow)).toBeLessThanOrEqual(0);
    const box = await row(page, ids.payments).boundingBox();
    expect(box).not.toBeNull();
    // One 44 px line down to 781 px; two lines below.
    expect(box?.height ?? 0).toBeLessThanOrEqual(width > 780 ? 46 : 76);
  }
});

test('a band counter filters the Pilot list and releases it', async ({ page }) => {
  await openPilot(page);
  const filters = page.getByRole('group', { name: 'Filter tasks by whose move it is' });
  const yours = filters.getByRole('button', { name: 'yours' });
  await expect(yours).toHaveAttribute('aria-pressed', 'false');
  await yours.click();
  await expect(page).toHaveURL(YOURS_BAND_URL);
  await expect(yours).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, ids.payments)).toBeVisible();
  await expect(row(page, ids.analysis)).toHaveCount(0);
  await yours.click();
  await expect(page).not.toHaveURL(BAND_PARAMETER);
  await expect(row(page, ids.analysis)).toBeVisible();
});

test('a compact row opens its task from the keyboard and Back returns to it in the Pilot view', async ({ page }) => {
  await openPilot(page);
  const title = row(page, ids.payments).getByRole('link');
  await title.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Prevent duplicate payments' })).toBeVisible();
  await expect(page).toHaveURL(PILOT_VIEW_URL);
  await page.goBack();
  await expect(page).not.toHaveURL(TASK_URL);
  await expect(title).toBeFocused();
});

test('the lanes view stays the default and links to the Pilot view', async ({ page }) => {
  await page.goto('/work');
  await expect(page.locator('[data-work-threads][data-work-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'One thread per task.' })).toBeVisible();
  const views = page.getByRole('navigation', { name: 'Work views' });
  await expect(views.getByRole('link', { name: 'Lanes', exact: true })).toHaveAttribute('aria-current', 'page');
  await views.getByRole('link', { name: 'Pilot', exact: true }).click();
  await expect(page).toHaveURL(PILOT_VIEW_URL);
  await expect(page.getByRole('heading', { level: 1, name: 'My work', exact: true })).toBeVisible();
});
