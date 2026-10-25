import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
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

/** The account scopes of the `delegation.routes[]` entries each save sent, in order. */
const recordSavedRouteScopes = (page: Page): string[][] => {
  const saved: string[][] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== SAVE_SETTINGS_RPC_PATH) {
      return;
    }
    const body = JSON.parse(request.postData() ?? '{}') as {
      json?: { delegation?: { routes?: { accountScope: string }[] } };
    };
    saved.push((body.json?.delegation?.routes ?? []).map((route) => route.accountScope));
  });
  return saved;
};

const expectTeamAnnotation = async (annotations: Locator): Promise<Locator> => {
  const team = annotations.locator('[data-delegation-route-annotation][data-delegation-route-declared="false"]');
  await expect(team).toHaveCount(1);
  await expect(team).toContainText('Codex · team');
  await expect(team.locator('[data-delegation-route-unresolved]')).toContainText(
    'No executor declaration resolves to this route',
  );
  await expect(team.getByRole('combobox', { name: 'Context' })).toHaveValue('professional');
  await expect(team.getByRole('textbox', { name: 'Label' })).toHaveValue('Codex · team');
  await expect(team.getByRole('textbox', { name: 'Reserve %' })).toHaveValue('35');
  await expect(team.getByRole('textbox', { name: 'Max concurrent' })).toHaveValue('2');
  return team;
};

// The fixture server keeps the settings in memory for the whole run: the tests that write them run
// one after the other, in one worker, so no save lands between another test's read and its save.
test.describe('settings writes', () => {
  test.describe.configure({ mode: 'serial' });

  test('a Models or Rules save restates an annotation no declaration resolves; only Routes removes it', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/delegation');
    await waitForDelegation(page);
    const annotations = page.locator('[data-delegation-form="route-annotations"]');
    await expectTeamAnnotation(annotations);
    // The declared routes stay what they were: the unresolved annotation is no route.
    await expect(annotations.locator('[data-delegation-route-annotation]')).toHaveCount(3);
    await expect(page.locator('[data-delegation-routes="table"]')).not.toContainText('team');

    const stamp = Date.now().toString(36);
    const savedScopes = recordSavedRouteScopes(page);
    const tabs = page.getByRole('tablist', { name: SECTION_TABS });
    await tabs.getByRole('tab', { name: 'Models' }).click();
    const models = page.locator('[data-delegation-form="models"]');
    await models.locator('[data-delegation-model="0"]').getByRole('textbox', { name: 'Note' }).fill(`Note ${stamp}`);
    await models.getByRole('button', { name: 'Save models' }).click();
    await expect(models.getByRole('status')).toContainText('Saved.');

    await tabs.getByRole('tab', { name: 'Rules' }).click();
    const rules = page.locator('[data-delegation-form="rules"]');
    await rules
      .locator('[data-delegation-rule="0"]')
      .getByRole('textbox', { name: 'Description' })
      .fill(`Codex never reviews acme repositories (${stamp}).`);
    await rules.getByRole('button', { name: 'Save rules' }).click();
    await expect(rules.getByRole('status')).toContainText('Saved.');
    expect(savedScopes).toEqual([
      ['personal', 'work', 'team'],
      ['personal', 'work', 'team'],
    ]);

    // Re-read from the fixture: both saves restated the annotation with its context, reserve and limit.
    await page.goto('/delegation');
    await waitForDelegation(page);
    const team = await expectTeamAnnotation(annotations);
    await tabs.getByRole('tab', { name: 'Models' }).click();
    await expect(models.locator('[data-delegation-model="0"]').getByRole('textbox', { name: 'Note' })).toHaveValue(
      `Note ${stamp}`,
    );
    await tabs.getByRole('tab', { name: 'Routes and accounts' }).click();

    // Removing it is an explicit action of the section that owns annotations.
    await team.getByRole('button', { name: 'Remove annotation' }).click();
    await expect(annotations.getByRole('button', { name: 'Discard edits' })).toBeEnabled();
    await annotations.getByRole('button', { name: 'Save route contexts' }).click();
    await expect(annotations.getByRole('status')).toContainText('Saved.');
    expect(savedScopes.at(-1)).toEqual(['personal', 'work']);
    await page.goto('/delegation');
    await waitForDelegation(page);
    await expect(annotations.locator('[data-delegation-route-annotation]')).toHaveCount(2);
    await expect(annotations.locator('[data-delegation-route-declared="false"]')).toHaveCount(0);
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
