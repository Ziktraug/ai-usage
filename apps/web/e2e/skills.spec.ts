import type { Page } from '@playwright/test';
import { expect, test } from './browser-test';

const ALPHA_SKILL_CONTENT = '# alpha-skill\n\nDeterministic Playwright fixture.\n';
const ALPHA_SKILL_URL = /\/skills\/global\/alpha-skill$/;
const APPLY_ACTION_PATTERN = /Apply 1 action|Apply$/;
const DESKTOP_WORKSPACE_VIEWPORT = { height: 900, width: 1280 } as const;
const MIN_DESKTOP_EDITOR_WIDTH_PX = 320;
const MIN_DESKTOP_INSPECTOR_WIDTH_PX = 260;
const MIN_DESKTOP_TREE_WIDTH_PX = 190;
const BETA_SKILL_URL = /\/skills\/global\/beta-skill$/;
const CREATED_TARGET_PATTERN = /Created target directory/;
const LONG_PROJECT_LABEL = 'customer-analytics-platform-with-an-exceptionally-long-scope-name';
const MOBILE_VIEWPORT = { height: 844, width: 390 } as const;
const SKILL_TOGGLE_ACTION_PATTERN = /^(Disable|Enable)$/;
const SUCCESS_NOTICE_DISMISS_DELAY_MS = 5000;
const WHITESPACE_PATTERN = /\s+/g;

const normalizeText = (value: string): string => value.replace(WHITESPACE_PATTERN, ' ').trim();

const interceptSaveResultForDraft = async (page: Page, draftMarker: string, result: unknown): Promise<void> => {
  await page.route('**/_serverFn/**', async (route) => {
    if (!route.request().postData()?.includes(draftMarker)) {
      await route.continue();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ context: {}, result }),
      contentType: 'application/json',
      status: 200,
    });
  });
};

