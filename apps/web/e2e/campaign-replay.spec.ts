import AxeBuilder from '@axe-core/playwright';
import { expect, test, waitForHydratedNavigation } from './browser-test';

const openingPrompt = 'Plan the forecast model using the recorded inputs.';
const reviewPrompt = 'Review the forecast changes and report the remaining checks.';

test('replay seeks native rounds, plays and pauses, and opens real session details', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/campaigns?range=all');
  await waitForHydratedNavigation(page);
  await page.getByRole('button', { name: 'Show campaign replay', exact: true }).click();
  const replay = page.getByRole('region', { name: 'Campaign replay', exact: true });
  await expect(replay).toBeVisible();
  const slider = page.getByRole('slider', { name: 'Replay elapsed time', exact: true });
  await expect(slider).toHaveValue('0');
  await expect(replay.getByText(openingPrompt, { exact: true })).toBeVisible();
  await expect(replay.getByText(reviewPrompt, { exact: true })).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(slider).toHaveValue('0');
  await slider.fill('3000000');
  await expect(replay.getByText(reviewPrompt, { exact: true })).toBeVisible();
  await slider.fill('0');
  await expect(replay.getByText(reviewPrompt, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
  const paused = await slider.inputValue();
  await page.waitForTimeout(200);
  await expect(slider).toHaveValue(paused);
  await page.getByRole('button', { name: 'Restart replay', exact: true }).click();
  await slider.focus();
  await page.keyboard.press('End');
  await expect(replay.getByText(reviewPrompt, { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Open selected session details', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Session details', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('selectedSession')).toBe(true);
});

test('replay changes selected native history without carrying the previous events', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/campaigns?range=all');
  await expect(page.locator('[data-app-navigation="mobile"][data-hydrated="true"]')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Show campaign replay', exact: true }).click();
  const replay = page.getByRole('region', { name: 'Campaign replay', exact: true });
  await expect(replay.getByText(openingPrompt, { exact: true })).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Replay session', exact: true })
    .selectOption({ label: 'Define the data model' });
  await expect(replay.getByText('Native events unavailable:', { exact: false })).toBeVisible();
  await expect(replay.getByText(openingPrompt, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const duration of [500, 1500]) {
  test(`End seeks the exact ${duration} ms endpoint and reveals its final native event`, async ({ page }) => {
    await page.goto('/campaigns?range=all');
    await waitForHydratedNavigation(page);
    await page.addScriptTag({
      type: 'module',
      url: '/src/lib/features/campaigns/campaign-replay-endpoint.e2e-fixture.ts',
    });
    await page.getByLabel('Fixture duration', { exact: true }).selectOption(String(duration));
    const replay = page.getByRole('region', { name: 'Campaign replay', exact: true });
    await expect(replay.getByText('Opening fractional replay event', { exact: true })).toBeVisible();
    await expect(replay.getByText('Final fractional replay event', { exact: true })).toHaveCount(0);
    const slider = page.getByRole('slider', { name: 'Replay elapsed time', exact: true });
    await slider.focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveValue(String(duration));
    await expect(replay.getByText('Recorded end reached', { exact: true })).toBeVisible();
    await expect(replay.getByText('Final fractional replay event', { exact: true })).toBeVisible();
  });
}
