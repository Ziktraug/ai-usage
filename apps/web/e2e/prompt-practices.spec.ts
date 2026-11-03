import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, openHydratedReport, test } from './browser-test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.Worker = class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage(message: { kind: string; texts?: string[] }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data:
              message.kind === 'prepare'
                ? { kind: 'ready' }
                : {
                    kind: 'result',
                    vectors: (message.texts ?? []).map(() => [1, ...Array.from({ length: 383 }, () => 0)]),
                  },
          }),
        );
      }
      terminate() {
        /* This deterministic fixture has no background work. */
      }
    } as unknown as typeof Worker;
  });
  await openHydratedReport(page);
  await page.addScriptTag({ type: 'module', url: '/src/lib/features/prompts/prompt-exploration.e2e-fixture.ts' });
  await page.getByRole('button', { name: 'Prepare local model' }).click();
  await page.getByRole('button', { name: 'Analyze loaded prompts locally' }).click();
  await expect(page.getByRole('region', { name: 'Editorial practices' })).toBeVisible();
});

test('compares distinct sessions with independently requested native results and retains notes', async ({
  page,
}, testInfo) => {
  await page.getByLabel('First session', { exact: true }).selectOption('one');
  await page.getByLabel('Second session', { exact: true }).selectOption('two');
  const left = page.getByRole('region', { name: 'Comparison session 1', exact: true });
  const right = page.getByRole('region', { name: 'Comparison session 2', exact: true });
  await expect(left.getByText('Fix the reported problems', { exact: true })).toBeVisible();
  await expect(right.getByText('Fix the reported problems', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Synthetic recorded response:', { exact: false })).toHaveCount(0);
  await left.getByRole('button', { name: 'Read recorded results', exact: true }).click();
  await expect(right.getByRole('button', { name: 'Read recorded results', exact: true })).toBeVisible();
  await left.getByText('Recorded response · Canonical turn 1', { exact: true }).click();
  await expect(left.getByText('Synthetic recorded response:', { exact: false })).toBeVisible();
  await right.getByRole('button', { name: 'Read recorded results', exact: true }).click();
  await right.getByText('Recorded response · Canonical turn 1', { exact: true }).click();
  await expect(right.getByText('Synthetic recorded response:', { exact: false })).toBeVisible();
  await page.getByLabel('First session', { exact: true }).selectOption('three');
  await expect(left.getByRole('button', { name: 'Read recorded results', exact: true })).toBeVisible();
  await expect(left.getByText('Synthetic recorded response:', { exact: false })).toHaveCount(0);
  await page.getByLabel('Observation notes').fill('Compare source context.');
  await page.getByLabel('Practice', { exact: true }).selectOption('fix');
  await page.getByLabel('Practice', { exact: true }).selectOption('review');
  await expect(page.getByLabel('Observation notes')).toHaveValue('Compare source context.');
  const inclusions = page
    .getByRole('region', { name: 'Local semantic exploration', exact: true })
    .getByRole('checkbox');
  for (const checkbox of await inclusions.all()) {
    await checkbox.uncheck();
  }
  await expect(page.getByLabel('Observation notes')).toHaveValue('Compare source context.');
  for (const checkbox of await inclusions.all()) {
    await checkbox.check();
  }
  await expect(page.getByLabel('Observation notes')).toHaveValue('Compare source context.');
  await page.screenshot({ path: testInfo.outputPath('practices-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('practices-mobile.png'), fullPage: true });
});

test('exports project-filtered sources and can export an explicit exclusion of every family', async ({ page }) => {
  await page.getByLabel('Project', { exact: true }).selectOption('Synthetic beta');
  await expect(page.getByLabel('First session', { exact: true })).toHaveValue('two');
  await expect(page.getByText('A second distinct session is not present in this selection.')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export practice dossier' }).click();
  const path = await (await download).path();
  if (!path) {
    throw new Error('Missing dossier download');
  }
  const contents = await readFile(path, 'utf8');
  expect(contents).toContain('Project selection: Synthetic beta');
  expect(contents).toContain('1 distinct sessions');
  expect(contents).toContain('two · two-review');
  expect(contents).not.toContain('one · one-review');
  const practices = page.getByRole('region', { name: 'Editorial practices' });
  await practices.getByText('Inspect and adjust this proposed grouping', { exact: true }).click();
  await practices.getByRole('checkbox').first().uncheck();
  await expect(practices.getByText('No included family matches', { exact: false })).toBeVisible();
  const excludedDownload = page.waitForEvent('download');
  await practices.getByRole('button', { name: 'Export practice dossier' }).click();
  const excludedPath = await (await excludedDownload).path();
  if (!excludedPath) {
    throw new Error('Missing exclusions download');
  }
  expect(await readFile(excludedPath, 'utf8')).toContain('review:review this branch private prompt sentinel');
});
