import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './browser-test';

/**
 * These regressions exercise the synthetic Work demo without RPC reads.
 * The replayed collector fixture and the production path have separate browser suites.
 */
test.use({ extraHTTPHeaders: { 'x-ai-usage-sveltekit-mode': 'demo' } });

const SYNTHETIC_ROOTS = 28;
const BLOCKED_TITLE = 'Fix mobile navigation label overlap';
const BLOCKED_QUESTION = 'Which of the two 320px layouts do you prefer?';
const JOINED_TITLE = 'Build report UI';
const RETAINED_TITLE = 'Release checklist';
const RETAINED_QUESTION = 'Fix the flaky export test before the release, or skip it?';
const KNOWN_WAITS_PATTERN = /Known waits/;
const NEEDS_YOU_CHIP_PATTERN = /^Needs you/;
const CLAUDE_CHIP_PATTERN = /^Claude/;

const waitForHydratedWork = async (page: Page): Promise<void> => {
  await expect(page.locator('main[data-route-shell="work"][data-work-hydrated="true"]')).toBeVisible({
    timeout: 15_000,
  });
};
const rowNamed = (page: Page, title: string): Locator =>
  page.locator('[data-work-root]').filter({ has: page.getByText(title, { exact: true }) });
const expectNoOverflow = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
};
const expectAxeClean = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
};
/** Overlay animations blend colours while they run; axe reads the settled frame. */
const settleAnimations = async (page: Page): Promise<void> => {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
};
const trackPosts = (page: Page): string[] => {
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') {
      posts.push(new URL(request.url()).pathname);
    }
  });
  return posts;
};

