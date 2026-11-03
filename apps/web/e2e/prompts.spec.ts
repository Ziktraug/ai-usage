import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const selectedSessionPattern = /selectedSession=/;
const firstRoundPattern = /^Round 1 of/;

test('prompt explorer searches the synthetic corpus and preserves filters on reload', async ({ page }) => {
  await page.goto('/prompts');
  await expect(page.getByRole('heading', { name: 'Prompts', exact: true })).toBeVisible();
  await expect(page.getByText('Review the data parser and explain the edge cases.', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search prompt text' }).fill('regression');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Add a regression test before fixing the parser.', { exact: true })).toBeVisible();
  await expect(page.getByText('Review the data parser and explain the edge cases.', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('searchbox')).toHaveValue('regression');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export loaded prompts' }).click();
  expect((await download).suggestedFilename()).toBe('prompts.json');
});
for (const width of [390, 1440]) {
  test(`prompt explorer is accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/prompts');
    await expect(page.getByRole('heading', { name: 'Prompts', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
test('prompt result opens the existing rounds reader', async ({ page }) => {
  await page.goto('/prompts');
  await page.getByRole('button', { name: 'Read session rounds' }).first().click();
  await expect(page).toHaveURL(selectedSessionPattern);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: firstRoundPattern })).toBeVisible();
});
