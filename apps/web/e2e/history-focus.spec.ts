import type { Locator, Page } from '@playwright/test';
import { expect, openHydratedReport, openHydratedSkills, test, waitForHydratedNavigation } from './browser-test';

/**
 * Back and Forward reset focus as they did with SvelteKit 2 (ADR 0005, ADR 0013): the focus
 * starting point returns to the page unless a component claims focus for the restored view.
 * SvelteKit 3 resets only across entries with different reset indexes, so the entries the app
 * pushes with `reset: false` are the ones this pins. The expectations were recorded against the
 * SvelteKit 2 build of the same commit.
 */
const STANDALONE_CARD_NAME = /^Review release notes /;
const STANDALONE_TITLE = 'Review release notes';
const ROOT_TITLE = 'Build forecast model';
const OPEN_ROOT_SESSION_NAME = new RegExp(`^Open session ${ROOT_TITLE}(?:\\s|$)`);
const OPEN_BUILD_REPORT_UI_NAME = /^Open details for Build report UI\./;

const agentMap = (page: Page): Locator => page.getByRole('region', { name: 'Agent Map', exact: true });

/** The focused element once the traversal has rendered: `body` when nothing holds focus. */
const settledFocus = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const element = document.activeElement;
    if (element === null || element === document.body) {
      return 'body';
    }
    return `${element.tagName.toLowerCase()} ${element.textContent?.replace(/\s+/g, ' ').trim() ?? ''}`;
  });

const openCampaigns = async (page: Page): Promise<void> => {
  await page.goto('/campaigns');
  await waitForHydratedNavigation(page);
  await expect(agentMap(page).getByRole('heading', { name: ROOT_TITLE, exact: true })).toBeVisible();
};

test('Back and Forward across a campaign selection reset focus to the page', async ({ page }) => {
  await openCampaigns(page);
  const card = page
    .getByRole('region', { name: 'Recent campaigns', exact: true })
    .getByRole('button', { name: STANDALONE_CARD_NAME });
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(agentMap(page).getByRole('heading', { name: STANDALONE_TITLE, exact: true })).toBeVisible();
  await expect(card).toBeFocused();

  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('selectedCampaign')).toBeNull();
  await expect(agentMap(page).getByRole('heading', { name: ROOT_TITLE, exact: true })).toBeVisible();
  await expect.poll(() => settledFocus(page)).toBe('body');

  await card.focus();
  await page.goForward();
  await expect(agentMap(page).getByRole('heading', { name: STANDALONE_TITLE, exact: true })).toBeVisible();
  await expect.poll(() => settledFocus(page)).toBe('body');
});

test('Back across a kept-focus Analysis tab change resets focus to the page', async ({ page }) => {
  await openHydratedReport(page, '/?tab=harnesses');
  const tabs = page.getByRole('tablist', { name: 'Analysis dimension' });
  const harnesses = tabs.getByRole('tab', { name: 'Harnesses & providers' });
  const models = tabs.getByRole('tab', { name: 'Models' });
  await expect(harnesses).toHaveAttribute('aria-selected', 'true');
  await models.focus();
  await page.keyboard.press('Enter');
  await expect(models).toHaveAttribute('aria-selected', 'true');
  await expect(models).toBeFocused();

  await page.goBack();
  await expect(harnesses).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => settledFocus(page)).toBe('body');
});

test('Back across a Memory filter resets focus to the page', async ({ page }) => {
  await page.goto('/memory?view=analyses');
  await waitForHydratedNavigation(page);
  await page.getByLabel('Search session accounts').fill('history focus');
  const apply = page.getByRole('button', { name: 'Apply filters', exact: true });
  await apply.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('history focus');
  await expect(apply).toBeFocused();

  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBeNull();
  await expect.poll(() => settledFocus(page)).toBe('body');
});

test('Back from a campaign session drawer returns focus to the session that opened it', async ({ page }) => {
  await openCampaigns(page);
  const trigger = agentMap(page).getByRole('button', { name: OPEN_ROOT_SESSION_NAME });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer).toBeVisible();

  await page.goBack();
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Back from a report session drawer returns focus to the row that opened it', async ({ page }) => {
  await openHydratedReport(page, '/?origin=%5B%5D');
  const trigger = page.getByRole('button', { name: OPEN_BUILD_REPORT_UI_NAME });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer).toBeVisible();

  await page.goBack();
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Back to a skill drawer focuses the drawer it reopens', async ({ page }) => {
  await openHydratedSkills(page, '/skills');
  const link = page
    .locator('[data-worktable-row="alpha-skill"]')
    .getByRole('link', { exact: true, name: 'alpha-skill' });
  await link.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'alpha-skill detail' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(link).toBeFocused();

  await page.goBack();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Close skill detail' })).toBeFocused();
});
