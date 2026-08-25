import type { Locator, Page } from '@playwright/test';
import { expect, openHydratedReport, test } from './browser-test';

const PIXEL_TOLERANCE = 1;
const ZAG_OVERFLOW_PADDING = 8;

const filterTrigger = (page: Page, name: 'harness' | 'machine' | 'origin'): Locator =>
  page.getByRole('button', { name: `Filter by ${name}` });

const openFilter = async (
  page: Page,
  name: 'harness' | 'machine' | 'origin',
  title: 'Harness' | 'Machine' | 'Session origin',
): Promise<{ dialog: Locator; trigger: Locator }> => {
  const trigger = filterTrigger(page, name);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
};

const expectAnchoredUnder = async (page: Page, trigger: Locator, dialog: Locator): Promise<void> => {
  const [dialogBox, triggerBox, layoutWidth] = await Promise.all([
    dialog.boundingBox(),
    trigger.boundingBox(),
    page.evaluate(() => Math.min(document.documentElement.clientWidth, document.documentElement.scrollWidth)),
  ]);
  if (!(dialogBox && triggerBox)) {
    throw new Error('Filter trigger and dialog must expose geometry');
  }

  const triggerBottom = triggerBox.y + triggerBox.height;
  expect(dialogBox.y + PIXEL_TOLERANCE).toBeGreaterThanOrEqual(triggerBottom);
  expect(dialogBox.y - triggerBottom).toBeLessThanOrEqual(ZAG_OVERFLOW_PADDING);
  expect(dialogBox.width + PIXEL_TOLERANCE).toBeGreaterThanOrEqual(triggerBox.width);

  const fitsToTheRight = triggerBox.x + dialogBox.width <= layoutWidth - ZAG_OVERFLOW_PADDING;
  if (fitsToTheRight) {
    expect(Math.abs(dialogBox.x - triggerBox.x)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  } else {
    expect(Math.abs(dialogBox.x + dialogBox.width - (layoutWidth - ZAG_OVERFLOW_PADDING))).toBeLessThanOrEqual(
      PIXEL_TOLERANCE,
    );
  }
};

test('focuses the report query with slash but never steals an IME composition', async ({ page }) => {
  await openHydratedReport(page);
  const search = page.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  await expect(search).toHaveAttribute('aria-keyshortcuts', '/');

  const overview = page.getByRole('link', { exact: true, name: 'Overview' });
  await overview.focus();
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, isComposing: true, key: '/' })),
  );
  await expect(overview).toBeFocused();

  await page.keyboard.press('/');
  await expect(search).toBeFocused();
});

test('presents a pressed All row for every neutral checkbox filter', async ({ page }) => {
  await openHydratedReport(page);
  for (const filter of [
    { all: 'All harnesses', name: 'harness', title: 'Harness' },
    { all: 'All origins', name: 'origin', title: 'Session origin' },
    { all: 'All machines', name: 'machine', title: 'Machine' },
  ] as const) {
    const { dialog } = await openFilter(page, filter.name, filter.title);
    await expect(dialog.getByRole('button', { name: filter.all })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
  }
});

test('shows and removes the active Origin filter without relying on Clear all', async ({ page }) => {
  await openHydratedReport(page);
  const { dialog } = await openFilter(page, 'origin', 'Session origin');
  await dialog.getByTitle('Human').click();

  const originPill = page.getByRole('button', { name: 'Origin: Human ×' });
  await expect(originPill).toBeVisible();
  await originPill.click();
  await expect(originPill).toHaveCount(0);
  expect(new URL(page.url()).searchParams.getAll('origin')).toEqual([]);
});

test('anchors every desktop filter dialog below its trigger at no less than trigger width', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await openHydratedReport(page);
  for (const filter of [
    { name: 'harness', title: 'Harness' },
    { name: 'origin', title: 'Session origin' },
    { name: 'machine', title: 'Machine' },
  ] as const) {
    const { dialog, trigger } = await openFilter(page, filter.name, filter.title);
    await expectAnchoredUnder(page, trigger, dialog);
    await page.keyboard.press('Escape');
  }
});

test('anchors shifted Origin and Machine dialogs below their narrow triggers at the viewport edge', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openHydratedReport(page);
  for (const filter of [
    { name: 'origin', title: 'Session origin' },
    { name: 'machine', title: 'Machine' },
  ] as const) {
    const { dialog, trigger } = await openFilter(page, filter.name, filter.title);
    await expectAnchoredUnder(page, trigger, dialog);
    await page.keyboard.press('Escape');
  }
});

test('renders the longest machine option on one visible unclipped line', async ({ page }) => {
  await openHydratedReport(page);
  const { dialog } = await openFilter(page, 'machine', 'Machine');
  const label = dialog.getByTitle('Fixture Machine Secondary · Freshness unavailable');
  expect(
    await label.evaluate(
      (element, tolerance) =>
        getComputedStyle(element).whiteSpace === 'nowrap' &&
        element.getClientRects().length === 1 &&
        element.scrollWidth <= element.clientWidth + tolerance,
      PIXEL_TOLERANCE,
    ),
  ).toBe(true);
});

test('keeps source status and its action in one bounded group at the 768px breakpoint', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 768 });
  await openHydratedReport(page);
  const actions = page.locator('[data-filter-actions]');
  await expect(actions).toBeVisible();
  await expect(actions.locator('[aria-label="Collection source status"]')).toHaveCount(1);
  const status = actions.getByRole('link', { name: 'Sources ready' });
  const runAll = actions.getByRole('button', { name: 'Run all' });
  await expect(status).toBeVisible();
  await expect(runAll).toBeVisible();
  const toolbar = page.locator('[data-dashboard-filter-stack]');
  const [actionsBox, statusBox, runAllBox, toolbarBox] = await Promise.all([
    actions.boundingBox(),
    status.boundingBox(),
    runAll.boundingBox(),
    toolbar.boundingBox(),
  ]);
  if (!(actionsBox && statusBox && runAllBox && toolbarBox)) {
    throw new Error('Toolbar actions must expose geometry');
  }
  expect(Math.abs((statusBox?.y ?? 0) - (runAllBox?.y ?? 0))).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  expect(Math.abs(actionsBox.x + actionsBox.width - (toolbarBox.x + toolbarBox.width))).toBeLessThanOrEqual(
    PIXEL_TOLERANCE,
  );
  expect(await actions.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
    await actions.evaluate((element) => element.clientWidth),
  );
});
