import type { SkillManagementSnapshot } from '@ai-usage/skills';
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
const APPLY_ACTION_PATTERN = /Apply 1 action|Apply$/;
const DESKTOP_WORKSPACE_VIEWPORT = { height: 900, width: 1280 } as const;
const PASSIVE_RELOAD_NOTICE = ['Skills', 'reloaded.'].join(' ');
const MIN_DESKTOP_EDITOR_WIDTH_PX = 320;
const MIN_DESKTOP_INSPECTOR_WIDTH_PX = 260;
const MIN_DESKTOP_TREE_WIDTH_PX = 190;
const BETA_SKILL_URL = /\/skills\/global\/beta-skill$/;
const SKILLS_MATRIX_URL = /\/skills\/matrix$/;
const ADOPTION_ANCHOR_URL = /\/skills\/matrix#observations-adoption$/;
const REVIEW_AND_RECONCILE_PATTERN = /^Review & reconcile$/;
const SKILLS_DETAIL_GAP_PX = 14;
const SKILLS_SECTION_HEADER_GAP_PX = 2;
const CREATED_TARGET_PATTERN = /Created target directory/;
const HEALTHY_LINKS_PATTERN = /^Healthy links/;
const LONG_PROJECT_LABEL = 'customer-analytics-platform-with-an-exceptionally-long-scope-name';
const MOBILE_VIEWPORT = { height: 844, width: 390 } as const;
const SAVE_MANAGED_MARKDOWN_RPC_ROUTE = `**${SKILLS_SAVE_RPC_PATH}`;
const SKILLS_REFRESH_RPC_ROUTE = '**/rpc/skills/refreshSnapshot';
const SKILL_TOGGLE_ACTION_PATTERN = /^(Disable|Enable)$/;
const SUCCESS_NOTICE_DISMISS_DELAY_MS = 5000;
const MAX_KEYBOARD_TABS = 64;
const WHITESPACE_PATTERN = /\s+/g;
const BARE_NUMBER_PATTERN = /^\d+$/u;
const CURSOR_COVERAGE_TEXT = 'Cursor — not observable';
const ALPHA_ROW_HEADER_PATTERN = /^alpha-skill/u;
const OBSERVATION_NOT_OBSERVABLE_TEXT = 'not observable';
const MATRIX_TABLE_NAME = 'Skill exposure per runtime';
// Every observation cell states its tier in words, or is an em-dash whose accessible text still
// states the absence and its scope — never a bare number, never a colour alone.
const OBSERVATION_TEXT_PATTERN =
  /^(?:—\s*no signals (?:recorded|in loaded history)|not observable|no signals (?:recorded|in loaded history)|(?:declared|inferred|exposed) \d+(?: · (?:declared|inferred|exposed) \d+)*)$/u;

const normalizeText = (value: string): string => value.replace(WHITESPACE_PATTERN, ' ').trim();

// The matrix page now carries two tables — skill exposure per runtime, and skill signals per
// harness — so every locator here names the one it means.
const matrixTable = (page: Page): Locator => page.getByRole('table', { name: MATRIX_TABLE_NAME });

