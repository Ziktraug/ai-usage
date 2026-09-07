import { expect, openHydratedReport, test } from './browser-test';

const FILTER_TOGGLE = /^Filters/;

test('mobile filters retain their selection when folded and remain available on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHydratedReport(page);
  const toggle = page.getByRole('button', { name: FILTER_TOGGLE });
  const harness = page.getByRole('button', { name: 'Filter by harness', exact: true });
  await expect(harness).toBeHidden();
  await toggle.click();
  await harness.click();
  await page.getByRole('dialog', { name: 'Harness', exact: true }).getByTitle('Codex', { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(toggle).toContainText('1');
  const selectedUrl = page.url();
  await toggle.click();
  await expect(harness).toBeHidden();
  expect(page.url()).toBe(selectedUrl);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(harness).toBeVisible();
  await expect(toggle).toBeHidden();
  expect(page.url()).toBe(selectedUrl);
});

test('custom period labels stay beside their own field on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHydratedReport(page);
  await page.getByRole('button', { name: 'Choose a custom report period', exact: true }).click();
  for (const edge of ['from', 'to']) {
    const label = page.locator(`label[for="report-period-${edge}"] > span`);
    const input = page.locator(`#report-period-${edge}`);
    const [labelBox, inputBox] = await Promise.all([label.boundingBox(), input.boundingBox()]);
    if (!(labelBox && inputBox)) {
      throw new Error('Date label and input must expose geometry');
    }
    expect(labelBox.y).toBeGreaterThanOrEqual(inputBox.y);
    expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(inputBox.y + inputBox.height);
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(390);
  }
});

test('skill placement paths fit between identity and action on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/skills/global/alpha-skill');
  const rows = page.locator('[data-skill-drawer-placement]');
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const [path, action] = await Promise.all([
      row.locator(':scope > :nth-child(2)').boundingBox(),
      row.locator(':scope > :nth-child(3)').boundingBox(),
    ]);
    if (!(path && action)) {
      throw new Error('Placement path and action must expose geometry');
    }
    expect(path.y).toBeGreaterThanOrEqual(action.y + action.height);
  }
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`discard confirmation stays in the viewport after scrolling the skill editor at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/skills/global/alpha-skill');
    const editor = page.getByRole('textbox', { name: 'alpha-skill SKILL.md', exact: true });
    await editor.fill('# alpha-skill\n\nUnsaved UI regression draft.');
    await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const box = await dialog.boundingBox();
    if (!box) {
      throw new Error('Discard confirmation must expose geometry');
    }
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    const keep = dialog.getByRole('button', { name: 'Keep editing' });
    await expect(keep).toBeFocused();
    await keep.click();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue('# alpha-skill\n\nUnsaved UI regression draft.');
    await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
    await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'alpha-skill detail' })).toBeVisible();
    await expect(editor).not.toHaveValue('# alpha-skill\n\nUnsaved UI regression draft.');
  });
}
