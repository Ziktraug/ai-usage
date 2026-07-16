import { collectionSourceDefinitions } from '@ai-usage/report-core/source-control';
import { expect, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const REVISION_PATTERN = /^e2e-revision-\d+$/;
const RUNNING_ELAPSED_PATTERN = /Running: Codex sessions \(\d+s elapsed\)/;
const NEXT_DUE_PATTERN = /Next due: .* at \d{4}-\d{2}-\d{2}T/;

const sourceCard = (page: Page, label: string) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { level: 3, name: label }) });

test('keeps business sources independent through a picked disable and publishes once', async ({ page }) => {
  await page.goto('/sources');
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();

  const sessions = sourceCard(page, 'Codex sessions');
  const quota = sourceCard(page, 'Codex usage limits');
  await expect(sessions).toBeVisible();
  await expect(quota).toBeVisible();
  await expect(sessions.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
  await expect(quota.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();

  const revisionText = page.getByText(REVISION_PATTERN).first();
  const initialRevision = Number((await revisionText.textContent())?.split('-').at(-1));
  await sessions.getByRole('button', { name: 'Run now' }).click();
  await expect(sessions.getByText('Running', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Report' }).click();
  const summary = page.getByRole('region', { name: 'Collection source status' });
  const summaryCard = summary.locator('[data-source-card]');
  await summary.hover();
  await expect(summaryCard).toBeVisible();
  const runningDetail = summaryCard.getByText(RUNNING_ELAPSED_PATTERN);
  await expect(runningDetail).toBeVisible();
  const firstElapsed = await runningDetail.textContent();
  await expect.poll(async () => runningDetail.textContent()).not.toBe(firstElapsed);
  await expect(summaryCard.getByText(NEXT_DUE_PATTERN)).toBeVisible();

  await summary.getByRole('link').focus();
  await expect(summaryCard).toBeVisible();
  await summary.getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();
  await sessions.getByRole('checkbox', { name: 'Enabled' }).uncheck();
  await expect(sessions.getByText('Pausing after current run', { exact: true })).toBeVisible();
  await expect(sessions.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(quota.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
  await expect
    .poll(async () => Number((await revisionText.textContent())?.split('-').at(-1)))
    .toBe(initialRevision + 1);

  await sessions.getByRole('checkbox', { name: 'Enabled' }).check();
  await expect(sessions.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
});

test('ignores a partial SSE snapshot after a complete catalogue', async ({ page }) => {
  const sources = collectionSourceDefinitions.map((definition) => ({
    availability: 'detected',
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: 'success',
    lifecycle: 'scheduled',
    policy: 'enabled',
    reason: { code: 'none' },
    warnings: [],
  }));
  const complete = {
    generatedAt: '2026-07-16T10:00:00.000Z',
    generation: 10,
    instanceId: 'e2e-intercept',
    publication: {
      acknowledgedRequestGeneration: 1,
      dirty: false,
      dirtyGeneration: 1,
      lastOutcome: 'success',
      pendingDemand: false,
      publishedGeneration: 1,
      queued: false,
      requestedGeneration: 1,
      revision: 'e2e-intercept-revision',
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 1,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources,
  };
  await page.route('**/api/source-control', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: `event: snapshot\ndata: ${JSON.stringify(complete)}\n\nevent: snapshot\ndata: ${JSON.stringify({ ...complete, generation: 11, sources: sources.slice(0, 1) })}\n\n`,
      contentType: 'text/event-stream',
      status: 200,
    });
  });

  await page.goto('/sources');
  for (const definition of collectionSourceDefinitions) {
    await expect(page.getByRole('heading', { level: 3, name: definition.label })).toBeVisible();
  }
});