test('desktop arrival is informative, searchable, keyboard-navigable and keeps the simulation inside the detail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const posts = trackPosts(page);
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work', exact: true })).toBeVisible();
  await expect(main.locator('[data-work-coverage]')).toContainText('39 of 41 files parsed');
  await expect(main.locator('[data-work-coverage] [data-work-harness-coverage="codex"]')).toHaveText(
    'Codex · sessions only, no declared waits: 1 of 1 Codex campaign shown, active in the last 30 days (served report)',
  );
  for (const name of [
    'Needs you',
    'Waiting on others',
    'Leads',
    'Recent · no pending declaration read',
    'Codex · no declared wait read',
  ]) {
    await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  await expect(main.locator('[data-work-section="human-request"] [data-work-root]')).toHaveCount(9);
  // A question a later pull request may have answered stays in "Needs you", after the current
  // blocks and marked; one untouched for more than a week follows it, dated (ADR 0056 age tier).
  const toReconsider = main.locator('[data-work-section="human-request"] [data-work-reconsider] [data-work-root]');
  await expect(toReconsider).toHaveCount(4);
  // A completed child does not settle the parent's question: it remains first among older requests.
  const retained = rowNamed(page, RETAINED_TITLE);
  await expect(toReconsider.first()).toContainText(RETAINED_TITLE);
  await expect(retained).toContainText(RETAINED_QUESTION);
  await expect(retained).toHaveAttribute('data-work-standing', 'reconsider');
  await expect(retained.locator('[data-work-decision]')).toHaveCount(0);
  await expect(retained).not.toContainText('Handled in a linked session');
  await expect(toReconsider.nth(2)).toContainText('Scan resource optimization');
  await expect(toReconsider.nth(2)).toContainText('possibly answered');
  await expect(toReconsider.last()).toContainText('Session distillation worker redaction');
  await expect(toReconsider.last()).toContainText('blocked · 9 d ago, no activity since');
  await expect(main.locator('[data-work-section="none"] [data-work-root]')).toHaveCount(10);
  await expect(main.locator('[data-work-section="not-observable"] [data-work-root]')).toHaveCount(1);
  await expect(main.getByText(KNOWN_WAITS_PATTERN)).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Simulate review assignment' })).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Run simulation' })).toHaveCount(0);
  await expect(main.getByText('Declared by the session; current state unobserved.')).toHaveCount(3);
  await expect(main.getByRole('status').filter({ hasText: `${SYNTHETIC_ROOTS} roots shown` })).toBeVisible();
  await expect(main.locator('summary').filter({ hasText: 'Sources and limits' })).toBeVisible();
  await expect(main.locator('details[data-work-sources]')).not.toHaveAttribute('open', '');
  await expect(main.locator('details[data-work-served-roots]')).not.toHaveAttribute('open', '');

  // Search narrows the sections and lands in the address.
  await page.getByRole('searchbox').fill('mobile navigation');
  await expect(main.getByRole('status').filter({ hasText: `1 of ${SYNTHETIC_ROOTS} roots match,` })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('mobile navigation');
  const blocked = rowNamed(page, BLOCKED_TITLE);
  await expect(blocked).toHaveCount(1);
  await expect(blocked).toContainText('blocked · 26 h ago');
  await expect(blocked).toContainText('PR #71 checks pending');

  // The detail opens beside the list with the declaration, its exact date and the grouped facts.
  await blocked.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBe('desk-mobile-nav');
  const aside = main.locator('[data-work-aside]');
  await expect(aside.locator('[data-work-detail]')).toBeVisible();
  await expect(aside.locator('[data-work-question]')).toContainText(BLOCKED_QUESTION);
  await expect(aside).toContainText('Declared by the session at Jun 10, 2026, 10:00 UTC');
  await expect(aside.getByRole('heading', { level: 3, name: 'Facts by source' })).toBeVisible();
  await expect(aside).toContainText('GitHub');
  await expect(aside).toContainText('Local checkout');
  await expect(aside.getByRole('heading', { level: 3, name: 'Review this work' })).toBeVisible();
  await expect(aside.getByRole('button', { name: 'Run simulation' })).toHaveCount(0);
  await expect(aside).toContainText('No collected transcript identifies a review target');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectAxeClean(page);

  // Closing travels back: the filter and the scroll position survive, focus returns to the row.
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBeNull();
  expect(new URL(page.url()).searchParams.get('q')).toBe('mobile navigation');
  await expect(aside.locator('[data-work-detail]')).toHaveCount(0);
  await expect(blocked).toBeFocused();

  // Keyboard: arrows move between rows, Enter opens, Escape closes and restores focus.
  await page.getByRole('searchbox').fill('');
  await expect(main.getByRole('status').filter({ hasText: `${SYNTHETIC_ROOTS} roots shown` })).toBeVisible();
  const first = main.locator('[data-work-section="human-request"] [data-work-root]').nth(0);
  const second = main.locator('[data-work-section="human-request"] [data-work-root]').nth(1);
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(second).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(aside.locator('[data-work-detail]')).toBeVisible();
  await expect(first).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(aside.locator('[data-work-detail]')).toHaveCount(0);
  await expect(first).toBeFocused();

  await main.locator('[data-work-section="none"] button', { hasText: 'Show all 11' }).click();
  await expect(main.locator('[data-work-section="none"] [data-work-root]')).toHaveCount(11);

  // The simulation belongs to one understood target: a root joined to a collected Session. The
  // joined demo root is a Codex session: its wait is unknown, and it is still a review target.
  const joined = rowNamed(page, JOINED_TITLE);
  await expect(main.locator('[data-work-section="not-observable"]').locator(joined)).toHaveCount(1);
  await expect(joined).toContainText('wait unknown · not declared by Codex');
  await joined.click();
  await expect(aside).toContainText('Request · Unknown — not declared by this harness');
  await expect(aside).toContainText(`Choose an executor for a read-only review of “${JOINED_TITLE}”`);
  await expect(aside.getByRole('link', { name: 'Open session detail' })).toBeVisible();
  await aside.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await expect(aside.getByRole('region', { name: 'Routing result' })).toContainText('Chosen: Claude Code');
  await expect(aside.getByRole('region', { name: 'Routing result' })).toContainText('No execution was started');
  await expect(main.getByRole('button', { name: 'Run simulation' })).toHaveCount(1);
  expect(posts).toEqual([]);
  await expectAxeClean(page);
});

