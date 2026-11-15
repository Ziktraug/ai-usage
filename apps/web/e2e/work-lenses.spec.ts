import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './browser-test';

// Stable seeds of the process fixture; journeys in other specs add their own tasks beside them.
const ids = {
  payments: '12000000-0000-4000-8000-000000000001',
  tests: '12000000-0000-4000-8000-000000000002',
  uploads: '12000000-0000-4000-8000-000000000005',
};
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const EXAMPLE_SHOP = /Example shop/;
const SOME_TEXT = /\S/;
const PRIMARY_CHECKOUT = '/synthetic/example-shop';
const WORKTREE_CHECKOUT = '/synthetic/example-shop/.claude/worktrees/uploads';
const OTHER_REPOSITORY_CHECKOUT = '/synthetic/ai-usage';

const LENSES = [
  { view: 'lanes', label: 'Lanes', heading: 'One thread per task.' },
  { view: 'pilot', label: 'Pilot', heading: 'My work' },
  { view: 'timeline', label: 'Timeline', heading: 'One thread per task.' },
  { view: 'disk', label: 'Disk', heading: 'Checkouts on this machine' },
] as const;
type Lens = (typeof LENSES)[number];

const openWork = async (page: Page, search = ''): Promise<void> => {
  await page.goto(`/work${search}`);
  await expect(page.locator('[data-work-threads][data-work-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
};
const switcher = (page: Page): Locator => page.getByRole('navigation', { name: 'Work views', exact: true });
const lensLink = (page: Page, label: string): Locator => switcher(page).getByRole('link', { name: label, exact: true });
const param = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);
const assertAxe = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
};
const pane = (page: Page): Locator => page.getByRole('complementary', { name: 'Task detail', exact: true });
const lanesRow = (page: Page, threadId: string): Locator => page.locator(`article[data-work-thread="${threadId}"]`);
const timeline = (page: Page): Locator => page.getByRole('region', { name: 'Tasks on a time axis', exact: true });

/** What each lens draws once its own read has answered. */
const lensContent = (page: Page, lens: Lens): Locator => {
  switch (lens.view) {
    case 'lanes':
      return lanesRow(page, ids.payments);
    case 'pilot':
      return page.locator(`li[data-work-thread="${ids.payments}"]`);
    case 'timeline':
      return timeline(page).getByRole('button', { name: EXAMPLE_SHOP }).first();
    default:
      return page.locator(`tr[data-disk-checkout="${PRIMARY_CHECKOUT}"]`);
  }
};

const expectLens = async (page: Page, lens: Lens): Promise<void> => {
  await expect(page.getByRole('heading', { level: 1, name: lens.heading, exact: true })).toBeVisible();
  await expect(lensContent(page, lens)).toBeVisible();
  // One switcher, whatever the lens, with exactly one current link.
  await expect(switcher(page)).toHaveCount(1);
  await expect(switcher(page).getByRole('link')).toHaveText(LENSES.map((item) => item.label));
  await expect(switcher(page).locator('[aria-current]')).toHaveCount(1);
  await expect(lensLink(page, lens.label)).toHaveAttribute('aria-current', 'page');
  expect(param(page, 'view')).toBe(lens.view === 'lanes' ? null : lens.view);
};

test('one switcher reaches the four lenses, marks the current one and keeps the filters', async ({ page }) => {
  const [lanes, pilot, chronology, disk] = LENSES;
  await openWork(page, '?project=Example+shop');
  await expectLens(page, lanes);
  // Real links: a new tab or a copied address lands on the same lens with the same filters.
  await expect(lensLink(page, 'Lanes')).toHaveAttribute('href', '/work?project=Example+shop');
  await expect(lensLink(page, 'Pilot')).toHaveAttribute('href', '/work?project=Example+shop&view=pilot');
  await expect(lensLink(page, 'Timeline')).toHaveAttribute('href', '/work?project=Example+shop&view=timeline');
  await expect(lensLink(page, 'Disk')).toHaveAttribute('href', '/work?project=Example+shop&view=disk');
  await assertAxe(page);
  for (const lens of [pilot, chronology, disk, lanes]) {
    await lensLink(page, lens.label).click();
    await expectLens(page, lens);
    expect(param(page, 'project')).toBe('Example shop');
    await assertAxe(page);
  }
  // The keyboard reaches the switch like any other link.
  await lensLink(page, 'Disk').focus();
  await page.keyboard.press('Enter');
  await expectLens(page, disk);
  await page.goBack();
  await expectLens(page, lanes);
});

