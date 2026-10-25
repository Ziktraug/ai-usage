import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page, Route } from '@playwright/test';
import { expect, test, waitForHydratedNavigation } from './browser-test';

// The fixture server keeps the settings in memory for the whole run, and some tests below write
// them (one briefly saves no route annotation at all). Every test of this file therefore runs in
// order in one worker, so no read-only test observes another test's write in flight.
test.describe.configure({ mode: 'serial' });

const SAVE_SETTINGS_RPC_PATH = '/rpc/delegation/saveSettings';
const SETTINGS_RPC_PATH = '/rpc/delegation/settings';
/** The fixture machine every declaration without a machine is on; a declared route's card is keyed by it. */
const FIXTURE_MACHINE_ID = 'fixture-machine';
const PERSONAL_ROUTE_KEY = `${FIXTURE_MACHINE_ID}/claude-code/personal`;

/** A `delegation.routes[]` entry as the settings read presents it. */
interface RouteAnnotationRead {
  readonly accountScope: string;
  readonly context: string;
  readonly harness: string;
  readonly label?: string;
  readonly maxConcurrent?: number;
  readonly reservePercent?: number;
}

/** The parts of the settings read a scenario rewrites. */
interface SettingsRead {
  delegation: { config: { routes: RouteAnnotationRead[] } };
  executors: { declarations: unknown[] };
  routes: unknown[];
}

const stringOrEmpty = (value: number | undefined): string => (value === undefined ? '' : String(value));
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

/**
 * A refused save (a revision conflict) answers with a ≥ 400 status the browser failure gate would
 * report; the tests below expect such answers, so each is marked for the gate (see browser-test.ts).
 */
const expectRefusedSaves = async (page: Page): Promise<void> => {
  await page.route(
    (url) => url.pathname === SAVE_SETTINGS_RPC_PATH,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        headers:
          response.status() >= 400
            ? { ...response.headers(), [EXPECTED_ERROR_HEADER]: 'shell-route' }
            : response.headers(),
        response,
      });
    },
  );
};

const openModels = async (page: Page): Promise<Locator> => {
  await page.goto('/delegation?section=models');
  await waitForDelegation(page);
  return page.locator('[data-delegation-form="models"]');
};

const aliasOf = (models: Locator, index: number): Locator =>
  models.locator(`[data-delegation-model="${index}"]`).getByRole('textbox', { name: 'Alias' });