const expectColorToken = async (locator: Locator, token: string, property = 'color'): Promise<void> => {
  const expectedColor = await locator.evaluate((element, tokenName) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${tokenName})`;
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
  await expect(locator).toHaveCSS(property, expectedColor);
};

const openMatrixWithSnapshot = async (
  page: Page,
  transform: (snapshot: SkillManagementSnapshot) => SkillManagementSnapshot,
  expectedHealthyLinkCount: string,
): Promise<void> => {
  const responsePrepared = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  await page.unroute(SKILLS_REFRESH_RPC_ROUTE);
  await page.route(SKILLS_REFRESH_RPC_ROUTE, async (route) => {
    const response = await route.fetch();
    const snapshot = structuredClone(decodeRpcResponseBody(await response.text()) as SkillManagementSnapshot);
    responsePrepared.resolve();
    await releaseResponse.promise;
    await route.fulfill({ response, body: encodeRpcResponseBody(transform(snapshot)) });
  });
  await openHydratedSkills(page, '/skills/matrix');
  const refreshButton = page.getByRole('button', { name: 'Refresh skills' });
  const healthyLinksValue = page.getByRole('button', { name: HEALTHY_LINKS_PATTERN }).locator('[data-health-tone]');
  await refreshButton.click();
  await responsePrepared.promise;
  try {
    await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
  } finally {
    releaseResponse.resolve();
  }
  await expect(refreshButton).toHaveAttribute('aria-busy', 'false');
  await expect(healthyLinksValue).toHaveText(expectedHealthyLinkCount);
};

const tabToLocator = async (page: Page, target: Locator): Promise<void> => {
  for (let tabCount = 0; tabCount < MAX_KEYBOARD_TABS; tabCount += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  throw new Error(`Target was not reachable within ${MAX_KEYBOARD_TABS} Tab presses.`);
};

const expectKeyboardMatrixNavigation = async (page: Page, accessibleName: RegExp): Promise<void> => {
  await openHydratedSkills(page, '/skills/global');
  const link = page.getByRole('region', { name: 'Selected skill detail' }).getByRole('link', { name: accessibleName });
  await expect(link).toHaveAttribute('href', '/skills/matrix');
  await tabToLocator(page, link);
  await expect(link).toBeFocused();
  await expect(link).toHaveCSS('outline-style', 'solid');
  await expect(link).toHaveCSS('outline-width', '2px');
  await expect(link).toHaveCSS('outline-offset', '2px');
  await expectColorToken(link, '--colors-accent', 'outline-color');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(SKILLS_MATRIX_URL);
  await expect(page.getByRole('heading', { level: 2, name: 'Managed skills — exposure per runtime' })).toBeVisible();
};

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

test('opens a managed SKILL.md as an immediately editable document and saves with the pointer', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const editor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const saveButton = detail.getByRole('button', { exact: true, name: 'Save' });
  const revertButton = detail.getByRole('button', { name: 'Revert changes' });

  await expect(page.getByRole('heading', { level: 2, name: 'alpha-skill' })).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(ALPHA_SKILL_CONTENT);
  await expect(detail.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  const unchangedStatus = page.getByText('Unchanged', { exact: true });
  await expect(unchangedStatus).toBeVisible();
  await expectColorToken(unchangedStatus, '--colors-muted');
  await expect(saveButton).toBeDisabled();
  await expect(revertButton).toBeDisabled();

  await editor.fill('# Saved with the pointer\n');

  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(saveButton).toBeEnabled();
  await expect(revertButton).toBeEnabled();

  await saveButton.click();

  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(editor).toBeEditable();
  await expect(editor).toHaveValue('# Saved with the pointer\n');
  await expect(saveButton).toBeDisabled();
});

test('loads the SKILL.md editor after client-side navigation into and between skills', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global');
  await page.evaluate(() => document.documentElement.setAttribute('data-spa-probe', 'kept'));

  await page.getByRole('link', { exact: true, name: 'beta-skill' }).first().click();
  await expect(page).toHaveURL(BETA_SKILL_URL);
  // A full document navigation would replace <html> and drop the probe.
  await expect(page.locator('html[data-spa-probe="kept"]')).toHaveCount(1);
  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const betaEditor = detail.getByRole('textbox', { name: 'beta-skill SKILL.md' });
  await expect(betaEditor).toBeVisible();
  await expect(betaEditor).toHaveValue(BETA_SKILL_CONTENT);
  await expect(detail.getByText('Loading…', { exact: true })).toHaveCount(0);
  await waitForHydratedSkills(page);

  await page.getByRole('link', { exact: true, name: 'alpha-skill' }).first().click();
  await expect(page).toHaveURL(ALPHA_SKILL_URL);
  const alphaEditor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await expect(alphaEditor).toBeVisible();
  await expect(alphaEditor).toHaveValue(ALPHA_SKILL_CONTENT);
  await expect(detail.getByText('Loading…', { exact: true })).toHaveCount(0);
  await waitForHydratedSkills(page);
});

test('saves with Control+S and Meta+S while accepting immediate follow-up edits', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const editor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const saveButton = detail.getByRole('button', { exact: true, name: 'Save' });

  await expect(editor).toBeVisible();
  await editor.fill('# Saved with the keyboard\n');
  await editor.press('Control+s');

  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('# Saved with the keyboard\n');
  await expect(editor).toBeEditable();

  await editor.fill('# Second immediate edit\n');

  await expect(editor).toHaveValue('# Second immediate edit\n');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
  await expect(saveButton).toBeEnabled();

  await editor.press('Meta+s');

  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('# Second immediate edit\n');
  await expect(saveButton).toBeDisabled();
});

test('wraps long SKILL.md prose without changing the source value', async ({ page }) => {
  const longProse = `# Long prose\n\n${'Readable prose should wrap inside the authoring surface. '.repeat(180)}\n`;
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const editor = page.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
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
  await interceptSaveResultForDraft(page, 'Browser conflict draft', {
    data: { reason: 'conflict' },
    ok: true,
  });
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const editor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await editor.fill(draft);
  await detail.getByRole('button', { exact: true, name: 'Save' }).click();

  await expect(page.getByRole('alert')).toHaveText('Changed on disk');
  await expect(page.getByText('Changed on disk', { exact: true })).toHaveCount(1);
  await expect(editor).toHaveValue(draft);
  await expect(editor).toBeEditable();
  await expect(detail.getByRole('button', { exact: true, name: 'Save' })).toBeDisabled();
  await expect(detail.getByRole('button', { name: 'Reload from disk' })).toBeEnabled();
});

test('preserves the exact local draft after another save failure', async ({ page }) => {
  const draft = '# Browser failed-save draft\n\nKeep this too.\n';
  await interceptSaveResultForDraft(page, 'Browser failed-save draft', {
    error: { message: 'Storage unavailable', tag: 'E2ESaveFailure' },
    ok: false,
  });
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const editor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await editor.fill(draft);
  await detail.getByRole('button', { exact: true, name: 'Save' }).click();

  await expect(page.getByRole('alert')).toHaveText('Storage unavailable');
  await expect(page.getByText('Storage unavailable', { exact: true })).toHaveCount(1);
  await expect(editor).toHaveValue(draft);
  await expect(editor).toBeEditable();
  await expect(detail.getByRole('button', { exact: true, name: 'Save' })).toBeEnabled();
  await expect(detail.getByRole('button', { name: 'Revert changes' })).toBeEnabled();
});

test('saves SKILL.md source without installing it into runtimes', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const editor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const installedIn = inspector.getByRole('group', { name: 'Installed in' });

  await expect(editor).toBeVisible();
  await expect(inspector.getByText('Linked', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Not linked', { exact: true })).toBeVisible();
  const runtimeStatesBeforeSave = (await installedIn.getByRole('group').allTextContents()).map(normalizeText);

  await editor.fill('# Source-only change\n');
  await detail.getByRole('button', { exact: true, name: 'Save' }).click();

  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Linked', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Not linked', { exact: true })).toBeVisible();
  const runtimeStatesAfterSave = (await installedIn.getByRole('group').allTextContents()).map(normalizeText);
  expect(runtimeStatesAfterSave).toEqual(runtimeStatesBeforeSave);
  await expect(page.getByText('alpha-skill linked to Codex.', { exact: true })).toHaveCount(0);
});