test('an unknown view shows the lanes, and a switch drops what another lens would misread', async ({ page }) => {
  const [lanes] = LENSES;
  await openWork(page, '?view=somewhere');
  await expect(page.getByRole('heading', { level: 1, name: lanes.heading, exact: true })).toBeVisible();
  await expect(lanesRow(page, ids.payments)).toBeVisible();
  await expect(lensLink(page, 'Lanes')).toHaveAttribute('aria-current', 'page');
  await expect(switcher(page).locator('[aria-current]')).toHaveCount(1);

  // The lanes rows can still be read by band; that grouping belongs to this lens and stays behind.
  await openWork(page, '?view=lanes&group=bands');
  await expect(lensLink(page, 'Lanes')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[aria-label="Yours tasks"]')).toBeVisible();
  await expect(lanesRow(page, ids.payments)).toBeVisible();
  await expect(lensLink(page, 'Timeline')).toHaveAttribute('href', '/work?view=timeline');

  // A band filter and an open task belong to the lens they were set in.
  await openWork(page, `?view=pilot&band=yours&q=payments&task=${ids.payments}&detail=side`);
  await expect(pane(page)).toBeVisible();
  await expect(lensLink(page, 'Pilot')).toHaveAttribute('aria-current', 'page');
  await expect(lensLink(page, 'Lanes')).toHaveAttribute('href', '/work?q=payments');
  await expect(lensLink(page, 'Disk')).toHaveAttribute('href', '/work?view=disk&q=payments');
});

test('the Timeline lens draws project lanes and answers the keyboard', async ({ page }) => {
  await openWork(page, '?view=timeline');
  const board = timeline(page);
  await expect(board).toBeVisible();
  await expect(page.locator('.wtl-status')).toContainText('tasks');
  const lane = board.getByRole('region', { name: EXAMPLE_SHOP }).first();
  const toggle = lane.locator('.wtl-lane-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(board.locator('.wtl-task')).toHaveCount(0);
  await assertAxe(page);

  // A lane unfolds from the keyboard, and the URL remembers it.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
  expect(param(page, 'open')).not.toBeNull();
  const task = lane.locator(`.wtl-task[data-work-thread="${ids.payments}"]`);
  await expect(task).toBeVisible();
  await expect(task.getByRole('img').first()).toHaveAttribute('aria-label', SOME_TEXT);

  // Zooms are pressed buttons; the window they set is written to the URL.
  const zoom = page.getByRole('group', { name: 'Zoom', exact: true });
  const week = zoom.getByRole('button', { name: '7 d', exact: true });
  await week.focus();
  await page.keyboard.press('Enter');
  await expect(week).toHaveAttribute('aria-pressed', 'true');
  await expect(zoom.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect.poll(() => param(page, 'from')).toMatch(DAY_KEY);
  const weekFrom = param(page, 'from');
  const weekTo = param(page, 'to');
  expect(weekTo).toMatch(DAY_KEY);

  // The brush handles are sliders: an arrow moves one edge by a day and leaves the other.
  const start = page.getByRole('slider', { name: 'Window start', exact: true });
  const before = Number(await start.getAttribute('aria-valuenow'));
  await start.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(start).toHaveAttribute('aria-valuenow', String(before - 1));
  await expect.poll(() => param(page, 'from')).not.toBe(weekFrom);
  expect(param(page, 'to')).toBe(weekTo);
  await expect(start).toBeFocused();
  // Eight days are no named zoom.
  await expect(zoom.locator('[aria-pressed="true"]')).toHaveCount(0);

  // The window moves as a whole, and refuses to leave the range without losing the focus.
  const moves = page.getByRole('group', { name: 'Move the window', exact: true });
  const later = moves.getByRole('button', { name: 'Later ›', exact: true });
  await expect(later).toHaveAttribute('aria-disabled', 'true');
  const earlier = moves.getByRole('button', { name: '‹ Earlier', exact: true });
  await earlier.focus();
  await page.keyboard.press('Enter');
  await expect(later).toHaveAttribute('aria-disabled', 'false');
  await expect.poll(() => param(page, 'to')).not.toBe(weekTo);
  await expect(earlier).toBeFocused();
  await assertAxe(page);
  await later.focus();
  await page.keyboard.press('Enter');
  await expect(later).toHaveAttribute('aria-disabled', 'true');
  await expect.poll(() => param(page, 'to')).toBe(weekTo);
  await expect(task).toBeVisible();

  // A task opens as a full page; the way back restores the window, the open lane and the focus.
  const window = { from: param(page, 'from'), to: param(page, 'to'), open: param(page, 'open') };
  const title = task.getByRole('link', { name: 'Prevent duplicate payments', exact: true });
  await title.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Prevent duplicate payments', exact: true })).toBeVisible();
  await expect(pane(page)).toHaveCount(0);
  expect(param(page, 'view')).toBe('timeline');
  expect(param(page, 'detail')).toBeNull();
  await page.getByRole('link', { name: '← My work', exact: true }).click();
  await expect(board).toBeVisible();
  await expect(title).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect({ from: param(page, 'from'), to: param(page, 'to'), open: param(page, 'open') }).toEqual(window);
  await expect(lensLink(page, 'Timeline')).toHaveAttribute('aria-current', 'page');
});

test('the Disk lens lists each checkout once, in a table read by row and column', async ({ page }) => {
  await openWork(page, '?view=disk');
  await expect(page.getByRole('heading', { level: 1, name: 'Checkouts on this machine', exact: true })).toBeVisible();
  const checkouts = page.locator('tr[data-disk-checkout]');
  await expect(checkouts).toHaveCount(3);
  for (const path of [PRIMARY_CHECKOUT, WORKTREE_CHECKOUT, OTHER_REPOSITORY_CHECKOUT]) {
    await expect(page.locator(`tr[data-disk-checkout="${path}"]`)).toHaveCount(1);
  }
  await expect(page.locator('.wd-summary')).toContainText('3 checkouts');
  await expect(page.locator('.wd-summary')).toContainText('2 repositories');
  await expect(
    page.getByRole('navigation', { name: 'Checkout groups', exact: true }).getByRole('link'),
  ).not.toHaveCount(0);

  // Two tasks name the main checkout: one row, both tasks in it.
  const primary = page.locator(`tr[data-disk-checkout="${PRIMARY_CHECKOUT}"]`);
  const table = page.getByRole('table').filter({ has: primary });
  await expect(table.getByRole('columnheader')).toHaveText([
    'Checkout',
    'Branch',
    'Task',
    'Pull request',
    'Disk state',
    'Last session',
    'Observed',
  ]);
  await expect(primary.getByRole('rowheader')).toContainText('example-shop');
  await expect(primary.getByRole('link', { name: 'Prevent duplicate payments', exact: true })).toBeVisible();
  await expect(primary.getByRole('link', { name: 'Bring the E2E tests up to date', exact: true })).toBeVisible();
  await expect(primary.locator('.wd-state')).toHaveText(SOME_TEXT);
  const worktree = page.locator(`tr[data-disk-checkout="${WORKTREE_CHECKOUT}"]`);
  await expect(worktree).toContainText('fix/SHOP-2086/uploads');
  await expect(worktree.locator('.wd-tag')).toHaveText('worktree');
  await expect(primary.locator('.wd-tag')).toHaveText('main checkout');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await assertAxe(page);

  // A task link keeps the lens: the full page comes back to this table.
  const task = worktree.getByRole('link').first();
  await expect(task).toHaveAttribute('href', `/work?view=disk&task=${ids.uploads}`);
  await task.click();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Checkouts on this machine');
  await expect(pane(page)).toHaveCount(0);
  expect(param(page, 'task')).toBe(ids.uploads);
  expect(param(page, 'view')).toBe('disk');
  await page.getByRole('link', { name: '← My work', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Checkouts on this machine', exact: true })).toBeVisible();
  await expect(checkouts).toHaveCount(3);
  await expect(lensLink(page, 'Disk')).toHaveAttribute('aria-current', 'page');
});

test('a plain click opens the task beside the lanes, arrows move the selection, Escape closes and returns the focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1680, height: 1050 });
  await openWork(page);
  const row = lanesRow(page, ids.payments);
  const title = row.locator('.wt-task-title');
  await expect(page.locator('[data-work-thread][aria-current]')).toHaveCount(0);
  await title.click();
  await expect(pane(page).getByRole('heading', { level: 2, name: 'Prevent duplicate payments' })).toBeVisible();
  expect(param(page, 'task')).toBe(ids.payments);
  expect(param(page, 'detail')).toBe('side');
  // The list is still the page: its heading and its rows stay, and the row of the task is current.
  await expect(page.getByRole('heading', { level: 1, name: 'One thread per task.', exact: true })).toBeVisible();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('[data-work-thread][aria-current="true"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The sessions are a cascade in the pane too.
  await expect(pane(page).locator('.wt-journal')).toHaveAttribute('data-history-layout', 'cascade');
  await expect(pane(page).getByRole('tree').first()).toBeVisible();
  await assertAxe(page);

  // Down moves to the next task shown and the pane follows; Up comes back.
  const rows = page.locator('article[data-work-thread]');
  const index = await rows.evaluateAll(
    (items, id) => items.findIndex((item) => item.getAttribute('data-work-thread') === id),
    ids.payments,
  );
  const below = rows.nth(index + 1);
  const belowId = await below.getAttribute('data-work-thread');
  await title.focus();
  await page.keyboard.press('ArrowDown');
  await expect(below.locator('.wt-task-title')).toBeFocused();
  await expect(below).toHaveAttribute('aria-current', 'true');
  await expect(row).not.toHaveAttribute('aria-current', 'true');
  expect(param(page, 'task')).toBe(belowId);
  await page.keyboard.press('ArrowUp');
  await expect(title).toBeFocused();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(pane(page).getByRole('heading', { level: 2, name: 'Prevent duplicate payments' })).toBeVisible();

  // Activating the task already shown moves the keyboard into its pane; Escape brings it back.
  await page.keyboard.press('Enter');
  await expect(pane(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pane(page)).toHaveCount(0);
  expect(param(page, 'task')).toBeNull();
  expect(param(page, 'detail')).toBeNull();
  await expect(title).toBeFocused();
  await expect(page.locator('[data-work-thread][aria-current]')).toHaveCount(0);

  // The close control does the same, and one Back never walks through the tasks that were selected.
  await title.click();
  await expect(pane(page)).toBeVisible();
  await pane(page).getByRole('link', { name: 'Close task detail', exact: true }).click();
  await expect(pane(page)).toHaveCount(0);
  await expect(title).toBeFocused();
});

test('a modified click and the pane’s own link open the task as a full page', async ({ page, context }) => {
  await openWork(page);
  const title = lanesRow(page, ids.payments).locator('.wt-task-title');
  await expect(title).toHaveAttribute('href', `/work?task=${ids.payments}`);
  const [tab] = await Promise.all([context.waitForEvent('page'), title.click({ modifiers: ['ControlOrMeta'] })]);
  await expect(tab.getByRole('heading', { level: 1, name: 'Prevent duplicate payments', exact: true })).toBeVisible();
  expect(new URL(tab.url()).searchParams.get('task')).toBe(ids.payments);
  expect(new URL(tab.url()).searchParams.has('detail')).toBe(false);
  await expect(tab.getByRole('complementary', { name: 'Task detail', exact: true })).toHaveCount(0);
  await tab.close();
  // The page that was clicked did not move.
  await expect(pane(page)).toHaveCount(0);
  expect(param(page, 'task')).toBeNull();

  await title.click();
  const full = pane(page).getByRole('link', { name: 'Open full page', exact: true });
  await expect(full).toHaveAttribute('href', `/work?task=${ids.payments}`);
  await full.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Prevent duplicate payments', exact: true })).toBeVisible();
  await expect(pane(page)).toHaveCount(0);
  expect(param(page, 'detail')).toBeNull();
  // Back from the full page is the list, with the focus on the row it was opened from.
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'One thread per task.', exact: true })).toBeVisible();
  await expect(pane(page)).toHaveCount(0);
  await expect(title).toBeFocused();
});
