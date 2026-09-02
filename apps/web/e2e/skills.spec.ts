import type { Locator, Page } from '@playwright/test';
import { expect, openHydratedSkills, test, waitForHydratedSkills } from './browser-test';
import {
  decodeRpcResponseBody,
  encodeRpcResponseBody,
  rpcRouteFulfillmentForClientResult,
  SKILLS_SAVE_RPC_PATH,
} from './rpc-test-transport';

const ALPHA_SKILL_CONTENT = '# alpha-skill\n\nDeterministic Playwright fixture.\n';
const BETA_SKILL_CONTENT = '# beta-skill\n\nDeterministic Playwright fixture.\n';
const ALPHA_SKILL_URL = /\/skills\/global\/alpha-skill$/;
const BETA_SKILL_URL = /\/skills\/global\/beta-skill$/;
const SKILLS_WORKTABLE_URL = /\/skills$/;
const DESKTOP_WORKSPACE_VIEWPORT = { height: 900, width: 1280 } as const;
const MOBILE_VIEWPORT = { height: 844, width: 390 } as const;
const SAVE_MANAGED_MARKDOWN_RPC_ROUTE = `**${SKILLS_SAVE_RPC_PATH}`;
const SKILLS_OBSERVATIONS_RPC_ROUTE = '**/rpc/skills/observations?*';
const SKILLS_REFRESH_RPC_ROUTE = '**/rpc/skills/refreshSnapshot';
const SUCCESS_NOTICE_DISMISS_DELAY_MS = 5000;
const WHITESPACE_PATTERN = /\s+/g;
const CURSOR_COVERAGE_TEXT = 'Cursor — not observable';
const OBSERVATION_NOT_OBSERVABLE_TEXT = 'not observable';
const ALL_FILTER_PATTERN = /^All —/;
const CATALOGUE_FILTER_PATTERN = /^Catalogue only —/;
const TO_DELETE_FILTER_PATTERN = /^To delete —/;
const APPLY_ACTION_PATTERN = /^Apply \d+ action/;
const CREATED_TARGET_PATTERN = /Created target directory/;
const ADOPTION_GATE_PATTERN = /waits on the approved file-operation plan/;

const normalizeText = (value: string): string => value.replace(WHITESPACE_PATTERN, ' ').trim();

/** The drawer is the only per-skill surface now; every detail assertion is scoped to it. */
const skillDrawer = (page: Page, name: string): Locator => page.getByRole('dialog', { name: `${name} detail` });

const worktableRow = (page: Page, name: string): Locator => page.locator(`[data-worktable-row="${name}"]`);

const interceptSaveResultForDraft = async (page: Page, draftMarker: string, result: unknown): Promise<void> => {
  await page.route(SAVE_MANAGED_MARKDOWN_RPC_ROUTE, async (route) => {
    if (!route.request().postData()?.includes(draftMarker)) {
      await route.continue();
      return;
    }
    const fulfillment = rpcRouteFulfillmentForClientResult(result);
    await route.fulfill({
      body: fulfillment.body,
      contentType: 'application/json',
      headers: fulfillment.headers,
      status: fulfillment.status,
    });
  });
};

