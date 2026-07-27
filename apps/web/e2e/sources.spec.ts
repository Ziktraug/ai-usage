import { collectionSourceDefinitions } from '@ai-usage/report-core/source-control';
import type { Page } from '@playwright/test';
import { expect, test } from './browser-test';

test.describe.configure({ mode: 'serial' });

const COMPACT_REVISION_PREFIX_LENGTH = 12;
const COMPACT_REVISION_SUFFIX_LENGTH = 8;
const FULL_REVISION_PATTERN = /^e2e-revision-(\d+)-[a-f\d]{32}$/;
const RUNNING_ELAPSED_PATTERN = /Running: Codex sessions \(\d+s elapsed\)/;
const NEXT_DUE_PATTERN = /Next due: .* at \d{4}-\d{2}-\d{2}T/;

const sourceCard = (page: Page, label: string) =>
  page.getByRole('article').filter({ has: page.getByRole('heading', { level: 3, name: label }) });
const publicationRevisionNumber = (revision: string | null): number => {
  const match = revision?.match(FULL_REVISION_PATTERN);
  if (!match?.[1]) {
    throw new Error(`Unexpected publication revision: ${revision ?? 'missing'}`);
  }
  return Number.parseInt(match[1], 10);
};

test('states each source health once and keeps source metadata concise', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/sources');
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();

  const sourceCards = page.locator('[data-source-card]');
  await expect(sourceCards).toHaveCount(collectionSourceDefinitions.length);
  for (const card of await sourceCards.all()) {
    await expect(card.locator('[data-source-health]')).toHaveCount(1);
    await expect(card.getByText('Last outcome', { exact: true })).toBeVisible();
  }
  await expect(page.getByText('The last run completed successfully.', { exact: true })).toHaveCount(0);

  const providerUsageGroup = page.getByRole('heading', { level: 2, name: 'Provider usage' }).locator('..');
  await expect(providerUsageGroup.getByText('1 source', { exact: true })).toBeVisible();
  await expect(providerUsageGroup.getByText('1 sources', { exact: true })).toHaveCount(0);

  const revisionCode = page.locator('code[title]').first();
  await expect(revisionCode).toBeVisible();
  const fullRevision = await revisionCode.getAttribute('title');
  if (!(fullRevision && FULL_REVISION_PATTERN.test(fullRevision))) {
    throw new Error(`The full source publication revision is invalid: ${fullRevision ?? 'missing'}`);
  }
  const expectedCompactRevision = [
    fullRevision.slice(0, COMPACT_REVISION_PREFIX_LENGTH),
    '…',
    fullRevision.slice(-COMPACT_REVISION_SUFFIX_LENGTH),
  ].join('');
  await expect(revisionCode).toHaveText(expectedCompactRevision);
  await expect(revisionCode).not.toHaveText(fullRevision);
  const fullRevisionOccurrences = await page
    .locator('body')
    .evaluate((body, value) => (body.textContent ?? '').split(value).length - 1, fullRevision);
  expect(fullRevisionOccurrences).toBe(0);

  const copyRevision = page.getByRole('button', { name: 'Copy publication revision' });
  await copyRevision.click();
  await expect(copyRevision).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fullRevision);
});

test('keeps business sources independent through a picked disable and publishes once', async ({ context, page }) => {
  await page.goto('/sources');
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();

  const sessions = sourceCard(page, 'Codex sessions');
  const quota = sourceCard(page, 'Codex usage limits');
  await expect(sessions).toBeVisible();
  await expect(quota).toBeVisible();
  await expect(sessions.getByText('Lifecycle', { exact: true })).toBeVisible();
  await expect(sessions.getByText('scheduled', { exact: true })).toBeVisible();
  await expect(sessions.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
  await expect(quota.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();

  const revisionCode = page.locator('code[title]').first();
  const initialRevision = publicationRevisionNumber(await revisionCode.getAttribute('title'));
  await sessions.getByRole('button', { name: 'Run now' }).click();
  await expect(sessions.getByText('Running', { exact: true })).toBeVisible();

  const reportPage = await context.newPage();
  await reportPage.goto('/');
  await expect(reportPage.locator('main[data-hydrated="true"]')).toBeVisible();
  const reportOwnerLoads = await reportPage.evaluate(() =>
    Number(Reflect.get(globalThis, '__aiUsageE2EReportOwnerLoads') ?? 0),
  );
  const summary = reportPage.getByRole('region', { name: 'Collection source status' });
  const summaryCard = summary.locator('[data-source-card]');
  await summary.hover();
  await expect(summaryCard).toBeVisible();
  const runningDetail = summaryCard.getByText(RUNNING_ELAPSED_PATTERN);
  await expect(runningDetail).toBeVisible();
  const firstElapsed = await runningDetail.textContent();
  await expect.poll(async () => runningDetail.textContent()).not.toBe(firstElapsed);
  await expect(summaryCard.getByText(NEXT_DUE_PATTERN)).toBeVisible();

  await reportPage.mouse.move(0, 0);
  await expect(summaryCard).toBeHidden();
  const hiddenElapsed = await runningDetail.textContent();
  await reportPage.waitForTimeout(1200);
  expect(await runningDetail.textContent()).toBe(hiddenElapsed);

  await summary.getByRole('link').focus();
  await expect(summaryCard).toBeVisible();
  await sessions.getByRole('checkbox', { name: 'Enabled' }).uncheck();
  await expect(sessions.getByText('Pausing after current run', { exact: true })).toBeVisible();
  await expect(sessions.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(quota.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
  await expect
    .poll(async () => publicationRevisionNumber(await revisionCode.getAttribute('title')))
    .toBe(initialRevision + 1);
  await expect
    .poll(() => reportPage.evaluate(() => Number(Reflect.get(globalThis, '__aiUsageE2EReportOwnerLoads') ?? 0)))
    .toBe(reportOwnerLoads + 1);

  await sessions.getByRole('checkbox', { name: 'Enabled' }).check();
  await expect(sessions.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
  await reportPage.close();
  await expect(sessions.getByText('scheduled', { exact: true })).toBeVisible();
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

test('renders count-free source progress without assigning a non-finite native value', async ({ page }) => {
  const sources = collectionSourceDefinitions.map((definition) => ({
    availability: 'detected' as const,
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: 'not-run' as const,
    lifecycle: definition.id === 'codex.usage-limits' ? ('running' as const) : ('scheduled' as const),
    policy: 'enabled' as const,
    ...(definition.id === 'codex.usage-limits'
      ? { progress: { message: 'Reading local rollout history', phase: 'reading' as const } }
      : {}),
    reason: { code: 'none' as const },
    warnings: [],
  }));
  const snapshot = {
    generatedAt: '2026-07-20T20:41:00.000Z',
    generation: 12,
    instanceId: 'e2e-count-free-progress',
    publication: {
      acknowledgedRequestGeneration: 1,
      dirty: false,
      dirtyGeneration: 1,
      lastOutcome: 'success',
      pendingDemand: false,
      publishedGeneration: 1,
      queued: false,
      requestedGeneration: 1,
      revision: 'e2e-count-free-progress-revision',
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 1,
      running: false,
    },
    queueDepth: 0,
    runningCount: 1,
    sources,
  };
  await page.route('**/api/source-control', async (route) => {
    await route.fulfill({
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      contentType: 'text/event-stream',
      status: 200,
    });
  });

  await page.goto('/sources');
  await expect(page.getByText('Reading local rollout history')).toBeVisible();
});