const revisionOf = (page: Page): Promise<string | null> =>
  page.locator('main[data-route-shell="delegation"]').getAttribute('data-delegation-revision');

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
    await expect(conflict).toContainText(
      'Your edits are kept below and cannot be saved over it: discard them or re-apply them to the latest.',
    );
    await expect(label).toHaveValue('Claude personal (conflicting edit)');
    expect(rewritten).toBe(true);
    // The conflict was forged: nothing this form writes moved, so re-applying keeps the edit as it is.
    await conflict.getByRole('button', { name: 'Re-apply my edits to the latest' }).click();
    await expect(form.locator('[data-delegation-reapplied]')).toContainText('Your edits were re-applied to revision');
    await expect(label).toHaveValue('Claude personal (conflicting edit)');
    await expect(form.getByRole('button', { name: 'Discard edits' })).toBeEnabled();
    await expect(form.getByRole('button', { name: 'Save route contexts' })).toBeEnabled();
  });

  // Two clients: the test's page (A) and a page in a second browser context (B). The fixture server
  // is their shared configuration; nothing refetches A's settings behind its back.
  test('a conflict offers to discard or re-apply; re-applying keeps my edit and the one made elsewhere', async ({
    browser,
    page,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    await expectRefusedSaves(page);
    const models = await openModels(page);
    const revisionA = await revisionOf(page);
    await aliasOf(models, 0).fill(`mine-${stamp}`);

    const other = await browser.newContext();
    try {
      const pageB = await other.newPage();
      const modelsB = await openModels(pageB);
      await aliasOf(modelsB, 1).fill(`theirs-${stamp}`);
      await modelsB.getByRole('button', { name: 'Save models' }).click();
      await expect(modelsB.getByRole('status')).toContainText('Saved.');
      const revisionB = await revisionOf(pageB);
      expect(revisionB).not.toBe(revisionA);

      await models.getByRole('button', { name: 'Save models' }).click();
      const conflict = models.locator('[data-delegation-conflict]');
      await expect(conflict).toHaveAttribute('role', 'alert');
      await expect(conflict).toContainText(
        `The configuration changed elsewhere (revision ${revisionB}). Your edits are kept below and cannot be saved over it: discard them or re-apply them to the latest.`,
      );
      await expect(aliasOf(models, 0)).toHaveValue(`mine-${stamp}`);
      await expect(aliasOf(models, 1)).not.toHaveValue(`theirs-${stamp}`);

      await conflict.getByRole('button', { name: 'Re-apply my edits to the latest' }).click();
      const reapplied = models.locator('[data-delegation-reapplied]');
      await expect(reapplied).toHaveAttribute('role', 'status');
      await expect(reapplied).toContainText(
        `Your edits were re-applied to revision ${revisionB}. Review them and save.`,
      );
      await expect(aliasOf(models, 0)).toHaveValue(`mine-${stamp}`);
      await expect(aliasOf(models, 1)).toHaveValue(`theirs-${stamp}`);
      await expect.poll(() => revisionOf(page)).toBe(revisionB);
      await expect(models.getByRole('button', { name: 'Discard edits' })).toBeEnabled();

      await models.getByRole('button', { name: 'Save models' }).click();
      await expect(models.getByRole('status')).toContainText('Saved.');
      await expect.poll(() => revisionOf(page)).not.toBe(revisionB);

      // The other client re-reads: both edits are in the configuration.
      await pageB.goto('/delegation?section=models');
      await waitForDelegation(pageB);
      await expect(aliasOf(modelsB, 0)).toHaveValue(`mine-${stamp}`);
      await expect(aliasOf(modelsB, 1)).toHaveValue(`theirs-${stamp}`);
    } finally {
      await other.close();
    }
  });

  test('a field both clients changed is named on re-apply and keeps the latest value until I enter mine', async ({
    browser,
    page,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    await expectRefusedSaves(page);
    const models = await openModels(page);
    await aliasOf(models, 1).fill(`a-${stamp}`);

    const other = await browser.newContext();
    try {
      const pageB = await other.newPage();
      const modelsB = await openModels(pageB);
      await aliasOf(modelsB, 1).fill(`b-${stamp}`);
      await modelsB.getByRole('button', { name: 'Save models' }).click();
      await expect(modelsB.getByRole('status')).toContainText('Saved.');
      const revisionB = await revisionOf(pageB);

      await models.getByRole('button', { name: 'Save models' }).click();
      const conflict = models.locator('[data-delegation-conflict]');
      await expect(conflict).toContainText(`(revision ${revisionB})`);
      await conflict.getByRole('button', { name: 'Re-apply my edits to the latest' }).click();

      // Both changed the same field: the notice names it with both values and the form keeps the latest.
      const reapplied = models.locator('[data-delegation-reapplied]');
      await expect(reapplied).toHaveAttribute('role', 'alert');
      await expect(reapplied).toContainText(
        `Your edits were re-applied to revision ${revisionB}, except 1 field also changed elsewhere, which keeps the latest value until you enter yours again:`,
      );
      await expect(reapplied.getByRole('listitem')).toHaveText(
        `model/gpt-5-codex › alias: yours "a-${stamp}", latest "b-${stamp}"`,
      );
      await expect(aliasOf(models, 1)).toHaveValue(`b-${stamp}`);
      await expect(models.getByRole('button', { name: 'Discard edits' })).toBeDisabled();

      // Keeping mine is a deliberate act: enter it again, then save on the latest revision.
      await aliasOf(models, 1).fill(`a-${stamp}`);
      await models.getByRole('button', { name: 'Save models' }).click();
      await expect(models.getByRole('status')).toContainText('Saved.');
      await pageB.goto('/delegation?section=models');
      await waitForDelegation(pageB);
      await expect(aliasOf(modelsB, 1)).toHaveValue(`a-${stamp}`);
    } finally {
      await other.close();
    }
  });

  test('a reload another form caused never promotes a draft the latest changed under; discarding drops it', async ({
    browser,
    page,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    await expectRefusedSaves(page);
    const models = await openModels(page);
    const originalAlias = await aliasOf(models, 0).inputValue();
    await aliasOf(models, 0).fill(`mine-${stamp}`);

    const other = await browser.newContext();
    try {
      const pageB = await other.newPage();
      const modelsB = await openModels(pageB);
      await aliasOf(modelsB, 1).fill(`theirs-${stamp}`);
      await modelsB.getByRole('button', { name: 'Save models' }).click();
      await expect(modelsB.getByRole('status')).toContainText('Saved.');
      const revisionB = await revisionOf(pageB);

      // The Rules form's save is refused; its own notice reloads the page's settings to the latest.
      const tabs = page.getByRole('tablist', { name: SECTION_TABS });
      await tabs.getByRole('tab', { name: 'Rules' }).click();
      const rules = page.locator('[data-delegation-form="rules"]');
      await rules.getByRole('button', { name: 'Save rules' }).click();
      const rulesConflict = rules.locator('[data-delegation-conflict]');
      await expect(rulesConflict).toContainText(`(revision ${revisionB})`);
      await rulesConflict.getByRole('button', { name: 'Discard my edits and load the latest' }).click();
      await expect(rulesConflict).toHaveCount(0);
      await expect.poll(() => revisionOf(page)).toBe(revisionB);

      // The Models draft was read at the old revision and the models changed elsewhere: it is stale,
      // still shown, and no save can carry it.
      await tabs.getByRole('tab', { name: 'Models' }).click();
      const conflict = models.locator('[data-delegation-conflict]');
      await expect(conflict).toHaveAttribute('role', 'alert');
      await expect(conflict).toContainText(`(revision ${revisionB})`);
      await expect(models.getByRole('button', { name: 'Save models' })).toBeDisabled();
      await expect(aliasOf(models, 0)).toHaveValue(`mine-${stamp}`);
      await expect(aliasOf(models, 1)).not.toHaveValue(`theirs-${stamp}`);

      await conflict.getByRole('button', { name: 'Discard my edits and load the latest' }).click();
      await expect(conflict).toHaveCount(0);
      await expect(aliasOf(models, 0)).toHaveValue(originalAlias);
      await expect(aliasOf(models, 1)).toHaveValue(`theirs-${stamp}`);
      await expect(models.getByRole('button', { name: 'Discard edits' })).toBeDisabled();
      await expect(models.getByRole('button', { name: 'Save models' })).toBeEnabled();

      await pageB.goto('/delegation?section=models');
      await waitForDelegation(pageB);
      await expect(aliasOf(modelsB, 0)).toHaveValue(originalAlias);
      await expect(aliasOf(modelsB, 1)).toHaveValue(`theirs-${stamp}`);
    } finally {
      await other.close();
    }
  });

  test('an edit made while a save is pending is kept, said so, and carried by the next save', async ({ page }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    await page.goto('/delegation');
    await waitForDelegation(page);
    const form = page.locator('[data-delegation-form="route-annotations"]');
    const personal = form.locator(`[data-delegation-route-annotation="${PERSONAL_ROUTE_KEY}"]`);
    const label = personal.getByRole('textbox', { name: 'Label' });
    const reserve = personal.getByRole('textbox', { name: 'Reserve %' });
    const save = form.getByRole('button', { name: 'Save route contexts' });
    const status = form.getByRole('status');
    await label.fill(`Claude personal ${stamp}`);

    // The save's answer is held until the test releases it: the operator keeps editing meanwhile.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === SAVE_SETTINGS_RPC_PATH,
      async (route) => {
        if (route.request().method() === 'POST') {
          await released;
        }
        await route.continue();
      },
    );
    const revisionBefore = await revisionOf(page);
    await save.click();
    await expect(status).toHaveText('Saving…');
    await expect(save).toBeDisabled();
    await reserve.fill('10');
    await expect(reserve).toHaveValue('10');
    release();

    // The save lands and the page re-reads the settings: the later edit is neither replaced nor hidden.
    await expect(status).toContainText('Saved. The configuration is now at revision');
    await expect.poll(() => revisionOf(page)).not.toBe(revisionBefore);
    await expect(reserve).toHaveValue('10');
    await expect(label).toHaveValue(`Claude personal ${stamp}`);
    await expect(status).toContainText('Edits made since are kept below and not saved yet.');
    await expect(form.getByRole('button', { name: 'Discard edits' })).toBeEnabled();
    await expect(save).toBeEnabled();

    await save.click();
    await expect(status).toContainText('Saved. The configuration is now at revision');
    await expect(status).not.toContainText('Edits made since');
    await expect(form.getByRole('button', { name: 'Discard edits' })).toBeDisabled();
    await page.goto('/delegation');
    await waitForDelegation(page);
    await expect(label).toHaveValue(`Claude personal ${stamp}`);
    await expect(reserve).toHaveValue('10');
  });

  test('a note typed into a just-added model while its save is pending is kept through its own re-read', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    const models = await openModels(page);
    const declared = await models.locator('[data-delegation-model]').count();
    await models.getByRole('button', { name: 'Add model' }).click();
    const added = models.locator(`[data-delegation-model="${declared}"]`);
    await added.getByRole('textbox', { name: 'Catalog id' }).fill(`added-${stamp}`);
    await added.getByRole('textbox', { name: 'Native id' }).fill(`native-${stamp}`);
    const note = added.getByRole('textbox', { name: 'Note' });
    const save = models.getByRole('button', { name: 'Save models' });
    const status = models.getByRole('status');

    // The save's answer is held until the test releases it: the operator keeps typing meanwhile.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === SAVE_SETTINGS_RPC_PATH,
      async (route) => {
        if (route.request().method() === 'POST') {
          await released;
        }
        await route.continue();
      },
    );
    const revisionBefore = await revisionOf(page);
    await save.click();
    await expect(status).toHaveText('Saving…');
    await note.fill(`Typed while pending ${stamp}`);
    release();

    // The save lands and the settings read the entry back keyed by its id and dated: the note is
    // neither lost nor read as a change made elsewhere, and the entry the operator is typing in stays.
    await expect(status).toContainText('Saved. The configuration is now at revision');
    await expect.poll(() => revisionOf(page)).not.toBe(revisionBefore);
    await expect(status).toContainText('Edits made since are kept below and not saved yet.');
    await expect(models.locator('[data-delegation-conflict]')).toHaveCount(0);
    await expect(note).toHaveValue(`Typed while pending ${stamp}`);
    await expect(note).toBeFocused();
    await expect(added).not.toContainText('Dated when saved.');
    await expect(save).toBeEnabled();

    await save.click();
    await expect(status).toContainText('Saved. The configuration is now at revision');
    await expect(status).not.toContainText('Edits made since');
    await expect(models.getByRole('button', { name: 'Discard edits' })).toBeDisabled();
    await page.goto('/delegation?section=models');
    await waitForDelegation(page);
    await expect(added.getByRole('textbox', { name: 'Catalog id' })).toHaveValue(`added-${stamp}`);
    await expect(note).toHaveValue(`Typed while pending ${stamp}`);
  });

  test('removing the last annotation no declaration resolves can be saved; it is gone on re-read', async ({ page }) => {
    test.setTimeout(90_000);
    // The read presents no declaration and one annotation (the first one on disk); the save and the
    // re-read are real. The annotations read are restored at the end, as the other tests read them.
    let annotationsRead: RouteAnnotationRead[] = [];
    const presentOneAnnotation = async (route: Route): Promise<void> => {
      const response = await route.fetch();
      const body = (await response.json()) as { json?: SettingsRead };
      if (!body.json) {
        throw new Error('Expected an oRPC JSON envelope on the settings response.');
      }
      if (annotationsRead.length === 0) {
        annotationsRead = body.json.delegation.config.routes;
      }
      body.json.executors.declarations = [];
      body.json.routes = [];
      body.json.delegation.config.routes = body.json.delegation.config.routes.slice(0, 1);
      await route.fulfill({ headers: { 'content-type': 'application/json' }, json: body, status: response.status() });
    };
    const isSettingsRead = (url: URL): boolean => url.pathname === SETTINGS_RPC_PATH;
    await page.route(isSettingsRead, presentOneAnnotation);
    // A client-side entry reads the settings through the RPC the scenario answers.
    await page.goto('/sources');
    await waitForHydratedNavigation(page);
    await page
      .getByRole('complementary', { name: 'Application navigation' })
      .getByRole('link', { name: 'Delegation', exact: true })
      .click();
    await waitForDelegation(page);

    const form = page.locator('[data-delegation-form="route-annotations"]');
    const cards = form.locator('[data-delegation-route-annotation]');
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('data-delegation-route-declared', 'false');
    await expect(page.locator('[data-delegation-form="executors"]')).toContainText('No executor declared yet.');
    const save = form.getByRole('button', { name: 'Save route contexts' });
    await cards.getByRole('button', { name: 'Remove annotation' }).click();
    await expect(cards).toHaveCount(0);
    await expect(form).toContainText('Declare an executor first; its context is set here.');
    await expect(form.getByRole('button', { name: 'Discard edits' })).toBeEnabled();
    await expect(save).toBeEnabled();
    const savedScopes = recordSavedRouteScopes(page);
    await save.click();
    await expect(form.getByRole('status')).toContainText('Saved.');
    expect(savedScopes).toEqual([[]]);
    await page.unroute(isSettingsRead, presentOneAnnotation);

    // Re-read from the fixture: no annotation is left; the declared routes have no context until set.
    await page.goto('/delegation');
    await waitForDelegation(page);
    await expect(form.locator('[data-delegation-route-declared="false"]')).toHaveCount(0);
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all()) {
      await expect(card.getByRole('combobox', { name: 'Context' })).toHaveValue('');
    }

    // Restore what was read for the declared routes, so the other tests find their contexts.
    for (const annotation of annotationsRead) {
      const card = form.locator(
        `[data-delegation-route-annotation="${FIXTURE_MACHINE_ID}/${annotation.harness}/${annotation.accountScope}"]`,
      );
      if ((await card.count()) === 0) {
        continue;
      }
      await card.getByRole('combobox', { name: 'Context' }).selectOption(annotation.context);
      await card.getByRole('textbox', { name: 'Label' }).fill(annotation.label ?? '');
      await card.getByRole('textbox', { name: 'Reserve %' }).fill(stringOrEmpty(annotation.reservePercent));
      await card.getByRole('textbox', { name: 'Max concurrent' }).fill(stringOrEmpty(annotation.maxConcurrent));
    }
    await save.click();
    await expect(form.getByRole('status')).toContainText('Saved.');
    await page.goto('/delegation');
    await waitForDelegation(page);
    await expect(form.locator('[data-delegation-route-declared="false"]')).toHaveCount(0);
    await expect(
      form
        .locator(`[data-delegation-route-annotation="${PERSONAL_ROUTE_KEY}"]`)
        .getByRole('combobox', { name: 'Context' }),
    ).toHaveValue('personal');
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
