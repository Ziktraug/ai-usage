import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openHydratedSkills, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';

const confirmImportPattern = /^Confirm import$/;

const expectAccessibleWithoutPageOverflow = async (page: Page): Promise<void> => {
  await page.evaluate(async () => await document.fonts.ready);
  expect(
    await page.evaluate(
      () =>
        Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.flatMap(({ target }) => target) }))).toEqual(
    [],
  );
};

for (const theme of ['light', 'dark'] as const) {
  for (const width of [390, 1440]) {
    test(`Atelier management retains accessible details and review controls at ${width}px in ${theme}`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript(() => localStorage.clear());
      const navigation = page.locator(
        `[data-app-navigation="${width < 768 ? 'mobile' : 'desktop'}"][data-hydrated="true"]`,
      );

      await page.goto('/sources');
      await expect(navigation).toBeVisible();
      await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Sources', level: 1 })).toBeVisible();
      await page.locator('[data-publication-details] > summary').click();
      await page.locator('[data-healthy-source-summary] > summary').click();
      await expect(page.getByRole('button', { name: 'Copy publication revision' })).toBeVisible();
      await expect(page.locator('[data-healthy-source-row]').first()).toBeVisible();
      await expectAccessibleWithoutPageOverflow(page);

      await page.goto('/sync');
      await expect(navigation).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Machine fleet', level: 2 })).toBeVisible();
      const rename = page.getByRole('button', { name: 'Rename', exact: true });
      await expect(rename).toBeEnabled();
      await rename.click();
      await expect(page.getByRole('textbox', { name: 'Machine label', exact: true })).toBeVisible();
      await expectAccessibleWithoutPageOverflow(page);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();

      await openHydratedSkills(page, '/skills');
      if (width === 390) {
        await page.route('**/rpc/skills/observations?*', async (route) => {
          const response = await route.fetch();
          const observations = decodeRpcResponseBody(await response.text());
          if (
            !(typeof observations === 'object' && observations !== null && 'producerProofValidUntil' in observations)
          ) {
            throw new Error('Expected observation producer proof in the Skills fixture.');
          }
          await route.fulfill({
            response,
            body: encodeRpcResponseBody({ ...observations, producerProofValidUntil: '1970-01-01T00:00:00.000Z' }),
          });
        });
        await page.getByRole('button', { name: 'Reconcile links…', exact: true }).click();
        for (const filter of ['to-delete', 'catalogue-only']) {
          await expect(page.locator(`[data-worktable-filter="${filter}"]`)).toContainText('provisional');
        }
        for (const metric of await page.locator('[data-worktable-filter]').all()) {
          expect(
            await metric.evaluate((button) => {
              const value = button.querySelector('[data-worktable-metric-value]');
              if (!value) {
                throw new Error('Expected a visible metric value.');
              }
              const bounds = button.getBoundingClientRect();
              const text = document.createRange();
              text.selectNodeContents(value);
              return [...text.getClientRects()].every(
                (rect) =>
                  rect.left >= bounds.left &&
                  rect.right <= bounds.right &&
                  rect.top >= bounds.top &&
                  rect.bottom <= bounds.bottom,
              );
            }),
          ).toBe(true);
        }
        await page
          .getByRole('region', { name: 'Reconcile plan' })
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
      }
      await page.locator('[data-skills-configuration] > summary').click();
      await page.locator('[data-consolidation-panel] > summary').click();
      await expect(page.getByRole('textbox', { name: 'Source repository' })).toBeVisible();
      await expectAccessibleWithoutPageOverflow(page);

      await page.locator('[data-worktable-row="alpha-skill"] a').click();
      const editor = page.getByRole('textbox', { name: 'alpha-skill SKILL.md', exact: true });
      await expect(editor).toBeVisible();
      if (width === 390) {
        const drawer = page.getByRole('dialog', { name: 'alpha-skill detail', exact: true });
        const bounds = await drawer.boundingBox();
        if (!bounds) {
          throw new Error('The skill drawer must expose its rendered bounds.');
        }
        const availableWidth = await page.evaluate(() => document.documentElement.clientWidth);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.width).toBeLessThanOrEqual(availableWidth);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(availableWidth);
      }
      const initialContent = await editor.inputValue();
      await editor.fill(`${initialContent}\nUnsaved Atelier layout check.`);
      await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toHaveAttribute('aria-labelledby', 'discard-skill-draft-title');
      await expect(confirmation.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
      await expectAccessibleWithoutPageOverflow(page);
      await page.keyboard.press('Escape');
      await expect(confirmation).toBeHidden();
      await expect(editor).toBeFocused();
      await expect(editor).toHaveValue(`${initialContent}\nUnsaved Atelier layout check.`);
      await page.keyboard.press('Escape');
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toHaveAttribute('aria-labelledby', 'discard-navigation-title');
      await expect(confirmation.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(confirmation).toBeHidden();
      await expect(editor).toBeFocused();
      await expect(editor).toHaveValue(`${initialContent}\nUnsaved Atelier layout check.`);
      await page.getByRole('button', { name: 'Revert changes', exact: true }).click();
      await expect(editor).toHaveValue(initialContent);
    });
  }
}

test('Atelier merge review keeps every effect visible and cancel never confirms the import', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  let confirmations = 0;
  let releasePreview = (): void => undefined;
  const previewRelease = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await page.route('**/api/manual-merge/upload', async (route) => {
    const action = route.request().headers()['x-ai-usage-merge-action'];
    if (action === 'confirm') {
      confirmations += 1;
    }
    await previewRelease;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          bundle: { generatedAt: '2026-07-30T12:00:00.000Z', machineId: 'atelier-peer', machineLabel: 'Atelier peer' },
          bytes: 2,
          confirmationToken: `v1.${'b'.repeat(64)}`,
          documentDigest: 'a'.repeat(64),
          kind: 'merge-preview',
          result: { deleted: 5, fleetChanged: true, inserted: 1, superseded: 4, unchanged: 3, updated: 2, warnings: 1 },
          rows: 15,
          warningCount: 1,
          warningItems: ['Review the newer peer contribution before importing.'],
        },
      }),
    });
  });
  await page.goto('/sync');
  const mergeInput = page.locator('input[type="file"][accept=".json,application/json"]');
  await expect(mergeInput).toBeEnabled();
  await mergeInput.setInputFiles({
    buffer: Buffer.from('{}'),
    mimeType: 'application/json',
    name: 'atelier-peer.json',
  });
  try {
    await expect(page.getByRole('button', { name: 'Drop a merge file here or choose a file' })).toBeDisabled();
    await expectAccessibleWithoutPageOverflow(page);
  } finally {
    releasePreview();
  }
  const preview = page.locator('[data-merge-import-preview]');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('1 inserted, 2 updated, 3 unchanged, 4 superseded, 5 deleted');
  await preview.locator('summary').click();
  await expect(preview).toContainText('Review the newer peer contribution before importing.');
  await expect(page.getByRole('button', { name: confirmImportPattern })).toBeEnabled();
  await expectAccessibleWithoutPageOverflow(page);
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(confirmations).toBe(0);
});