test('renders one worktable whose groups are the decisions, with no tree, inspector, or matrix', async ({ page }) => {
  await page.setViewportSize(DESKTOP_WORKSPACE_VIEWPORT);
  await openHydratedSkills(page, '/skills');

  await expect(page.getByRole('heading', { level: 1, name: 'Skills' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Skills worktable' })).toBeVisible();
  for (const group of ['managed', 'to-adopt', 'projects', 'catalogue']) {
    await expect(page.locator(`[data-worktable-group="${group}"]`)).toBeVisible();
  }
  await expect(page.getByRole('complementary', { name: 'Skill scopes' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Skill exposure per runtime' })).toHaveCount(0);
});

test('redirects the retired scope and matrix URLs onto the worktable', async ({ page }) => {
  for (const path of ['/skills/matrix', '/skills/global', '/skills/projects/project%2Fopaque']) {
    await openHydratedSkills(page, path);
    await expect(page).toHaveURL(SKILLS_WORKTABLE_URL);
    await expect(page.getByRole('region', { name: 'Skills worktable' })).toBeVisible();
  }
});

test('filters the same table in place instead of navigating to another page', async ({ page }) => {
  await openHydratedSkills(page, '/skills');

  const catalogueFilter = page.getByRole('button', { name: CATALOGUE_FILTER_PATTERN });
  await catalogueFilter.click();

  await expect(page).toHaveURL(SKILLS_WORKTABLE_URL);
  await expect(catalogueFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-worktable-group="catalogue"]')).toBeVisible();
  await expect(page.locator('[data-worktable-group="managed"]')).toHaveCount(0);

  await page.getByRole('button', { name: ALL_FILTER_PATTERN }).click();
  await expect(page.locator('[data-worktable-group="managed"]')).toBeVisible();
});

// Plan 113 decision 3/4, and ADR 0022. The three readings this surface must never produce: a zero
// for a harness that cannot observe, a total that sums two tiers, and a state carried by colour.
test('joins placement with evidence in one cell and never sums two tiers', async ({ page }) => {
  await page.setViewportSize(DESKTOP_WORKSPACE_VIEWPORT);
  await openHydratedSkills(page, '/skills');

  const alpha = worktableRow(page, 'alpha-skill');
  await expect(alpha).toBeVisible();

  // Claude Code recorded three invocations, and the cell also states where the skill is installed.
  const claudeCell = alpha.locator('[data-worktable-cell="target:claude"]');
  await expect(claudeCell.locator('[data-evidence-tier="declared"]')).toContainText('3');
  // Codex reconstructed one from a weaker trace: a tilde, never a bare number beside a recorded one.
  const codexCell = alpha.locator('[data-worktable-cell="target:codex"]');
  await expect(codexCell.locator('[data-evidence-tier="inferred"]')).toContainText('~1');
  await expect(codexCell.locator('[data-evidence-tier="declared"]')).toHaveCount(0);
  // 3 recorded plus 1 reconstructed is not 4 of anything, and "offered to a model" is availability
  // rather than use — so no cell in this row carries either number.
  for (const cell of await alpha.locator('[data-worktable-cell]').all()) {
    const text = normalizeText((await cell.textContent()) ?? '');
    expect(text).not.toContain('4');
    expect(text).not.toContain('exposed');
  }

  // Cursor cannot report. It is named once in words and given no column, so no row is a Cursor zero.
  await expect(page.getByRole('list', { name: 'Harness observability' })).toContainText(CURSOR_COVERAGE_TEXT);
  await expect(page.locator('[data-worktable-cell="harness:cursor"]')).toHaveCount(0);

  // The notation is taught once beside the strip rather than abbreviated in every cell.
  await expect(page.locator('[data-worktable-notation]')).toContainText('never added together');
});

test('spells every count out in words for assistive technology', async ({ page }) => {
  await openHydratedSkills(page, '/skills');

  const alpha = worktableRow(page, 'alpha-skill');
  await expect(alpha).toContainText('3 recorded invocations in Claude Code');
  await expect(alpha).toContainText('1 invocation reconstructed from traces in Codex');
});

test('keeps a disabled managed skill in the table with its history and no placement claim', async ({ page }) => {
  await openHydratedSkills(page, '/skills');

  const beta = worktableRow(page, 'beta-skill');
  await beta.getByRole('switch', { name: 'Disable beta-skill' }).click();

  await expect(beta.getByRole('switch', { name: 'Enable beta-skill' })).toBeVisible();
  await expect(beta.locator('[data-worktable-disabled-state]')).toHaveText('Kept in source');
  // Disabling removes links; it never removes the row or its observation history.
  await expect(beta).toBeVisible();

  await beta.getByRole('switch', { name: 'Enable beta-skill' }).click();
  await expect(beta.getByRole('switch', { name: 'Disable beta-skill' })).toBeVisible();
});

test('offers adoption as a disabled action with the sentence that explains the gate', async ({ page }) => {
  await openHydratedSkills(page, '/skills');

  // `legacy-local-copy` is the fixture's runtime-installed candidate: a copy in a runtime skills
  // directory that a harness recorded being used, with no managed source behind it.
  const adopt = page.locator('[data-worktable-adopt="legacy-local-copy"]');
  await expect(adopt).toBeVisible();
  await expect(adopt).toBeDisabled();
  await expect(adopt).toHaveAccessibleDescription(ADOPTION_GATE_PATTERN);
  await expect(page.locator('#worktable-adopt-gate')).toContainText('waits on the approved file-operation plan');
});

test('summarises each repository as one expandable row rather than a page that renders empty', async ({ page }) => {
  await openHydratedSkills(page, '/skills');

  // Addressed by the repository it belongs to: expanding flips its own control to Collapse, so a
  // name-based locator would silently re-resolve to the next repository's still-collapsed control.
  const expand = page.locator('[data-worktable-project-expand]').first();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect(expand).toHaveAttribute('aria-expanded', 'true');
  await expect(page).toHaveURL(SKILLS_WORKTABLE_URL);
  await expect(worktableRow(page, 'skill-name')).toBeVisible();
});

test('opens the skill drawer from its URL, closes it with Escape, and restores focus', async ({ page }) => {
  await openHydratedSkills(page, '/skills');

  const alphaLink = worktableRow(page, 'alpha-skill').getByRole('link', { exact: true, name: 'alpha-skill' });
  await alphaLink.click();
  await expect(page).toHaveURL(ALPHA_SKILL_URL);

  const drawer = skillDrawer(page, 'alpha-skill');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 2, name: 'alpha-skill' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Close skill detail' })).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(page).toHaveURL(SKILLS_WORKTABLE_URL);
  await expect(drawer).toBeHidden();
  await expect(alphaLink).toBeFocused();
});

test('states the exposure of a managed skill in the drawer with its per-target action', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const drawer = skillDrawer(page, 'alpha-skill');
  await expect(drawer.locator('[data-skill-drawer-history]')).toBeVisible();
  await expect(drawer.locator('[data-skill-drawer-placement="codex"]')).toBeVisible();
  await expect(drawer.locator('[data-skill-drawer-residence]')).toContainText('/fixture/source/skills/alpha-skill');
  // The link operation is offered where reconcile can act, and the drawer says so in words.
  await expect(drawer.getByRole('button', { name: 'Link' })).toBeVisible();
});

test('renders skill observations with their tier and never as an unobservable zero', async ({ page }) => {
  await page.setViewportSize(DESKTOP_WORKSPACE_VIEWPORT);
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const detail = skillDrawer(page, 'alpha-skill').getByRole('region', { name: 'Skill observations' });
  await expect(detail.getByRole('definition').filter({ hasText: 'declared 3' })).toBeVisible();
  await expect(detail.getByRole('definition').filter({ hasText: 'exposed 2' })).toBeVisible();
  await expect(detail.getByRole('definition').filter({ hasText: OBSERVATION_NOT_OBSERVABLE_TEXT })).toBeVisible();
  await expect(detail.getByText('Invocation evidence from at least one harness.')).toBeVisible();

  await openHydratedSkills(page, '/skills/global/beta-skill');
  const betaDetail = skillDrawer(page, 'beta-skill').getByRole('region', { name: 'Skill observations' });
  await expect(betaDetail.getByText('No skill signal recorded by an observable harness.')).toBeVisible();
  await expect(
    betaDetail.getByText('Installed in every enabled runtime, with no invocation recorded — a deletion candidate.'),
  ).toBeVisible();
  await expect(betaDetail.locator('[data-skill-observations-deletion-candidate]')).toHaveAttribute(
    'data-verdict-provisional',
    'false',
  );

  // A project-local skill, which is the majority of what a real machine holds.
  await openHydratedSkills(page, '/skills/projects/project%2Fopaque/skill-name');
  const projectDetail = skillDrawer(page, 'skill-name').getByRole('region', { name: 'Skill observations' });
  await expect(projectDetail.getByRole('definition').filter({ hasText: 'declared 1' })).toBeVisible();
  await expect(projectDetail.getByRole('definition').filter({ hasText: 'inferred 1' })).toBeVisible();
  await expect(
    projectDetail.getByText('Invocation evidence — owned by a project repository, outside the shared source.', {
      exact: false,
    }),
  ).toBeVisible();
});

test('opens a managed SKILL.md as an immediately editable document and saves with the pointer', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const drawer = skillDrawer(page, 'alpha-skill');
  const editor = drawer.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const saveButton = drawer.getByRole('button', { exact: true, name: 'Save' });
  const revertButton = drawer.getByRole('button', { name: 'Revert changes' });

  await expect(drawer.getByRole('heading', { level: 2, name: 'alpha-skill' })).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(ALPHA_SKILL_CONTENT);
  await expect(drawer.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(drawer.getByText('Unchanged', { exact: true })).toBeVisible();
  await expect(saveButton).toBeDisabled();
  await expect(revertButton).toBeDisabled();

  await editor.fill('# Saved with the pointer\n');

  await expect(drawer.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(saveButton).toBeEnabled();
  await expect(revertButton).toBeEnabled();

  await saveButton.click();

  await expect(drawer.getByText('Saved', { exact: true })).toBeVisible();
  await expect(editor).toBeEditable();
  await expect(editor).toHaveValue('# Saved with the pointer\n');
  await expect(saveButton).toBeDisabled();
});

test('loads the SKILL.md editor after client-side navigation between skills', async ({ page }) => {
  await openHydratedSkills(page, '/skills');
  await page.evaluate(() => document.documentElement.setAttribute('data-spa-probe', 'kept'));

  await worktableRow(page, 'beta-skill').getByRole('link', { exact: true, name: 'beta-skill' }).click();
  await expect(page).toHaveURL(BETA_SKILL_URL);
  // A full document navigation would replace <html> and drop the probe.
  await expect(page.locator('html[data-spa-probe="kept"]')).toHaveCount(1);
  const betaDrawer = skillDrawer(page, 'beta-skill');
  const betaEditor = betaDrawer.getByRole('textbox', { name: 'beta-skill SKILL.md' });
  await expect(betaEditor).toBeVisible();
  await expect(betaEditor).toHaveValue(BETA_SKILL_CONTENT);
  await expect(betaDrawer.getByText('Loading…', { exact: true })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(SKILLS_WORKTABLE_URL);
  await waitForHydratedSkills(page);

  await worktableRow(page, 'alpha-skill').getByRole('link', { exact: true, name: 'alpha-skill' }).click();
  await expect(page).toHaveURL(ALPHA_SKILL_URL);
  const alphaEditor = skillDrawer(page, 'alpha-skill').getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await expect(alphaEditor).toBeVisible();
  await expect(alphaEditor).toHaveValue(ALPHA_SKILL_CONTENT);
});

test('saves with Control+S and Meta+S while accepting immediate follow-up edits', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const drawer = skillDrawer(page, 'alpha-skill');
  const editor = drawer.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const saveButton = drawer.getByRole('button', { exact: true, name: 'Save' });

  await expect(editor).toBeVisible();
  await editor.fill('# Saved with the keyboard\n');
  await editor.press('Control+s');

  await expect(drawer.getByText('Saved', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('# Saved with the keyboard\n');
  await expect(editor).toBeEditable();

  await editor.fill('# Second immediate edit\n');

  await expect(editor).toHaveValue('# Second immediate edit\n');
  await expect(drawer.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Saved', { exact: true })).toHaveCount(0);
  await expect(saveButton).toBeEnabled();

  await editor.press('Meta+s');

  await expect(drawer.getByText('Saved', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('# Second immediate edit\n');
  await expect(saveButton).toBeDisabled();
});

test('wraps long SKILL.md prose without changing the source value', async ({ page }) => {
  const longProse = `# Long prose\n\n${'Readable prose should wrap inside the authoring surface. '.repeat(180)}\n`;
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const editor = skillDrawer(page, 'alpha-skill').getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await editor.fill(longProse);

  await expect(editor).toHaveAttribute('wrap', 'soft');
  await expect(editor).toHaveValue(longProse);
  const dimensions = await editor.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      whiteSpace: styles.whiteSpace,
    };
  });
  expect(dimensions.whiteSpace).toBe('pre-wrap');
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
});

test('preserves the exact local draft when SKILL.md changed on disk', async ({ page }) => {
  const draft = '# Browser conflict draft\n\nKeep this exact text.\n';
  await interceptSaveResultForDraft(page, 'Browser conflict draft', { data: { reason: 'conflict' }, ok: true });
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const drawer = skillDrawer(page, 'alpha-skill');
  const editor = drawer.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await editor.fill(draft);
  await drawer.getByRole('button', { exact: true, name: 'Save' }).click();

  await expect(page.getByRole('alert')).toHaveText('Changed on disk');
  await expect(editor).toHaveValue(draft);
  await expect(editor).toBeEditable();
  await expect(drawer.getByRole('button', { exact: true, name: 'Save' })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: 'Reload from disk' })).toBeEnabled();
});

test('preserves the exact local draft after another save failure', async ({ page }) => {
  const draft = '# Browser failed-save draft\n\nKeep this too.\n';
  await interceptSaveResultForDraft(page, 'Browser failed-save draft', {
    error: { message: 'Storage unavailable', tag: 'E2ESaveFailure' },
    ok: false,
  });
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const drawer = skillDrawer(page, 'alpha-skill');
  const editor = drawer.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await editor.fill(draft);
  await drawer.getByRole('button', { exact: true, name: 'Save' }).click();

  await expect(page.getByRole('alert')).toHaveText('Storage unavailable');
  await expect(editor).toHaveValue(draft);
  await expect(editor).toBeEditable();
  await expect(drawer.getByRole('button', { exact: true, name: 'Save' })).toBeEnabled();
  await expect(drawer.getByRole('button', { name: 'Revert changes' })).toBeEnabled();
});

test('saves SKILL.md source without installing it into runtimes', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const drawer = skillDrawer(page, 'alpha-skill');
  const editor = drawer.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const placementsBeforeSave = (await drawer.locator('[data-skill-drawer-placement]').allTextContents()).map(
    normalizeText,
  );

  await editor.fill('# Source-only change\n');
  await drawer.getByRole('button', { exact: true, name: 'Save' }).click();

  await expect(drawer.getByText('Saved', { exact: true })).toBeVisible();
  const placementsAfterSave = (await drawer.locator('[data-skill-drawer-placement]').allTextContents()).map(
    normalizeText,
  );
  expect(placementsAfterSave).toEqual(placementsBeforeSave);
  await expect(page.getByText('alpha-skill linked to Codex.', { exact: true })).toHaveCount(0);
});

test('protects an unsaved SKILL.md draft when the drawer is dismissed', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const drawer = skillDrawer(page, 'alpha-skill');
  const editor = drawer.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await editor.fill('# Unsaved local draft\n');
  await expect(drawer.getByText('Unsaved changes', { exact: true })).toBeVisible();

  await drawer.getByRole('button', { name: 'Reload from disk' }).click();
  const discardDialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(discardDialog).toBeHidden();
  await expect(editor).toHaveValue('# Unsaved local draft\n');
  await expect(editor).toBeFocused();

  await drawer.getByRole('button', { name: 'Reload from disk' }).click();
  await discardDialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(discardDialog).toBeHidden();
  await expect(editor).toHaveValue(ALPHA_SKILL_CONTENT);
  await expect(drawer.getByText('Unchanged', { exact: true })).toBeVisible();
});

test('refreshes the skills snapshot from the page header once the drawer is closed', async ({ page }) => {
  await openHydratedSkills(page, '/skills');

  const refreshButton = page.getByRole('button', { name: 'Refresh skills' });
  await page.clock.install();
  await refreshButton.click();

  const refreshNotice = page.getByRole('status').filter({ hasText: 'Skills refreshed.' });
  await expect(refreshNotice).toBeVisible();
  await expect(refreshNotice).toHaveCSS('position', 'fixed');
  await expect(refreshNotice).toHaveCSS('pointer-events', 'none');
  await page.clock.fastForward(SUCCESS_NOTICE_DISMISS_DELAY_MS);
  await expect(refreshNotice).toBeHidden();
});

test('marks the header refresh busy while the snapshot is in flight', async ({ page }) => {
  const responsePrepared = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  await page.route(SKILLS_REFRESH_RPC_ROUTE, async (route) => {
    const response = await route.fetch();
    const body = decodeRpcResponseBody(await response.text());
    responsePrepared.resolve();
    await releaseResponse.promise;
    await route.fulfill({ response, body: encodeRpcResponseBody(body) });
  });
  await openHydratedSkills(page, '/skills');

  const refreshButton = page.getByRole('button', { name: 'Refresh skills' });
  await refreshButton.click();
  await responsePrepared.promise;
  try {
    await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
  } finally {
    releaseResponse.resolve();
  }
  await expect(refreshButton).toHaveAttribute('aria-busy', 'false');
});

test('keeps retained observation evidence visible while observations refetch', async ({ page }) => {
  await openHydratedSkills(page, '/skills');

  const alpha = worktableRow(page, 'alpha-skill');
  const declaredEvidence = alpha.locator('[data-worktable-cell="target:claude"] [data-evidence-tier="declared"]');
  const inferredEvidence = alpha.locator('[data-worktable-cell="target:codex"] [data-evidence-tier="inferred"]');
  await expect(declaredEvidence).toContainText('3');
  await expect(inferredEvidence).toContainText('~1');

  const responsePrepared = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  await page.route(SKILLS_OBSERVATIONS_RPC_ROUTE, async (route) => {
    const response = await route.fetch();
    responsePrepared.resolve();
    await releaseResponse.promise;
    await route.fulfill({ response });
  });

  await page.getByRole('button', { name: 'Reconcile links…' }).click();
  await responsePrepared.promise;
  try {
    await expect(page.getByRole('columnheader', { name: 'OpenCode' })).toBeVisible();
    await expect(declaredEvidence).toContainText('3');
    await expect(inferredEvidence).toContainText('~1');
    await expect(page.locator('[data-skill-observations-state="loading"]')).toHaveCount(0);
    await expect(page.locator('[data-skill-observations-proof-refreshing]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: TO_DELETE_FILTER_PATTERN })).toContainText('provisional');
  } finally {
    releaseResponse.resolve();
  }

  await expect(page.locator('[data-skill-observations-proof-refreshing]')).toHaveCount(0);
  await expect(declaredEvidence).toContainText('3');
  await expect(inferredEvidence).toContainText('~1');
});

test('preserves a source repository draft across an unrelated snapshot refresh', async ({ page }) => {
  await openHydratedSkills(page, '/skills');
  await page.getByText('Configuration & runtimes').click();

  const sourceRepository = page.getByRole('textbox', { name: 'Source repository' });
  await sourceRepository.fill('/fixture/unsaved-source-draft');
  await page.getByRole('button', { name: 'Refresh skills' }).click();

  await expect(sourceRepository).toHaveValue('/fixture/unsaved-source-draft');
});

test('keeps every Skills mutation inside the deterministic E2E backend', async ({ page }) => {
  await openHydratedSkills(page, '/skills');
  await page.getByText('Configuration & runtimes').click();

  await page.getByRole('button', { name: 'Save source' }).click();
  await expect(page.getByText('Skill source saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Create directory' }).first().click();
  await expect(page.getByText(CREATED_TARGET_PATTERN)).toBeVisible();

  // The plan is read before anything is written — the header action only ever previews.
  await page.getByRole('button', { name: 'Reconcile links…' }).click();
  await expect(page.getByRole('region', { name: 'Reconcile plan' })).toBeVisible();
  await page.getByRole('button', { name: APPLY_ACTION_PATTERN }).click();
  await expect(page.getByText('alpha-skill linked to Codex.')).toBeVisible();
});
