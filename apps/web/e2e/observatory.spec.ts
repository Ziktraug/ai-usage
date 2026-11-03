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

test('constellation rotates in 3D, filters projects and opens a selected native session', async ({ page }) => {
  await page.goto('/observatory?range=all');
  await waitForHydratedNavigation(page);
  const constellation = page.getByRole('region', { name: 'Session constellation', exact: true });
  await expect(constellation).toBeVisible();
  const points = constellation.locator('[data-constellation-node]');
  expect(await points.count()).toBeGreaterThan(5);
  await page.getByRole('combobox', { name: 'Projection', exact: true }).selectOption('3d');
  const id = await points.first().getAttribute('data-constellation-node');
  const point = constellation.locator(`[data-constellation-node="${id}"]`);
  const before = await point.getAttribute('cx');
  await page.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await expect(point).not.toHaveAttribute('cx', before!);
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(constellation).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Inspect a session', exact: true })
    .selectOption({ label: 'world-state · Define the data model' });
  await expect(
    page.getByRole('link', { name: 'Open declared parent Build forecast model', exact: true }),
  ).toBeVisible();
  const href = await page.getByRole('link', { name: 'Open selected session', exact: true }).getAttribute('href');
  expect(new URL(href!).pathname.startsWith('/sessions/')).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

for (const range of ['today', '2026-06-01..2026-06-30']) {
  test(`observatory preserves the ${range} period through search and reload`, async ({ page }) => {
    await page.goto(`/observatory?range=${range}`);
    await waitForHydratedNavigation(page);
    await expect(page.getByRole('combobox', { name: 'Period', exact: true })).toHaveValue(range);
    await page.getByRole('searchbox', { name: 'Search sessions' }).fill('forecast');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page).toHaveURL(forecastQuery);
    expect(new URL(page.url()).searchParams.get('range')).toBe(range);
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Period', exact: true })).toHaveValue(range);
    await expect(page.getByRole('searchbox', { name: 'Search sessions' })).toHaveValue('forecast');
  });
}