test('protects an unsaved SKILL.md draft during navigation and reload', async ({ browserFailureGate, page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  await expect(page.getByRole('heading', { level: 2, name: 'alpha-skill' })).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const betaSkillLink = page.getByRole('link', { exact: true, name: 'beta-skill' }).first();
  await editor.fill('# Unsaved local draft\n');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

  const releaseGuardedNavigationAbort = browserFailureGate.allowRequestAbortOnce({
    pathname: '/skills/global/beta-skill/__data.json',
    resourceType: 'fetch',
  });
  await betaSkillLink.press('Enter');
  const discardDialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(discardDialog).toBeVisible();
  releaseGuardedNavigationAbort();
  await discardDialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(ALPHA_SKILL_URL);
  await expect(editor).toHaveValue('# Unsaved local draft\n');
  await expect(editor).toBeFocused();

  await page.getByRole('button', { name: 'Reload from disk' }).click();
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(discardDialog).toBeHidden();
  await expect(editor).toHaveValue('# Unsaved local draft\n');
  await expect(editor).toBeFocused();

  await page.getByRole('button', { name: 'Reload from disk' }).click();
  await discardDialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(discardDialog).toBeHidden();
  await expect(editor).toHaveValue(ALPHA_SKILL_CONTENT);
  await expect(page.getByText('Unchanged', { exact: true })).toBeVisible();

  await editor.fill('# Discard before navigation\n');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await betaSkillLink.press('Enter');
  await discardDialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(BETA_SKILL_URL);
  await expect(page.getByRole('heading', { level: 2, name: 'beta-skill' })).toBeVisible();
});

test('refreshes the skills snapshot and inventories without silently replacing a draft', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');
  const editor = page.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await editor.fill('# Preserve me during refresh\n');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

  const refreshButton = page.getByRole('button', { name: 'Refresh skills' });
  await refreshButton.click();

  const discardDialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(discardDialog).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'alpha-skill' })).toBeVisible();
  const keepEditingButton = discardDialog.getByRole('button', { name: 'Keep editing' });
  const discardChangesButton = discardDialog.getByRole('button', { name: 'Discard changes' });
  await expect(keepEditingButton).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(discardChangesButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(keepEditingButton).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(discardDialog).toBeHidden();
  await expect(editor).toHaveValue('# Preserve me during refresh\n');
  await expect(refreshButton).toBeFocused();
  await expect(page).toHaveURL(ALPHA_SKILL_URL);

  await refreshButton.click();
  await page.clock.install();
  await discardDialog.getByRole('button', { name: 'Discard changes' }).click();

  await expect(discardDialog).toBeHidden();
  const refreshNotice = page.getByRole('status').filter({ hasText: 'Skills refreshed.' });
  await expect(refreshNotice).toBeVisible();
  await expect(refreshNotice).toHaveCSS('position', 'fixed');
  await expect(refreshNotice).toHaveCSS('pointer-events', 'none');
  await page.clock.fastForward(SUCCESS_NOTICE_DISMISS_DELAY_MS);
  await expect(refreshNotice).toBeHidden();
  await expect(page.getByRole('link', { exact: true, name: 'alpha-skill' })).toHaveCount(0);
  await page.getByRole('link', { exact: true, name: 'beta-skill' }).first().click();
  await expect(page).toHaveURL(BETA_SKILL_URL);
  await expect(page.getByRole('heading', { level: 2, name: 'beta-skill' })).toBeVisible();
});

test('preserves a source repository draft across an unrelated snapshot refresh', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global');
  await page.getByText('Configuration & runtimes').click();

  const sourceRepository = page.getByRole('textbox', { name: 'Source repository' });
  await sourceRepository.fill('/fixture/unsaved-source-draft');
  await page.getByRole('button', { name: 'Refresh skills' }).click();

  await expect(sourceRepository).toHaveValue('/fixture/unsaved-source-draft');
});

test('keeps every Skills mutation inside the deterministic E2E backend', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global');
  await page.getByText('Configuration & runtimes').click();

  await page.getByRole('button', { name: 'Save source' }).click();
  await expect(page.getByText('Skill source saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Create directory' }).first().click();
  await expect(page.getByText(CREATED_TARGET_PATTERN)).toBeVisible();

  await page.getByRole('link', { exact: true, name: 'alpha-skill' }).first().click();
  // The skill's operations live in the summary band above the editor.
  const band = page.locator('[data-skill-summary-band]');
  await band.getByRole('button', { exact: true, name: 'Install' }).click();
  await expect(page.getByText('alpha-skill linked to Codex.')).toBeVisible();
  await band.getByRole('button', { name: 'Disable' }).click();
  await expect(band.getByRole('button', { name: 'Enable' })).toBeVisible();

  await openHydratedSkills(page, '/skills/matrix');
  await page.getByRole('button', { name: 'Preview reconcile' }).first().click();
  await page.getByRole('button', { name: APPLY_ACTION_PATTERN }).first().click();
  await expect(page.getByText('alpha-skill linked to Codex.')).toBeVisible();
});

test('keeps the inspector for facts and the summary band as the one place for actions', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 2, name: 'Inspector' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Validation' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Document' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Source' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Installed in' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Actions' })).toHaveCount(0);

  // The band above the editor is where the operations live — still exactly one of each on the page.
  const band = page.locator('[data-skill-summary-band]');
  await expect(band).toBeVisible();
  await expect(page.getByRole('button', { name: SKILL_TOGGLE_ACTION_PATTERN })).toHaveCount(1);
  await expect(band.getByRole('button', { name: SKILL_TOGGLE_ACTION_PATTERN })).toHaveCount(1);
  await expect(page.getByRole('button', { exact: true, name: 'Install' })).toHaveCount(1);
  await expect(page.getByRole('button', { exact: true, name: 'Repair' })).toHaveCount(0);
  await expect(page.getByRole('button', { exact: true, name: 'Review installation' })).toHaveCount(0);
});

