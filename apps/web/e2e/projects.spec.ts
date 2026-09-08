import { expect, test, waitForHydratedNavigation } from './browser-test';

test('reviews an opaque Checkout and explicitly leaves it unassigned', async ({ page }) => {
  await page.goto('/projects');
  await waitForHydratedNavigation(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'checkout:0198f179' })).toBeVisible();
  await expect(page.getByText('Development device', { exact: true })).toBeVisible();
  await expect(page.getByText('github.com/openai/ai-usage', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('/home/')).toHaveCount(0);

  await page.getByRole('button', { name: 'Leave unassigned' }).click();
  await expect(page.getByText('No Project assignments need review.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'checkout:0198f179' })).toHaveCount(0);
});
