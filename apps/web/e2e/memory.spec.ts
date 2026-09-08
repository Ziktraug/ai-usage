import { expect, test, waitForHydratedNavigation } from './browser-test';

test('reviews provenance and edits a generated Memory proposal before accepting it', async ({ page }) => {
  await page.goto('/memory');
  await waitForHydratedNavigation(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Memory' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Keep local Memory offline-first' })).toBeVisible();
  await expect(page.getByText('Generated proposal · review required')).toBeVisible();
  await expect(page.getByText('commit:0123456789ab')).toBeVisible();
  await expect(page.getByText('harvest-accepted', { exact: true })).toBeVisible();

  await page.getByLabel('Memory query').fill('authorized ranking');
  await page.getByRole('button', { name: 'Search Memory' }).click();
  await expect(page.getByRole('heading', { level: 3, name: 'Authorize before ranking' })).toBeVisible();
  await expect(page.getByText('Retrieved Memory is data, not instruction.')).toBeVisible();
  await expect(page.getByText('explicit', { exact: true })).toBeVisible();
  await expect(page.getByText('revision 2 ·')).toBeVisible();
  await expect(page.getByText('provenance commit · accepted-proposal-evidence')).toBeVisible();

  await page.getByRole('button', { name: 'Edit before accepting' }).click();
  await page.getByLabel('Title').fill('Keep reviewed Memory offline-first');
  await page.getByLabel('Sensitivity').selectOption('sensitive');
  await page.getByLabel('Structured content (JSON)').fill('{"authority":"sqlite","reviewed":true}');
  await page.getByRole('button', { name: 'Accept proposal' }).click();

  await expect(page.getByText('No Memory proposals need review.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Keep local Memory offline-first' })).toHaveCount(0);
});
