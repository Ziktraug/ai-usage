import { expect, test } from '@playwright/test';

const CALENDAR_NAME_PATTERN = /Daily activity calendar/;
const INSPECT_SESSION_PATTERN = /Inspect session/;
const QUERY_URL_PATTERN = /q=ai-usage/;
const RANGE_URL_PATTERN = /range=/;
const SORT_URL_PATTERN = /sort=/;

test('loads a deterministic report overview', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Usage report' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Date range' })).toBeVisible();
  await expect(page.getByText('4 / 4 sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
});

test('persists exploration state in the URL', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('/');

  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await search.fill('ai-usage');
  await search.press('Enter');

  await expect(page).toHaveURL(QUERY_URL_PATTERN);
  await page.reload();
  await expect(search).toHaveValue('ai-usage');
});

test('updates the date range and opens a session drawer', async ({ page }) => {
  await page.goto('/');
  const range = page.getByRole('region', { name: 'Date range' });

  await range.getByRole('button', { exact: true, name: '30d' }).click();
  await expect(page).toHaveURL(RANGE_URL_PATTERN);
  await expect(range.getByRole('textbox', { name: 'Start date' })).toHaveValue('2026-05-12');

  await page.getByRole('tab', { name: 'Sessions' }).click();
  await page.locator('tbody tr').first().locator('td').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('offers keyboard-safe charts and mobile summaries at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 361 });
  await page.goto('/');

  const calendar = page.getByRole('toolbar', { name: CALENDAR_NAME_PATTERN });
  const focusedCalendarDay = calendar.locator('button[tabindex="0"]');
  await expect(focusedCalendarDay).toHaveCount(1);
  const initialDayLabel = await focusedCalendarDay.getAttribute('aria-label');
  await focusedCalendarDay.focus();
  await focusedCalendarDay.press('ArrowLeft');
  await expect(calendar.locator('button:focus')).not.toHaveAttribute('aria-label', initialDayLabel ?? '');
  await expect(calendar.locator('button[tabindex="0"]')).toHaveCount(1);

  await page.getByRole('tab', { name: 'Sessions' }).click();
  const sessionSummaries = page.getByRole('list', { name: 'Session summaries' });
  await expect(sessionSummaries).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  const mobileSort = page.getByRole('combobox', { name: 'Sort mobile session summaries' });
  await mobileSort.selectOption('fresh');
  await expect(mobileSort).toHaveValue('fresh');
  await expect(page).toHaveURL(SORT_URL_PATTERN);
  await sessionSummaries.getByRole('button', { name: INSPECT_SESSION_PATTERN }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Projects' }).click();
  await expect(page.getByRole('list', { name: 'Project summaries' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('keeps sync limited to explicit file transfers', async ({ page }) => {
  await page.goto('/sync');

  await expect(page.getByRole('heading', { level: 1, name: 'Sync' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export file' })).toBeVisible();
  await expect(page.getByLabel('Import file')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start LAN merge' })).toHaveCount(0);
  await expect(page.getByLabel('Scan host')).toHaveCount(0);
  await expect(page.getByText('Pair nearby machine')).toHaveCount(0);
});