test('a direct address restores the filters and the selected root, and the detail links to the session', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/work?attention=human-request&harness=claude&root=desk-mobile-nav');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  const filters = main.locator('[data-work-filters]');
  await expect(filters.getByRole('button', { name: NEEDS_YOU_CHIP_PATTERN })).toHaveAttribute('aria-pressed', 'true');
  await expect(filters.getByRole('button', { name: CLAUDE_CHIP_PATTERN })).toHaveAttribute('aria-pressed', 'true');
  await expect(main.locator('[data-work-root]')).toHaveCount(9);
  await expect(rowNamed(page, RETAINED_TITLE)).toContainText(RETAINED_QUESTION);
  await expect(rowNamed(page, RETAINED_TITLE)).toHaveAttribute('data-work-standing', 'reconsider');
  await expect(main.locator('[data-work-aside] [data-work-question]')).toContainText(BLOCKED_QUESTION);
  await expect(rowNamed(page, BLOCKED_TITLE)).toHaveAttribute('aria-current', 'true');
  await main.getByRole('button', { name: 'Clear filters', exact: true }).click();
  // The retained release question adds one visible request; Recent remains folded at ten.
  await expect(main.locator('[data-work-root]')).toHaveCount(27);
  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBe('desk-mobile-nav');
  await main.getByRole('button', { name: 'Close detail', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBeNull();
  await expect(rowNamed(page, BLOCKED_TITLE)).toBeFocused();
});

test('mobile keeps the list readable and opens the detail as a drawer without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const posts = trackPosts(page);
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work', exact: true })).toBeVisible();
  await expect(
    page.locator('[data-app-navigation="mobile"]').getByRole('link', { name: 'Work', exact: true }),
  ).toBeVisible();
  await expect(main.locator('[data-work-aside]')).toBeHidden();
  await expectNoOverflow(page);
  await expectAxeClean(page);
  await rowNamed(page, BLOCKED_TITLE).click();
  const dialog = page.getByRole('dialog', { name: 'Selected root', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-work-question]')).toContainText(BLOCKED_QUESTION);
  await expect(dialog.getByRole('heading', { level: 3, name: 'Review this work' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close detail', exact: true })).toBeFocused();
  await settleAnimations(page);
  await expectNoOverflow(page);
  await expectAxeClean(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get('root')).toBeNull();
  expect(posts).toEqual([]);
});

for (const width of [768, 1279]) {
  test(`the ${width}px band keeps the rail and the detail placement coherent`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/work');
    await waitForHydratedWork(page);
    const main = page.getByRole('main');
    const rail = page.locator('[data-app-navigation="desktop"][data-hydrated="true"]');
    await expect(rail.getByRole('link', { name: 'Work', exact: true })).toHaveAttribute('aria-current', 'page');
    await expectNoOverflow(page);
    await rowNamed(page, BLOCKED_TITLE).click();
    if (width >= 1024) {
      await expect(main.locator('[data-work-aside] [data-work-detail]')).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } else {
      await expect(main.locator('[data-work-aside]')).toBeHidden();
      await expect(page.getByRole('dialog', { name: 'Selected root', exact: true })).toBeVisible();
    }
    await settleAnimations(page);
    await expectNoOverflow(page);
    await expectAxeClean(page);
  });
}

test('Work preserves disclosures opened by keyboard before hydration', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scriptsBlocked = Promise.withResolvers<void>();
  const releaseScripts = Promise.withResolvers<void>();
  // Hold the real application scripts so the early native gestures are deterministic.
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') {
      scriptsBlocked.resolve();
      await releaseScripts.promise;
    }
    await route.continue();
  });

  try {
    await page.goto('/work', { waitUntil: 'commit' });
    await scriptsBlocked.promise;
    const main = page.getByRole('main');
    await expect(main).toHaveAttribute('data-work-hydrated', 'false');
    // The resume sections are server-rendered and readable before any script runs.
    await expect(main.getByRole('heading', { level: 2, name: 'Needs you', exact: true })).toBeVisible();
    const served = main.locator('details[data-work-served-roots]');
    const servedSummary = served.locator('> summary');
    await expect(served).not.toHaveAttribute('open', '');
    await servedSummary.focus();
    await page.keyboard.press('Enter');
    await expect(served).toHaveAttribute('open', '');
    const card = served
      .locator('[data-work-session]')
      .filter({ hasText: 'related sessions and technical reviews' })
      .first();
    const related = card.locator('summary').filter({ hasText: 'related sessions and technical reviews' });
    const disclosure = related.locator('..');
    await expect(card).toHaveAttribute('data-work-hydrated', 'false');
    await related.focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.getByRole('list')).toHaveCount(0);

    releaseScripts.resolve();
    await expect(card).toHaveAttribute('data-work-hydrated', 'true');
    await expect(served).toHaveAttribute('open', '');
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.getByRole('list').getByRole('link').first()).toBeVisible();
  } finally {
    releaseScripts.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
