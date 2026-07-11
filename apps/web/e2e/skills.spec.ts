import { expect, test } from '@playwright/test';

const ALPHA_SKILL_URL = /\/skills\/global\/alpha-skill$/;
const APPLY_ACTION_PATTERN = /Apply 1 action|Apply$/;
const BETA_SKILL_URL = /\/skills\/global\/beta-skill$/;
const CREATED_TARGET_PATTERN = /Created target directory/;

test('protects an unsaved SKILL.md draft during navigation and reload', async ({ page }) => {
  await page.goto('/skills/global/alpha-skill');

  await expect(page.getByRole('heading', { level: 2, name: 'alpha-skill' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await editor.fill('# Unsaved local draft\n');

  await page.getByRole('link', { exact: true, name: 'beta-skill' }).first().click();
  const discardDialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(ALPHA_SKILL_URL);
  await expect(editor).toHaveValue('# Unsaved local draft\n');
  await expect(editor).toBeFocused();

  await page.getByRole('button', { name: 'Reload from disk' }).click();
  await page.keyboard.press('Escape');
  await expect(discardDialog).toBeHidden();
  await expect(editor).toHaveValue('# Unsaved local draft\n');
  await expect(editor).toBeFocused();

  await page.getByRole('link', { exact: true, name: 'beta-skill' }).first().click();
  await discardDialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(BETA_SKILL_URL);
  await expect(page.getByRole('heading', { level: 2, name: 'beta-skill' })).toBeVisible();
});

test('refreshes the skills snapshot and inventories without silently replacing a draft', async ({ page }) => {
  await page.goto('/skills/global/alpha-skill');
  await page.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('textbox', { name: 'alpha-skill SKILL.md' });
  await editor.fill('# Preserve me during refresh\n');

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
  await discardDialog.getByRole('button', { name: 'Discard changes' }).click();

  await expect(discardDialog).toBeHidden();
  await expect(page.getByText('Skills refreshed.')).toBeVisible();
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
  const selectedDetail = page.getByRole('region', { name: 'Selected skill detail' });
  await selectedDetail.getByRole('button', { name: 'Reconcile' }).click();
  await expect(page.getByText('alpha-skill linked to Codex.')).toBeVisible();
  await selectedDetail.getByRole('button', { name: 'Disable' }).click();
  await expect(selectedDetail.getByRole('button', { name: 'Enable' })).toBeVisible();

  await selectedDetail.getByRole('button', { name: 'Edit' }).click();
  await selectedDetail.getByRole('textbox', { name: 'alpha-skill SKILL.md' }).fill('# Saved fixture draft\n');
  await selectedDetail.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('SKILL.md saved.')).toBeVisible();

  await page.goto('/skills/matrix');
  await page.getByRole('button', { name: 'Preview reconcile' }).first().click();
  await page.getByRole('button', { name: APPLY_ACTION_PATTERN }).first().click();
  await expect(page.getByText('alpha-skill linked to Codex.')).toBeVisible();
});

test('uses a compact skill picker and focuses the selected detail on mobile', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/skills/global/alpha-skill');

  const picker = page.getByRole('group', { name: 'Skill picker' });
  await expect(picker).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Skill scopes' }).last()).toBeHidden();
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
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/skills/matrix');

  await expect(page.getByRole('list', { name: 'Managed skills by runtime' })).toBeVisible();
  await expect(page.getByRole('table')).toBeHidden();

  await page.setViewportSize({ height: 800, width: 1280 });
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Managed skills by runtime' })).toBeHidden();
});