test('opens a managed SKILL.md as an immediately editable document and saves with the pointer', async ({ page }) => {
  await page.goto('/skills/global/alpha-skill');

  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const editor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const saveButton = detail.getByRole('button', { exact: true, name: 'Save' });
  const revertButton = detail.getByRole('button', { name: 'Revert changes' });

  await expect(page.getByRole('heading', { level: 2, name: 'alpha-skill' })).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(ALPHA_SKILL_CONTENT);
  await expect(detail.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
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

test('saves with Control+S and Meta+S while accepting immediate follow-up edits', async ({ page }) => {
  await page.goto('/skills/global/alpha-skill');

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
  await page.goto('/skills/global/alpha-skill');

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
  await page.goto('/skills/global/alpha-skill');

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
  await page.goto('/skills/global/alpha-skill');

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
  await page.goto('/skills/global/alpha-skill');

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

test('protects an unsaved SKILL.md draft during navigation and reload', async ({ page }) => {
  await page.goto('/skills/global/alpha-skill');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();

  await expect(page.getByRole('heading', { level: 2, name: 'alpha-skill' })).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const betaSkillLink = page.getByRole('link', { exact: true, name: 'beta-skill' }).first();
  await editor.fill('# Unsaved local draft\n');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

  await betaSkillLink.press('Enter');
  const discardDialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(discardDialog).toBeVisible();
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
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await editor.fill('# Discard before navigation\n');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await betaSkillLink.press('Enter');
  await discardDialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(BETA_SKILL_URL);
  await expect(page.getByRole('heading', { level: 2, name: 'beta-skill' })).toBeVisible();
});

test('refreshes the skills snapshot and inventories without silently replacing a draft', async ({ page }) => {
  await page.goto('/skills/global/alpha-skill');
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
  await page.goto('/skills/global');
  await page.getByText('Configuration & runtimes').click();

  const sourceRepository = page.getByRole('textbox', { name: 'Source repository' });
  await sourceRepository.fill('/fixture/unsaved-source-draft');
  await page.getByRole('button', { name: 'Refresh skills' }).click();

  await expect(sourceRepository).toHaveValue('/fixture/unsaved-source-draft');
});

test('keeps every Skills mutation inside the deterministic E2E backend', async ({ page }) => {
  await page.goto('/skills/global');
  await page.getByText('Configuration & runtimes').click();

  await page.getByRole('button', { name: 'Save source' }).click();
  await expect(page.getByText('Skill source saved.')).toBeVisible();

  await page.getByRole('button', { name: 'Create directory' }).first().click();
  await expect(page.getByText(CREATED_TARGET_PATTERN)).toBeVisible();

  await page.getByRole('link', { exact: true, name: 'alpha-skill' }).first().click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { exact: true, name: 'Install' }).click();
  await expect(page.getByText('alpha-skill linked to Codex.')).toBeVisible();
  await inspector.getByRole('button', { name: 'Disable' }).click();
  await expect(inspector.getByRole('button', { name: 'Enable' })).toBeVisible();

  await page.goto('/skills/matrix');
  await page.getByRole('button', { name: 'Preview reconcile' }).first().click();
  await page.getByRole('button', { name: APPLY_ACTION_PATTERN }).first().click();
  await expect(page.getByText('alpha-skill linked to Codex.')).toBeVisible();
});

test('shows the document inspector with actions in a single place', async ({ page }) => {
  await page.goto('/skills/global/alpha-skill');

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 2, name: 'Inspector' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Validation' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Document' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Source' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Installed in' })).toBeVisible();
  await expect(inspector.getByRole('heading', { level: 3, name: 'Actions' })).toBeVisible();

  await expect(page.getByRole('button', { name: SKILL_TOGGLE_ACTION_PATTERN })).toHaveCount(1);
  await expect(page.getByRole('button', { exact: true, name: 'Install' })).toHaveCount(1);
  await expect(page.getByRole('button', { exact: true, name: 'Repair' })).toHaveCount(0);
  await expect(page.getByRole('button', { exact: true, name: 'Review installation' })).toHaveCount(0);
});

test('keeps the tree, editor, and Inspector in one bounded desktop workspace row', async ({ page }) => {
  await page.setViewportSize(DESKTOP_WORKSPACE_VIEWPORT);
  await page.goto('/skills/global/alpha-skill');

  const tree = page.getByRole('complementary', { name: 'Skill scopes' }).last();
  const detail = page.getByRole('region', { name: 'Selected skill detail' });
  const editor = detail.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(tree).toBeVisible();
  await expect(detail).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(inspector).toBeVisible();

  const [treeBox, detailBox, editorBox, inspectorBox] = await Promise.all([
    tree.boundingBox(),
    detail.boundingBox(),
    editor.boundingBox(),
    inspector.boundingBox(),
  ]);
  expect(treeBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(inspectorBox).not.toBeNull();
  expect(editorBox).not.toBeNull();

  const rowTops = [treeBox?.y ?? 0, detailBox?.y ?? 0, inspectorBox?.y ?? 0];
  expect(Math.max(...rowTops) - Math.min(...rowTops)).toBeLessThanOrEqual(1);
  expect((treeBox?.x ?? 0) + (treeBox?.width ?? 0)).toBeLessThanOrEqual(detailBox?.x ?? 0);
  expect(treeBox?.width ?? 0).toBeGreaterThanOrEqual(MIN_DESKTOP_TREE_WIDTH_PX);
  expect(editorBox?.width ?? 0).toBeGreaterThanOrEqual(MIN_DESKTOP_EDITOR_WIDTH_PX);
  expect(inspectorBox?.width ?? 0).toBeGreaterThanOrEqual(MIN_DESKTOP_INSPECTOR_WIDTH_PX);
  expect(editorBox?.x ?? 0).toBeGreaterThanOrEqual(detailBox?.x ?? 0);
  expect((editorBox?.x ?? 0) + (editorBox?.width ?? 0)).toBeLessThanOrEqual(
    (detailBox?.x ?? 0) + (detailBox?.width ?? 0),
  );
  expect((detailBox?.x ?? 0) + (detailBox?.width ?? 0)).toBeLessThanOrEqual(inspectorBox?.x ?? 0);
  expect(inspectorBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((inspectorBox?.x ?? 0) + (inspectorBox?.width ?? 0)).toBeLessThanOrEqual(DESKTOP_WORKSPACE_VIEWPORT.width);
  expect(inspectorBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(inspectorBox?.y ?? DESKTOP_WORKSPACE_VIEWPORT.height).toBeLessThan(DESKTOP_WORKSPACE_VIEWPORT.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
});

test('bounds long scope labels and makes validation findings individually identifiable', async ({ page }) => {
  await page.goto('/skills/global/beta-skill');

  const tree = page.getByRole('complementary', { exact: true, name: 'Skill scopes' });
  await tree.getByText('Projects without skills').click();
  const scopeName = tree.locator('[data-skill-scope-name]').filter({ hasText: LONG_PROJECT_LABEL });
  await expect(scopeName).toHaveCount(1);
  await expect(scopeName).toBeVisible();
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

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const findings = inspector.locator('[data-validation-finding]');
  await expect(findings).toHaveCount(2);
  await expect(findings.nth(0)).toHaveAccessibleName('Finding 1: warning');
  await expect(findings.nth(0)).toContainText('Finding 1');
  await expect(findings.nth(0)).toContainText('SkillMarkdownTokenWarning');
  await expect(findings.nth(0)).toContainText('SKILL.md is approaching the recommended token limit.');
  await expect(findings.nth(1)).toHaveAccessibleName('Finding 2: warning');
  await expect(findings.nth(1)).toContainText('Finding 2');
  await expect(findings.nth(1)).toContainText('SkillReferenceTokenWarning');
  await expect(findings.nth(1)).toContainText('Reference files are approaching the recommended token limit.');
  await expect(page.getByText('warning', { exact: true })).toHaveCount(1);

  const diagnosticCode = findings.nth(0).getByText('SkillMarkdownTokenWarning', { exact: true });
  const diagnosticDimensions = await diagnosticCode.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(diagnosticDimensions.scrollWidth).toBeLessThanOrEqual(diagnosticDimensions.clientWidth);
});

test('prioritizes the editor on mobile and keeps the compact picker behavior', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto('/skills/global/alpha-skill');

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
  const editorPrecedesInspector = await editor.evaluate(
    (element, target) =>
      target !== null && (element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    inspectorElement,
  );
  expect(editorPrecedesInspector).toBe(true);
  const saveButtonElement = await saveButton.elementHandle();
  const editorPrecedesActions = await editor.evaluate(
    (element, target) =>
      target !== null && (element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    saveButtonElement,
  );
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );

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
  await page.goto('/skills/matrix');

  await expect(page.getByRole('list', { name: 'Managed skills by runtime' })).toBeVisible();
  await expect(page.getByRole('table')).toBeHidden();

  await page.setViewportSize({ height: 800, width: 1280 });
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Managed skills by runtime' })).toBeHidden();
});
