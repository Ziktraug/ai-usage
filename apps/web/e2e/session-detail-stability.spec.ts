import { expect, openHydratedReport, test } from './browser-test';

const ROUNDS_TAB = /^Rounds/;
const CONTINUE_READING = /^Continue reading/;
const SELECTED_ROUND = 'button[aria-current="true"]';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openHydratedReport(page);
  await page.addScriptTag({ type: 'module', url: '/src/lib/features/sessions/detail/session-detail.e2e-fixture.ts' });
  await expect(page.getByRole('list', { name: 'Rounds', exact: true })).toBeVisible();
});

test('retains the reader, selected round and expanded prompt across publications and tabs', async ({ page }) => {
  const rail = page.getByRole('list', { name: 'Rounds', exact: true });
  await rail.locator('button').nth(1).click();
  await page.getByRole('button', { name: CONTINUE_READING }).click();
  await rail.evaluate((element) => {
    element.scrollTop = 150;
  });
  const initialRail = await rail.elementHandle();
  const initialPrompt = await page.locator('[data-session-round-prompt]').elementHandle();
  for (let publication = 0; publication < 2; publication += 1) {
    await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
    await expect(page.locator('[data-session-detail-fixture]')).toHaveAttribute('data-pending', 'true');
    await expect(rail).toBeVisible();
    await expect(rail.locator(SELECTED_ROUND)).toContainText('Round 2:');
    await expect(page.getByRole('button', { name: 'Show the opening only' })).toBeVisible();
    expect(await rail.evaluate((element) => element.scrollTop)).toBe(150);
    expect(await initialRail?.evaluate((element) => element.isConnected)).toBe(true);
    expect(await initialPrompt?.evaluate((element) => element.isConnected)).toBe(true);
    await page.getByRole('button', { name: 'Release detail', exact: true }).click();
    await expect(page.locator('[data-session-detail-fixture]')).toHaveAttribute('data-pending', 'false');
  }
  await page.getByRole('tab', { name: 'Summary', exact: true }).click();
  await expect(rail).not.toBeVisible();
  await page.getByRole('tab', { name: ROUNDS_TAB }).click();
  await expect(page.getByRole('button', { name: 'Show the opening only' })).toBeVisible();
  expect(await rail.evaluate((element) => element.scrollTop)).toBe(150);
  expect(await initialRail?.evaluate((element) => element.isConnected)).toBe(true);
});

test('retains Timeline during refresh and does not claim consistency with the new revision', async ({ page }) => {
  await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
  const timeline = page.locator('section[aria-labelledby="session-timeline"]');
  const initialTimeline = await timeline.elementHandle();
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await expect(page.locator('[data-session-detail-fixture]')).toHaveAttribute('data-pending', 'true');
  await expect(timeline).toBeVisible();
  await expect(page.getByText('Updating local history. Showing the previous report revision.')).toBeVisible();
  await expect(page.locator('[data-session-analysis-item="consistency-meta"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Release detail', exact: true }).click();
  await expect(page.locator('[data-session-analysis-item="consistency-meta"]')).toBeVisible();
  expect(await initialTimeline?.evaluate((element) => element.isConnected)).toBe(true);
});

test('does not carry history or expanded prompts into another session', async ({ page }) => {
  const rail = page.getByRole('list', { name: 'Rounds', exact: true });
  await rail.locator('button').nth(1).click();
  await page.getByRole('button', { name: CONTINUE_READING }).click();
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await page.getByRole('button', { name: 'Release detail', exact: true }).click();
  await page.getByRole('button', { name: 'Select other session', exact: true }).click();
  await expect(page.locator('[data-session-detail-fixture]')).toHaveAttribute('data-pending', 'true');
  await expect(rail).toHaveCount(0);
  await page.getByRole('button', { name: 'Release detail', exact: true }).click();
  await expect(rail.locator(SELECTED_ROUND)).toContainText('Round 1:');
  await expect(page.getByRole('button', { name: CONTINUE_READING })).toBeVisible();
});

test('restores the reading position after a visible refresh error and retry', async ({ page }) => {
  const rail = page.getByRole('list', { name: 'Rounds', exact: true });
  await rail.locator('button').nth(1).click();
  await page.getByRole('button', { name: CONTINUE_READING }).click();
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await expect(page.locator('[data-session-detail-fixture]')).toHaveAttribute('data-pending', 'true');
  await page.getByRole('button', { name: 'Fail detail', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[data-session-detail-fixture]')).toHaveAttribute('data-pending', 'true');
  await page.getByRole('button', { name: 'Release detail', exact: true }).click();
  await expect(rail.locator(SELECTED_ROUND)).toContainText('Round 2:');
  await expect(page.getByRole('button', { name: 'Show the opening only' })).toBeVisible();
});

test('restores the outer reading scroll after visiting another tab', async ({ page }) => {
  await page.getByRole('button', { name: CONTINUE_READING }).click();
  const body = page.locator('[data-session-drawer-body]');
  await body.evaluate((element) => {
    element.scrollTop = 150;
  });
  expect(await body.evaluate((element) => element.scrollTop)).toBe(150);
  await page.getByRole('tab', { name: 'Summary', exact: true }).evaluate((element) => {
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error('Expected a tab button');
    }
    element.click();
  });
  await page.getByRole('tab', { name: ROUNDS_TAB }).click();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(150);
});
