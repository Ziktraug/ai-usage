import { expect, openHydratedReport, test } from './browser-test';

test('explores bounded motifs, preserves source links and exports a reviewable observation', async ({ page }) => {
  await openHydratedReport(page);
  await page.addScriptTag({ type: 'module', url: '/src/lib/features/prompts/prompt-exploration.e2e-fixture.ts' });
  await expect(page.getByRole('heading', { name: 'Patterns in the loaded prompts' })).toBeVisible();
  await expect(page.getByText('Only loaded pages are included;', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Open session · Synthetic alpha', exact: false }).first().click();
  await expect(page.getByText('Opened session: one', { exact: true })).toBeVisible();
  await page.getByLabel('Question to investigate').fill('Compare task context before changing guidance.');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export observation draft' }).click();
  expect((await download).suggestedFilename()).toBe('prompt-observation.md');
  await expect(page.getByRole('button', { name: 'Analyze loaded prompts locally' })).toBeDisabled();
});

test('does not download a semantic model or upload prompt text when opening the explorer', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') {
      requests.push(request.url());
    }
  });
  await openHydratedReport(page);
  await page.addScriptTag({ type: 'module', url: '/src/lib/features/prompts/prompt-exploration.e2e-fixture.ts' });
  await expect(page.getByRole('button', { name: 'Prepare local model' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Analyze loaded prompts locally' })).toBeDisabled();
  expect(requests).toEqual([]);
});
