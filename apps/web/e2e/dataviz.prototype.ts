import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('real data: six representations, filters, zoom, rounds, keyboard and accessible tables', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?variant=parcours');
  const region = page.locator('[data-dataviz-prototype]');
  await expect(region.locator('svg')).toBeVisible();
  const before = await region.locator('.metrics').innerText();
  await page.getByRole('combobox', { name: 'Période', exact: true }).selectOption('14');
  await expect(region.locator('.metrics')).not.toHaveText(before);
  await page.getByRole('combobox', { name: 'Période', exact: true }).selectOption('30');
  const project = page.getByRole('combobox', { name: 'Projet', exact: true });
  await project.selectOption({ label: 'ai-usage — nixos' });
  await expect(region.locator('.metrics div').nth(2).locator('strong')).toHaveText('1');
  await project.selectOption('');
  await page.getByRole('button', { name: 'Paysage et trajectoires', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Paysage et trajectoires' })).toBeVisible();
  for (const name of ['Streamgraph', 'Bump chart', 'Ridgeline']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(region.locator('svg')).toBeVisible();
    expect(await region.locator('svg').innerHTML()).not.toContain('NaN');
  }
  await page.getByRole('button', { name: 'Campagnes et délégation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Zoom sur une session', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom sur une session', exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Arcs', exact: true }).click();
  const slider = page.getByRole('slider');
  await expect(slider).toBeVisible();
  const paths = await region.locator('svg path').count();
  await slider.fill('1');
  await expect(region.locator('svg path')).not.toHaveCount(paths);
  await region.locator('summary').click();
  await expect(region.locator('table')).toBeVisible();
  expect((await new AxeBuilder({ page }).include('[data-dataviz-prototype]').analyze()).violations).toEqual([]);
  await page.locator('h1').click();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'Parcours des tokens' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile controls and plot scrolling stay within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?variant=activite');
  await expect(page.locator('[data-dataviz-prototype] svg')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Ridgeline', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect((await new AxeBuilder({ page }).include('[data-dataviz-prototype]').analyze()).violations).toEqual([]);
});
