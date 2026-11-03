import AxeBuilder from '@axe-core/playwright';
import { expect, test, waitForHydratedNavigation } from './browser-test';

const forecastQuery = /q=forecast/;

test('observatory conserves global tokens across multiple projects and keeps filters in the URL', async ({ page }) => {
  await page.goto('/observatory?range=all');
  await waitForHydratedNavigation(page);
  await expect(page.getByRole('heading', { name: 'Observatory', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Token flow', exact: true })).toBeVisible();
  await page.getByText('Exact flow values', { exact: true }).click();
  const table = page.getByRole('table', { name: 'Observed tokens for each project and model' });
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  expect(await table.locator('tbody tr').count()).toBeGreaterThan(1);
  const projects = await table.locator('tbody th').allTextContents();
  expect(new Set(projects).size).toBeGreaterThan(1);
  await page.getByRole('searchbox', { name: 'Search sessions' }).fill('forecast');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL(forecastQuery);
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search sessions' })).toHaveValue('forecast');
  await expect(page.getByRole('region', { name: 'Token flow', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('observatory supports a narrow viewport and keyboard scrolling without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/observatory?range=all');
  await expect(page.getByRole('region', { name: 'Token flow', exact: true })).toBeVisible();
  const diagram = page.getByRole('region', { name: 'Scrollable token flow diagram', exact: true });
  await diagram.focus();
  await expect(diagram).toBeFocused();
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
