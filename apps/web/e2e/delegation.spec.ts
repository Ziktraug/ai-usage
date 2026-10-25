import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, waitForHydratedNavigation } from './browser-test';

const SAVE_SETTINGS_RPC_PATH = '/rpc/delegation/saveSettings';
/** The browser failure gate forgives a ≥ 400 answer that carries this header; see browser-test.ts. */
const EXPECTED_ERROR_HEADER = 'x-ai-usage-expected-error';
const STALE_REVISION = 'stale00000000000';
const SECTION_TABS = 'Delegation sections';

const waitForDelegation = async (page: Page): Promise<void> => {
  await expect(page.locator('main[data-delegation-hydrated="true"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-delegation-workbench]')).toBeVisible();
};

const documentOverflow = () =>
  Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - document.documentElement.clientWidth;

const expectNoAxeViolations = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.flatMap(({ target }) => target) }))).toEqual(
    [],
  );
};

test('reaches Delegation from the Manage rail with the keyboard and reads the route states', async ({ page }) => {
  await page.goto('/sources');
  await waitForHydratedNavigation(page);
  const manage = page.getByRole('complementary', { name: 'Application navigation' }).getByRole('navigation', {
    name: 'Manage destinations',
  });
  await manage.getByRole('link', { name: 'Sources', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(manage.getByRole('link', { name: 'Delegation', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/delegation');
  await waitForDelegation(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Delegation' })).toBeVisible();
  await expect(manage.getByRole('link', { name: 'Delegation', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('tab', { name: 'Routes and accounts' })).toHaveAttribute('aria-selected', 'true');
  const table = page.locator('[data-delegation-routes="table"]');
  await expect(table).toBeVisible();
  await expect(table).toContainText('Claude · personal');
  await expect(table).toContainText('Codex · work');
  await expect(table).toContainText('professional');
  // Codex exposes no account identity: the page says so instead of presenting the declaration as observed.
  await expect(table).toContainText('not observable');
  await expect(table).toContainText('observed now');
  const harnesses = page.locator('[data-delegation-harnesses]');
  await expect(harnesses).toContainText('OpenCode');
  await expect(harnesses).toContainText('executor not supported');
  await expect(harnesses).toContainText('no per-invocation read-only mode');
  await expect(harnesses).toContainText('any MCP client');
  await expect(page.getByText('never creates accounts and never handles provider secrets')).toBeVisible();
  await expect(page.locator('[data-delegation-form="executors"]')).toContainText('api (never admissible)');
});

test('saves a route context with an announcement and keeps the draft on a revision conflict', async ({ page }) => {
  await page.goto('/delegation');
  await waitForDelegation(page);
  const main = page.locator('main[data-route-shell="delegation"]');
  const revisionBefore = await main.getAttribute('data-delegation-revision');
  expect(revisionBefore).toBeTruthy();

  const form = page.locator('[data-delegation-form="route-annotations"]');
  const label = form.getByRole('textbox', { name: 'Label' }).first();
  await expect(label).toHaveValue('Claude · personal');
  await label.fill('Claude personal (edited)');
  await form.getByRole('button', { name: 'Save route contexts' }).click();
  await expect(form.getByRole('status')).toContainText('Saved. The configuration is now at revision');
  await expect.poll(() => main.getAttribute('data-delegation-revision')).not.toBe(revisionBefore);
  await expect(page.locator('[data-delegation-routes="table"]')).toContainText('Claude personal (edited)');
  await expect(label).toHaveValue('Claude personal (edited)');

  // The next save travels with a revision that is no longer the current one: the fixture answers the
  // conflict with the revision now on disk, and the page keeps the draft.
  let rewritten = false;
  await page.route(
    (url) => url.pathname === SAVE_SETTINGS_RPC_PATH,
    async (route) => {
      if (rewritten || route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      rewritten = true;
      const body = JSON.parse(route.request().postData() ?? '{}') as { json?: { expectedRevision?: string } };
      if (!body.json) {
        throw new Error('Expected an oRPC JSON envelope on the save request.');
      }
      body.json.expectedRevision = STALE_REVISION;
      const response = await route.fetch({ postData: JSON.stringify(body) });
      await route.fulfill({ headers: { ...response.headers(), [EXPECTED_ERROR_HEADER]: 'shell-route' }, response });
    },
  );
  await label.fill('Claude personal (conflicting edit)');
  await form.getByRole('button', { name: 'Save route contexts' }).click();
  const conflict = form.locator('[data-delegation-conflict]');
  await expect(conflict).toHaveAttribute('role', 'alert');
  await expect(conflict).toContainText('The configuration changed elsewhere (revision');
  await expect(conflict).toContainText('Reload to see it; your edits are kept below.');
  await expect(label).toHaveValue('Claude personal (conflicting edit)');
  expect(rewritten).toBe(true);
  await conflict.getByRole('button', { name: 'Reload settings' }).click();
  await expect(label).toHaveValue('Claude personal (conflicting edit)');
  await expect(form.getByRole('button', { name: 'Discard edits' })).toBeEnabled();
});

test('simulates a qualification, reads an exclusion and keeps the active section in the URL', async ({ page }) => {
  await page.goto('/delegation?section=rules');
  await waitForDelegation(page);
  const tabs = page.getByRole('tablist', { name: SECTION_TABS });
  await expect(tabs.getByRole('tab', { name: 'Rules' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-delegation-priority]')).toContainText(
    'context declared → forbid → restrict → require → preferences only order',
  );
  await expect(page.getByText('Three different identities')).toBeVisible();

  const simulator = page.locator('[data-delegation-form="simulator"]');
  await expect(simulator).toContainText('runs the same qualification as a start');
  await simulator.getByRole('textbox', { name: 'Checkout path' }).fill('/fixture/src/fixture-app');
  await simulator.getByRole('combobox', { name: 'Task category' }).selectOption('correctness');
  await simulator.getByRole('button', { name: 'Simulate qualification' }).click();
  const result = simulator.locator('[data-delegation-simulation]');
  await expect(result).toBeVisible({ timeout: 15_000 });
  await expect(result.locator('[data-delegation-applied-rules]')).toContainText('acme-no-codex');
  // The fixture forbids Codex for the owner acme: its route is excluded and the rule is named.
  const codex = result.locator('[data-delegation-excluded]').filter({ hasText: 'Codex · work' });
  await expect(codex).toHaveCount(1);
  await expect(codex).toContainText('forbidden-by-rule');
  await expect(codex).toContainText('Forbidden by rule acme-no-codex');
  await expect(result).toContainText('Valid until');
  await expect(result).toContainText('policy ');

  await tabs.getByRole('tab', { name: 'Rules' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL('/delegation?section=models');
  await expect(page.locator('[data-delegation-observed-models-note]')).toContainText('not a ranking');
  await expect(page.getByText('Operator declaration; never a measured performance.').first()).toBeVisible();
  await page.reload();
  await waitForDelegation(page);
  await expect(page.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
});

for (const theme of ['light', 'dark'] as const) {
  test(`Delegation is axe-clean without horizontal overflow in ${theme} at 1440 and 390 px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/delegation');
      await waitForDelegation(page);
      await expect(page.locator(`[data-delegation-routes="${width < 1024 ? 'cards' : 'table'}"]`)).toBeVisible();
      expect(await page.evaluate(documentOverflow)).toBeLessThanOrEqual(1);
      await expectNoAxeViolations(page);
      await page.getByRole('tablist', { name: SECTION_TABS }).getByRole('tab', { name: 'Rules' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Policy simulator' })).toBeVisible();
      expect(await page.evaluate(documentOverflow)).toBeLessThanOrEqual(1);
      await expectNoAxeViolations(page);
      await page.getByRole('tablist', { name: SECTION_TABS }).getByRole('tab', { name: 'Models' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Model catalog' })).toBeVisible();
      expect(await page.evaluate(documentOverflow)).toBeLessThanOrEqual(1);
      await expectNoAxeViolations(page);
    }
  });
}