test('keeps the tree, editor, and Inspector in one bounded desktop workspace row', async ({ page }) => {
  await page.setViewportSize(DESKTOP_WORKSPACE_VIEWPORT);
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const tree = page.getByRole('complementary', { name: 'Skill scopes' }).last();
  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const editor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const editorHeading = detail.getByRole('heading', { level: 3, name: 'SKILL.md' });
  const editorStatus = detail.getByText('Unchanged', { exact: true });
  const saveButton = detail.getByRole('button', { exact: true, name: 'Save' });
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const editorToolbar = editorStatus.locator('..');
  const editorActions = saveButton.locator('..');
  await expect(tree).toBeVisible();
  await expect(detail).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(editorHeading).toBeVisible();
  await expect(editorStatus).toBeVisible();
  await expect(saveButton).toBeVisible();
  await expect(inspector).toBeVisible();

  const [
    treeBox,
    detailBox,
    editorBox,
    editorHeadingBox,
    editorStatusBox,
    saveButtonBox,
    editorToolbarBox,
    editorActionsBox,
    inspectorBox,
  ] = await Promise.all([
    tree.boundingBox(),
    detail.boundingBox(),
    editor.boundingBox(),
    editorHeading.boundingBox(),
    editorStatus.boundingBox(),
    saveButton.boundingBox(),
    editorToolbar.boundingBox(),
    editorActions.boundingBox(),
    inspector.boundingBox(),
  ]);
  expect(treeBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(inspectorBox).not.toBeNull();
  expect(editorBox).not.toBeNull();
  expect(editorHeadingBox).not.toBeNull();
  expect(editorStatusBox).not.toBeNull();
  expect(saveButtonBox).not.toBeNull();

  const rowTops = [treeBox?.y ?? 0, detailBox?.y ?? 0, inspectorBox?.y ?? 0];
  expect(Math.max(...rowTops) - Math.min(...rowTops)).toBeLessThanOrEqual(1);
  expect(editorToolbarBox).not.toBeNull();
  expect(editorActionsBox).not.toBeNull();
  expect(editorHeadingBox?.x ?? -1).toBeGreaterThanOrEqual(editorToolbarBox?.x ?? 0);
  expect((editorHeadingBox?.x ?? 0) + (editorHeadingBox?.width ?? 0)).toBeLessThanOrEqual(
    (editorToolbarBox?.x ?? 0) + (editorToolbarBox?.width ?? 0),
  );
  expect(editorStatusBox?.x ?? -1).toBeGreaterThanOrEqual(editorToolbarBox?.x ?? 0);
  expect((editorStatusBox?.x ?? 0) + (editorStatusBox?.width ?? 0)).toBeLessThanOrEqual(
    (editorToolbarBox?.x ?? 0) + (editorToolbarBox?.width ?? 0),
  );
  expect(await editorHeading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await editorStatus.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((treeBox?.x ?? 0) + (treeBox?.width ?? 0)).toBeLessThanOrEqual(detailBox?.x ?? 0);
  expect(treeBox?.width ?? 0).toBeGreaterThanOrEqual(MIN_DESKTOP_TREE_WIDTH_PX);
  expect(editorBox?.width ?? 0).toBeGreaterThanOrEqual(MIN_DESKTOP_EDITOR_WIDTH_PX);
  expect(inspectorBox?.width ?? 0).toBeGreaterThanOrEqual(MIN_DESKTOP_INSPECTOR_WIDTH_PX);
  expect(editorStatusBox?.y ?? 0).toBeLessThan(editorBox?.y ?? 0);
  expect((editorStatusBox?.y ?? 0) + (editorStatusBox?.height ?? 0)).toBeLessThanOrEqual(editorBox?.y ?? 0);
  expect(saveButtonBox?.y ?? 0).toBeLessThan(editorBox?.y ?? 0);
  expect((saveButtonBox?.y ?? 0) + (saveButtonBox?.height ?? 0)).toBeLessThanOrEqual(editorBox?.y ?? 0);
  expect(editorBox?.x ?? 0).toBeGreaterThanOrEqual(detailBox?.x ?? 0);
  expect((editorBox?.x ?? 0) + (editorBox?.width ?? 0)).toBeLessThanOrEqual(
    (detailBox?.x ?? 0) + (detailBox?.width ?? 0),
  );
  expect((detailBox?.x ?? 0) + (detailBox?.width ?? 0)).toBeLessThanOrEqual(inspectorBox?.x ?? 0);
  expect(inspectorBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((editorToolbarBox?.y ?? 0) + (editorToolbarBox?.height ?? 0)).toBeLessThanOrEqual(editorActionsBox?.y ?? 0);
  expect((editorActionsBox?.y ?? 0) + (editorActionsBox?.height ?? 0)).toBeLessThanOrEqual(editorBox?.y ?? 0);
  expect((inspectorBox?.x ?? 0) + (inspectorBox?.width ?? 0)).toBeLessThanOrEqual(DESKTOP_WORKSPACE_VIEWPORT.width);
  expect(inspectorBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(inspectorBox?.y ?? DESKTOP_WORKSPACE_VIEWPORT.height).toBeLessThan(DESKTOP_WORKSPACE_VIEWPORT.height);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);
  await page.setViewportSize({ height: 900, width: 768 });
  const narrowEditorHeading = detail.getByRole('heading', { level: 3, name: 'SKILL.md' });
  await expect(narrowEditorHeading).toHaveCSS('overflow-wrap', 'anywhere');
  const narrowEditorToolbar = narrowEditorHeading.locator('..');
  const [narrowEditorHeadingBox, narrowEditorToolbarBox] = await Promise.all([
    narrowEditorHeading.boundingBox(),
    narrowEditorToolbar.boundingBox(),
  ]);
  expect(narrowEditorHeadingBox).not.toBeNull();
  expect(narrowEditorToolbarBox).not.toBeNull();
  // The heading has to wrap inside its toolbar rather than spill past it. How many lines that takes
  // depends on how much room the rail leaves the editor, so assert containment, not a line count.
  expect((narrowEditorHeadingBox?.x ?? 0) + (narrowEditorHeadingBox?.width ?? 0)).toBeLessThanOrEqual(
    (narrowEditorToolbarBox?.x ?? 0) + (narrowEditorToolbarBox?.width ?? 0),
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);
});

test('bounds long scope labels and makes validation findings individually identifiable', async ({ page }) => {
  await openHydratedSkills(page, '/skills/global/beta-skill');

  const tree = page.getByRole('complementary', { exact: true, name: 'Skill scopes' });
  await tree.getByText('Projects without skills').click();
  const scopeName = tree.locator('[data-skill-scope-name]').filter({ hasText: LONG_PROJECT_LABEL });
  await expect(scopeName).toHaveCount(1);
  await expect(scopeName).toBeVisible();
  const emptyScopeLink = scopeName.locator('..');
  const emptyScopeCount = emptyScopeLink.getByText('0', { exact: true });
  await expect(emptyScopeCount).toBeVisible();
  await expect(scopeName).toHaveCSS('text-overflow', 'ellipsis');
  await expect
    .poll(() =>
      scopeName.evaluate((element) => {
        const scopeLink = element.closest('a');
        return (
          element.isConnected &&
          element.scrollWidth > element.clientWidth &&
          scopeLink !== null &&
          scopeLink.scrollWidth <= scopeLink.clientWidth
        );
      }),
    )
    .toBe(true);
  const [emptyScopeNameBox, emptyScopeCountBox, emptyScopeLinkBox] = await Promise.all([
    scopeName.boundingBox(),
    emptyScopeCount.boundingBox(),
    emptyScopeLink.boundingBox(),
  ]);
  expect(emptyScopeNameBox).not.toBeNull();
  expect(emptyScopeCountBox).not.toBeNull();
  expect(emptyScopeLinkBox).not.toBeNull();
  expect((emptyScopeNameBox?.x ?? 0) + (emptyScopeNameBox?.width ?? 0)).toBeLessThanOrEqual(emptyScopeCountBox?.x ?? 0);
  const emptyScopeNameCenter = (emptyScopeNameBox?.y ?? 0) + (emptyScopeNameBox?.height ?? 0) / 2;
  const emptyScopeCountCenter = (emptyScopeCountBox?.y ?? 0) + (emptyScopeCountBox?.height ?? 0) / 2;
  expect(Math.abs(emptyScopeNameCenter - emptyScopeCountCenter)).toBeLessThanOrEqual(1);
  expect((emptyScopeCountBox?.x ?? 0) + (emptyScopeCountBox?.width ?? 0)).toBeLessThanOrEqual(
    (emptyScopeLinkBox?.x ?? 0) + (emptyScopeLinkBox?.width ?? 0),
  );

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const findings = inspector.locator('[data-validation-finding]');
  await expect(findings).toHaveCount(2);
  await expect(findings.nth(0)).toHaveAccessibleName('Finding 1: warning');
  await expect(findings.nth(0)).toContainText('Finding 1');
  await expect(findings.nth(0)).toContainText('Skill document token warning');
  await expect(page.getByText('SkillMarkdownTokenWarning', { exact: true })).toHaveCount(0);
  await expect(findings.nth(0)).toContainText('SKILL.md is approaching the recommended token limit.');
  await expect(findings.nth(0)).toContainText('1,240 / 1,000 tokens');
  await expect(findings.nth(1)).toHaveAccessibleName('Finding 2: warning');
  await expect(findings.nth(1)).toContainText('Finding 2');
  await expect(findings.nth(1)).toContainText('SkillReferenceTokenWarning');
  await expect(findings.nth(1)).toContainText('Reference files are approaching the recommended token limit.');
  await expect(findings.nth(1)).toContainText('2,400 / 2,000 tokens');
  await expect(page.getByText('warning', { exact: true })).toHaveCount(1);

  const diagnosticCode = findings.nth(0).getByText('Skill document token warning', { exact: true });
  const diagnosticDimensions = await diagnosticCode.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(diagnosticDimensions.scrollWidth).toBeLessThanOrEqual(diagnosticDimensions.clientWidth);
});

test('keeps colliding scope names legible and says each health number once', async ({ page }) => {
  await page.setViewportSize({ height: 1080, width: 1920 });
  await openHydratedSkills(page, '/skills/global');

  const tree = page.getByRole('complementary', { exact: true, name: 'Skill scopes' });
  const twins = tree.locator('[data-skill-scope-name]').filter({ hasText: 'Opaque project' });
  await expect(twins).toHaveCount(2);
  for (const twin of await twins.all()) {
    expect(await twin.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await twin.getAttribute('title')).toBe((await twin.textContent())?.trim());
  }

  const paths = tree.locator('[data-skill-scope-path]');
  await expect(paths).toHaveCount(2);
  for (const path of await paths.all()) {
    expect(
      await path.evaluate((element) => {
        const name = element.previousElementSibling;
        return (
          name instanceof HTMLElement &&
          name.hasAttribute('data-skill-scope-name') &&
          element.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1
        );
      }),
    ).toBe(true);
  }

  expect((await tree.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(272);
  await expect(tree.getByRole('link', { name: 'alpha-skill' }).locator('span').first()).toHaveCSS(
    '-webkit-line-clamp',
    '2',
  );
  await expect(page.getByRole('status').filter({ hasText: PASSIVE_RELOAD_NOTICE })).toHaveCount(0);
  // The landing page states link health once, in its strip; "Healthy links" is the matrix tile's.
  await expect(page.getByText('Healthy links', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-skills-links-strip]')).toHaveCount(1);

  await tree.getByRole('button', { name: 'Expand Opaque project' }).nth(1).click();
  await tree.getByRole('link', { exact: true, name: 'twin-skill' }).click();
  await expect(page.getByText('Opaque twin project skill fixture', { exact: true })).toBeVisible();

  await page.setViewportSize({ height: 900, width: 1280 });
  for (const twin of await twins.all()) {
    expect(await twin.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});

test('renders matrix health states with their public computed color tokens', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await openMatrixWithSnapshot(
    page,
    (snapshot) => ({
      ...snapshot,
      projections: snapshot.projections.map((projection) => ({ ...projection, state: 'missing' })),
    }),
    '0',
  );

  const healthyLinksValue = page.getByRole('button', { name: HEALTHY_LINKS_PATTERN }).locator('[data-health-tone]');
  await expect(healthyLinksValue).toHaveAttribute('data-health-tone', 'danger');
  await expectColorToken(healthyLinksValue, '--colors-status-danger');

  await openMatrixWithSnapshot(
    page,
    (snapshot) => ({
      ...snapshot,
      projections: snapshot.projections.map((projection, index) => ({
        ...projection,
        state: index === 0 ? 'missing' : 'linked',
      })),
    }),
    '1',
  );
  await expect(healthyLinksValue).toHaveAttribute('data-health-tone', 'warn');
  await expectColorToken(healthyLinksValue, '--colors-status-warn');

  await openMatrixWithSnapshot(page, (snapshot) => snapshot, '2');
  await expect(healthyLinksValue).toHaveAttribute('data-health-tone', 'ok');
  await expectColorToken(healthyLinksValue, '--colors-status-ok');

  await openMatrixWithSnapshot(
    page,
    (snapshot) => ({
      ...snapshot,
      targets: snapshot.targets.map((target) => ({ ...target, enabled: false })),
    }),
    '0',
  );
  await expect(healthyLinksValue).toHaveAttribute('data-health-tone', 'neutral');
  await expectColorToken(healthyLinksValue, '--colors-ink');
});

test('opens the landing page on verdict tiles, a links strip, and the joined inventory', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await openHydratedSkills(page, '/skills/global');

  const detail = page.getByRole('region', { name: 'Selected skill detail' });

  // One links strip, one taxonomy, the fraction toned with the real token.
  const strip = detail.locator('[data-skills-links-strip]');
  const stripTone = strip.locator('[data-links-tone="warn"]');
  await expect(stripTone).toContainText('3/4');
  await expectColorToken(stripTone, '--colors-status-warn');
  await expect(strip).toContainText('to link');
  await expect(strip).toContainText('to repair');
  await expect(strip).toContainText('blocked');

  // The inventory joins both axes on one row: exposure marks beside skill signals and a verdict.
  const inventory = detail.getByRole('region', { name: 'Managed skills with skill signals' });
  const alphaRow = inventory.locator('[data-inventory-skill="alpha-skill"]');
  await expect(alphaRow).toContainText('declared 3');
  await expect(alphaRow).toContainText('invocation evidence');

  // The verdict tiles land on the matrix verdict groups by anchor.
  const adoptTile = detail.locator('[data-verdict-tile="adopt"]');
  await expect(adoptTile).toContainText('To adopt');
  await adoptTile.click();
  await expect(page).toHaveURL(ADOPTION_ANCHOR_URL);
  await expect(page.getByRole('region', { name: 'Invocation evidence, unmanaged' })).toBeVisible();

  // The strip's review link keeps the keyboard path to the matrix the tiles used to provide.
  await expectKeyboardMatrixNavigation(page, REVIEW_AND_RECONCILE_PATTERN);
});

test('stacks the global health disclosures in the tablet workspace', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await openHydratedSkills(page, '/skills/global');

  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const disabledDisclosure = detail.getByText('Disabled', { exact: true }).locator('../..');
  const configurationDisclosure = detail.locator('[data-skills-configuration]');
  const [detailBox, disabledBox, configurationBox] = await Promise.all([
    detail.boundingBox(),
    disabledDisclosure.boundingBox(),
    configurationDisclosure.boundingBox(),
  ]);
  expect(detailBox).not.toBeNull();
  expect(disabledBox).not.toBeNull();
  expect(configurationBox).not.toBeNull();
  expect(disabledBox?.width ?? 0).toBeGreaterThan((detailBox?.width ?? 0) * 0.9);
  expect(configurationBox?.width ?? 0).toBeGreaterThan((detailBox?.width ?? 0) * 0.9);
  expect(configurationBox?.y ?? 0).toBeGreaterThanOrEqual(
    (disabledBox?.y ?? 0) + (disabledBox?.height ?? 0) + SKILLS_DETAIL_GAP_PX - 1,
  );
});

test('presents unmanaged copies as neutral backlog rows with their reconciliation action', async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await openHydratedSkills(page, '/skills/global');

  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const inspector = page.getByRole('complementary', { name: 'Selection actions' });
  const attentionHeading = detail.getByRole('heading', { level: 3, name: 'Needs attention' });
  const attentionHeader = attentionHeading.locator('..');
  const consolidation = page.locator('[data-consolidation-panel]');
  await expect(detail.getByRole('heading', { level: 2, name: 'Global skills' })).toBeVisible();
  await expect(attentionHeading).toBeVisible();
  await expect(detail.locator('[data-consolidation-panel]')).toBeVisible();
  await expect(detail.locator('[data-skills-configuration]')).toBeVisible();
  await expect(inspector.locator('[data-consolidation-panel]')).toHaveCount(0);
  await expect(inspector.locator('[data-skills-configuration]')).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Exposure matrix' })).toBeVisible();
  await expect(attentionHeader).toHaveCSS('display', 'grid');
  await expect(attentionHeader).toHaveCSS('gap', `${SKILLS_SECTION_HEADER_GAP_PX}px`);
  const [detailBox, inspectorBox] = await Promise.all([detail.boundingBox(), inspector.boundingBox()]);
  expect(detailBox?.height ?? 0).toBeGreaterThan(600);
  expect(inspectorBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(350);
  const disabledDisclosure = detail.getByText('Disabled', { exact: true }).locator('../..');
  const configurationDisclosure = detail.locator('[data-skills-configuration]');
  const [consolidationBox, disabledDisclosureBox, configurationDisclosureBox] = await Promise.all([
    consolidation.boundingBox(),
    disabledDisclosure.boundingBox(),
    configurationDisclosure.boundingBox(),
  ]);
  expect(consolidationBox).not.toBeNull();
  expect(disabledDisclosureBox).not.toBeNull();
  expect(configurationDisclosureBox).not.toBeNull();
  expect(Math.abs((disabledDisclosureBox?.y ?? 0) - (configurationDisclosureBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(configurationDisclosureBox?.width ?? 0).toBeGreaterThan(disabledDisclosureBox?.width ?? 0);
  expect((disabledDisclosureBox?.y ?? 0) - ((consolidationBox?.y ?? 0) + (consolidationBox?.height ?? 0))).toBe(
    SKILLS_DETAIL_GAP_PX,
  );

  await consolidation.locator(':scope > summary').click();
  await consolidation.locator('details > summary').click();
  const unmanagedRow = consolidation.locator('[data-unmanaged-entry]');
  await expect(unmanagedRow).toHaveCount(1);
  await expect(unmanagedRow).toHaveAttribute('data-backlog-tone', 'neutral');
  await expect(unmanagedRow).toContainText('legacy-local-copy');
  // The backlog row states its invocation evidence — the fact adoption or deletion is decided from —
  // instead of repeating one identical navigation button per entry.
  await expect(unmanagedRow.locator('[data-unmanaged-entry-usage]')).toHaveText('no invocation recorded');
  await consolidation.getByRole('button', { name: 'Review in the matrix' }).click();
  await expect(page).toHaveURL(SKILLS_MATRIX_URL);
  await expect(page.getByRole('heading', { level: 2, name: 'Managed skills — exposure per runtime' })).toBeVisible();
});

test('prioritizes the editor on mobile and keeps the compact picker behavior', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openHydratedSkills(page, '/skills/global/alpha-skill');

  const picker = page.getByRole('group', { name: 'Skill picker' });
  const editor = page.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const saveButton = page.getByRole('button', { exact: true, name: 'Save' });

  await expect(picker).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Skill scopes' }).last()).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText('No validation diagnostics.')).toBeHidden();
  await expect(inspector.getByText('Total tokens', { exact: true })).toBeHidden();
  await expect(inspector.getByText('Source path', { exact: true })).toBeHidden();
  await expect(inspector.getByText('Claude Code', { exact: true })).toBeHidden();
  await expect(inspector.getByRole('button', { name: 'Disable' })).toBeHidden();

  const inspectorElement = await inspector.elementHandle();
  const editorPrecedesInspector = await editor.evaluate((element, target) => {
    if (target === null) {
      return false;
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: compareDocumentPosition returns a bitmask.
    return (element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }, inspectorElement);
  expect(editorPrecedesInspector).toBe(true);
  const saveButtonElement = await saveButton.elementHandle();
  const editorPrecedesActions = await editor.evaluate((element, target) => {
    if (target === null) {
      return false;
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: compareDocumentPosition returns a bitmask.
    return (element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }, saveButtonElement);
  expect(editorPrecedesActions).toBe(true);

  await editor.fill('# Reachable mobile save\n');
  await expect(saveButton).toBeEnabled();
  await saveButton.scrollIntoViewIfNeeded();
  const saveButtonBox = await saveButton.boundingBox();
  expect(saveButtonBox).not.toBeNull();
  expect(saveButtonBox?.x).toBeGreaterThanOrEqual(0);
  expect((saveButtonBox?.x ?? 0) + (saveButtonBox?.width ?? 0)).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  expect(saveButtonBox?.y).toBeGreaterThanOrEqual(0);
  expect((saveButtonBox?.y ?? 0) + (saveButtonBox?.height ?? 0)).toBeLessThanOrEqual(MOBILE_VIEWPORT.height);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);

  await page.getByRole('button', { name: 'Revert changes' }).click();
  await picker.getByText('Browse skills').click();
  await picker.getByRole('link', { exact: true, name: 'beta-skill' }).click();

  await expect(page).toHaveURL(BETA_SKILL_URL);
  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  await expect(detail).toBeFocused();
  const detailBox = await detail.boundingBox();
  expect(detailBox?.y).toBeGreaterThanOrEqual(0);
  expect(detailBox?.y).toBeLessThan(300);
});

test('renders matrix cards on mobile and preserves the desktop comparison table', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openHydratedSkills(page, '/skills/matrix');

  const mobileCards = page.getByRole('list', { name: 'Managed skills by runtime' });
  await expect(mobileCards).toBeVisible();
  await expect(mobileCards.getByRole('listitem').first()).toContainText('Auto');
  await expect(mobileCards.getByRole('listitem').first()).toContainText('4 tok');
  await expect(matrixTable(page)).toBeHidden();

  await page.setViewportSize({ height: 800, width: 1280 });
  const table = matrixTable(page);
  await expect(table).toBeVisible();
  await expect(table).toHaveCSS('border-collapse', 'separate');
  await expect(table).toHaveCSS('font-size', '13px');
  const stateBox = await table.getByRole('img').first().boundingBox();
  // The letterform exposure marks are 18px squares — shape and letter carry the state.
  expect(stateBox?.width).toBe(18);
  await expect(mobileCards).toBeHidden();
  const inspector = page.getByRole('complementary', { name: 'Selection actions' });
  await expect(inspector.locator('[data-skills-configuration]')).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Close matrix' })).toBeVisible();
  const inspectorBox = await inspector.boundingBox();
  expect(inspectorBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(350);
});

test('keeps matrix tiles, names, and the table legible beside the tree at 1280', async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 1280 });
  await openHydratedSkills(page, '/skills/matrix');

  const tiles = page.locator('[data-skills-health-tiles] > button');
  await expect(tiles).toHaveCount(6);
  for (const tile of await tiles.all()) {
    expect((await tile.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(150);
    const caption = tile.locator(':scope > div').first();
    expect(await caption.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(
      await caption.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      }),
    ).toBe(1);
  }

  const table = matrixTable(page);
  await expect(table).toHaveCSS('table-layout', 'auto');
  await expect(table).toHaveCSS('min-width', '0px');
  expect((await table.getByRole('columnheader', { name: 'Skill' }).boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(
    320,
  );
  expect(await table.locator('..').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const name = table.getByRole('link', { exact: true, name: 'alpha-skill' });
  await expect(name).toHaveCSS('overflow-wrap', 'break-word');
  expect(
    await name.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    }),
  ).toBe(1);

  const matrixSlot = page.locator('[data-skills-matrix-slot]');
  const inspector = page.getByRole('complementary', { name: 'Selection actions' });
  const [matrixBox, inspectorBox] = await Promise.all([matrixSlot.boundingBox(), inspector.boundingBox()]);
  expect(matrixBox?.width ?? 0).toBeGreaterThanOrEqual(700);
  expect(inspectorBox?.y ?? 0).toBeGreaterThanOrEqual((matrixBox?.y ?? 0) + (matrixBox?.height ?? 0) - 1);
  await expect(inspector.getByRole('button', { name: 'Close matrix' })).toBeVisible();
  await expect(page.getByText('Healthy links', { exact: true })).toHaveCount(1);

  await page.setViewportSize({ height: 1080, width: 1920 });
  for (const tile of await tiles.all()) {
    expect((await tile.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(150);
  }
  expect(await table.locator('..').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

// Plan 111 / ADR 0022. The three readings this surface must never produce: a zero for a harness
// that cannot observe, a total that sums two tiers, and a state carried by colour alone.
test('renders skill observations with their tier and never as an unobservable zero', async ({ page }) => {
  await page.setViewportSize(DESKTOP_WORKSPACE_VIEWPORT);
  await openHydratedSkills(page, '/skills/matrix');

  const panel = page.getByRole('region', { exact: true, name: 'Skill observations' });
  await expect(panel).toBeVisible();

  // (i) Cursor has no collector. The roster says so once, in words; the table carries no Cursor
  // column at all, so no row can ever read as a Cursor zero.
  await expect(panel.getByRole('listitem').filter({ hasText: CURSOR_COVERAGE_TEXT })).toBeVisible();
  await expect(panel.locator('[data-harness="cursor"]')).toHaveCount(0);

  // (ii) All three tiers are present, each as its own phrase; nothing sums declared and inferred.
  const alphaRow = panel
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: ALPHA_ROW_HEADER_PATTERN }) });
  await expect(alphaRow.locator('[data-harness="claude"]')).toHaveText('declared 3');
  await expect(alphaRow.locator('[data-harness="codex"]')).toHaveText('inferred 1 · exposed 2');
  await expect(alphaRow.locator('[data-harness="opencode"]')).toHaveText('declared 1');
  // Claude's 3 declared plus Codex's 1 inferred is not 4 of anything, and no cell offers a bare
  // number a reader could take for a total.
  for (const cell of await alphaRow.locator('[data-observation-state]').all()) {
    expect(normalizeText((await cell.textContent()) ?? '')).not.toMatch(BARE_NUMBER_PATTERN);
  }

  // (iii) Every observation state is a word. Nothing here is encoded only as a colour.
  const observationCells = panel.locator('[data-observation-state]');
  expect(await observationCells.count()).toBeGreaterThan(0);
  for (const cell of await observationCells.all()) {
    expect(normalizeText((await cell.textContent()) ?? '')).toMatch(OBSERVATION_TEXT_PATTERN);
  }

  // Each verdict has a home, and an observation resolving to no inventory entry is retained.
  const deletion = page.getByRole('region', { name: 'Projected everywhere, no invocation recorded' });
  const adoption = page.getByRole('region', { name: 'Invocation evidence, unmanaged' });
  const offered = page.getByRole('region', { name: 'Available to a model, no invocation recorded' });
  // beta-skill is managed and linked in every enabled runtime, so its silence is evidence.
  await expect(deletion.getByRole('listitem').filter({ hasText: 'beta-skill' })).toBeVisible();
  await expect(adoption.getByRole('listitem').filter({ hasText: 'artifact-design' })).toBeVisible();
  await expect(adoption.getByRole('listitem').filter({ hasText: 'pr-review' })).toBeVisible();
  // imagegen was only ever listed in a Codex catalogue. Availability is not invocation, so it must not
  // be proposed for adoption anywhere — it lives folded under its catalogue.
  await offered.locator('[data-skill-observations-catalogue="standalone"] > summary').click();
  await expect(offered.getByRole('listitem').filter({ hasText: 'imagegen' })).toBeVisible();
  await expect(adoption.getByRole('listitem').filter({ hasText: 'imagegen' })).toHaveCount(0);
  // alpha-skill is not linked to every target in the fixture, so its evidence is not a deletion story.
  await expect(deletion.getByRole('listitem').filter({ hasText: 'alpha-skill' })).toHaveCount(0);
  // A complete read states absence plainly rather than hedging it.
  await expect(deletion).toHaveAttribute('data-provisional', 'false');

  // The same facts on the skill detail surface, for one skill.
  await openHydratedSkills(page, '/skills/global/alpha-skill');
  const detail = page.getByRole('region', { name: 'Skill observations' });
  await expect(detail.getByRole('definition').filter({ hasText: 'declared 3' })).toBeVisible();
  await expect(detail.getByRole('definition').filter({ hasText: 'exposed 2' })).toBeVisible();
  await expect(detail.getByRole('definition').filter({ hasText: OBSERVATION_NOT_OBSERVABLE_TEXT })).toBeVisible();
  await expect(detail.getByText('Last signal', { exact: false })).toBeVisible();
  await expect(detail.getByText('Invocation evidence from at least one harness.')).toBeVisible();

  await openHydratedSkills(page, '/skills/global/beta-skill');
  const betaDetail = page.getByRole('region', { name: 'Skill observations' });
  await expect(betaDetail.getByText('No skill signal recorded by an observable harness.')).toBeVisible();
  await expect(
    betaDetail.getByText('Installed in every enabled runtime, with no invocation recorded — a deletion candidate.'),
  ).toBeVisible();
  // The e2e read is complete, so the sentence is stated rather than hedged. The provisional wording
  // is covered where a bounded read can be constructed, in the SSR suite.
  await expect(betaDetail.locator('[data-skill-observations-deletion-candidate]')).toHaveAttribute(
    'data-verdict-provisional',
    'false',
  );

  // A project-local skill, which is the majority of what a real machine holds. This detail branch
  // rendered a description and a read-only preview and nothing else, so every count for every
  // project skill was invisible exactly where the adoption decision gets made.
  await openHydratedSkills(page, '/skills/projects/project%2Fopaque/skill-name');
  const projectDetail = page.getByRole('region', { name: 'Skill observations' });
  await expect(projectDetail.getByRole('definition').filter({ hasText: 'declared 1' })).toBeVisible();
  await expect(projectDetail.getByRole('definition').filter({ hasText: 'inferred 1' })).toBeVisible();
  await expect(
    projectDetail.getByRole('definition').filter({ hasText: OBSERVATION_NOT_OBSERVABLE_TEXT }),
  ).toBeVisible();
  // The verdict follows the residence the real join computed: this install is owned by its own
  // project, so the sentence names that instead of prescribing adoption into the source repo.
  await expect(
    projectDetail.getByText('Invocation evidence — owned by a project repository, outside the shared source.', {
      exact: false,
    }),
  ).toBeVisible();
});
