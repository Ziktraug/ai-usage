import { collectionSourceDefinitions, parseSourceControlCommandResponse } from '@ai-usage/report-core/source-control';
import type { Page } from '@playwright/test';
import { FOCUSED_REPORT_E2E_CONTROL_KEY, FOCUSED_REPORT_E2E_ENABLED_KEY } from '../src/focused-report-e2e-fixture';
import { expect, openHydratedReport, reportViewsFor, test, waitForHydratedNavigation } from './browser-test';
import { createServerStateNetworkTrace } from './server-state-network';

test.describe.configure({ mode: 'serial' });

const COMPACT_REVISION_PREFIX_LENGTH = 12;
const COMPACT_REVISION_SUFFIX_LENGTH = 8;
const FULL_REVISION_PATTERN = /^e2e-revision-(\d+)-[a-f\d]{32}$/;
const PUBLICATION_JARGON_PATTERN = /Publication demand|RTK dependency|Caught up|acknowledged|not-run/;
const RUNNING_ELAPSED_PATTERN = /Running: Codex sessions \(\d+s elapsed\)/;
const NEXT_DUE_PATTERN = /Next due: .* at \d{4}-\d{2}-\d{2}T/;
let shouldRestoreCodexSessions = false;
type FocusedResponseControlAction = 'arm' | 'release' | 'waitUntilBlocked';

const controlFocusedResponse = async (page: Page, action: FocusedResponseControlAction): Promise<void> => {
  await page.evaluate(
    async ({ action: requestedAction, controlKey }) => {
      const control = Reflect.get(globalThis, controlKey);
      const command = control && typeof control === 'object' ? Reflect.get(control, requestedAction) : undefined;
      if (typeof command !== 'function') {
        throw new Error(`Focused E2E response control cannot ${requestedAction}`);
      }
      await Promise.resolve(Reflect.apply(command, control, []));
    },
    { action, controlKey: FOCUSED_REPORT_E2E_CONTROL_KEY },
  );
};

const openHydratedSources = async (page: Page): Promise<void> => {
  await page.goto('/sources');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
};

const sourceSurface = (page: Page, label: string) =>
  page
    .locator('[data-source-card], [data-healthy-source-row]')
    .filter({ has: page.getByRole('heading', { level: 3, name: label }) });
const publicationRevisionNumber = (revision: string | null): number => {
  const match = revision?.match(FULL_REVISION_PATTERN);
  if (!match?.[1]) {
    throw new Error(`Unexpected publication revision: ${revision ?? 'missing'}`);
  }
  return Number.parseInt(match[1], 10);
};

test.afterEach(async ({ request }) => {
  if (!shouldRestoreCodexSessions) {
    return;
  }

  try {
    const response = await request.post('/api/source-control/command', {
      data: { command: 'set-enabled', enabled: true, sourceId: 'codex.sessions' },
      headers: { origin: 'http://127.0.0.1:4174' },
    });
    const result = parseSourceControlCommandResponse(await response.json());
    if (!(response.ok() && result.ok)) {
      throw new Error('Could not restore the Codex sessions source policy.');
    }
    expect(result.snapshot.sources.find(({ id }) => id === 'codex.sessions')).toMatchObject({ policy: 'enabled' });
  } finally {
    shouldRestoreCodexSessions = false;
  }
});

test('states each source health once and keeps source metadata concise', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openHydratedSources(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();

  const sourceCards = page.locator('main [data-source-card]');
  const healthySummary = page.locator('[data-healthy-source-summary]');
  await expect(sourceCards).toHaveCount(0);
  await expect(healthySummary).toContainText(`${collectionSourceDefinitions.length} sources`);
  await healthySummary.locator('summary').click();
  const healthyRows = healthySummary.locator('[data-healthy-source-row]');
  await expect(healthyRows).toHaveCount(collectionSourceDefinitions.length);
  for (const row of await healthyRows.all()) {
    await expect(row.locator('[data-source-health]')).toHaveCount(1);
  }
  await expect(page.getByText('The last run completed successfully.', { exact: true })).toHaveCount(0);
  // Every session source in this fixture has detected input, so the first-run guidance must stay away.
  await expect(page.locator('[data-first-run-guidance]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Sessions' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Provider usage' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Enrichments' })).toHaveCount(0);

  const detectAll = page.getByRole('button', { name: 'Detect all' });
  const runAll = page.getByRole('button', { name: 'Run all enabled' });
  expect(await runAll.getAttribute('class')).toBe(await detectAll.getAttribute('class'));

  const publicationDetails = page.locator('[data-publication-details]');
  await expect(publicationDetails).not.toHaveAttribute('open', '');
  const revisionCode = page.locator('code[title]').first();
  await expect(revisionCode).toBeHidden();
  await publicationDetails.locator('summary').click();
  await expect(revisionCode).toBeVisible();
  await expect(page.locator('[data-publication-status]')).toHaveText(
    'The report is up to date with everything collected.',
  );
  await expect(page.locator('[data-publication-rtk="up-to-date"]')).toHaveText('Up to date');
  await expect(page.locator('[data-publication-outcome="success"]')).toContainText('Succeeded · ');
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
  await openHydratedSources(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();

  const healthySummary = page.locator('[data-healthy-source-summary]');
  await healthySummary.locator('summary').click();
  const sessions = sourceSurface(page, 'Codex sessions');
  const quota = sourceSurface(page, 'Codex usage limits');
  await expect(sessions).toBeVisible();
  await expect(quota).toBeVisible();
  await expect(sessions.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
  await expect(quota.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();

  await page.locator('[data-publication-details] > summary').click();
  const revisionCode = page.locator('code[title]').first();
  const initialRevision = publicationRevisionNumber(await revisionCode.getAttribute('title'));
  await sessions.getByRole('button', { name: 'Run now' }).click();
  await expect(sessions.getByText('Running', { exact: true })).toBeVisible();

  const reportPage = await context.newPage();
  await openHydratedReport(reportPage);
  const summary = reportPage.getByRole('region', { name: 'Collection source status' });
  const summaryCard = summary.locator('[data-source-card]');
  await summary.hover();
  await expect(summaryCard).toBeVisible();
  await expect(summaryCard.getByText('Codex sessions', { exact: true })).toBeVisible();
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
  shouldRestoreCodexSessions = true;
  await sessions.getByRole('checkbox', { name: 'Enabled' }).uncheck();
  await expect(sessions.getByText('Pausing after current run', { exact: true })).toBeVisible();
  await expect(sessions.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(quota.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
  // The source-page revision proves one publication; the report summary proves
  // that the other page observed that published snapshot through its SSE owner.
  await expect
    .poll(async () => publicationRevisionNumber(await revisionCode.getAttribute('title')))
    .toBe(initialRevision + 1);
  await expect(summaryCard.getByText('Codex sessions', { exact: true })).toHaveCount(0);

  await reportPage.close();
});

test('records a publication while a report destination is pending', async ({ context, page }) => {
  await openHydratedSources(page);
  await page.locator('[data-healthy-source-summary] > summary').click();
  await page.locator('[data-publication-details] > summary').click();
  const revisionCode = page.locator('code[title]').first();
  const initialRevision = publicationRevisionNumber(await revisionCode.getAttribute('title'));
  const sessions = sourceSurface(page, 'Codex sessions');

  const reportPage = await context.newPage();
  const trace = createServerStateNetworkTrace(reportPage);
  await reportPage.goto('/skills');
  await waitForHydratedNavigation(reportPage);
  await reportPage.evaluate((enabledKey) => {
    Reflect.set(globalThis, enabledKey, true);
  }, FOCUSED_REPORT_E2E_ENABLED_KEY);
  await reportViewsFor(reportPage).getByRole('link', { exact: true, name: 'Overview' }).click();
  await expect(reportPage.locator('[data-report-complete-output]')).toBeVisible();
  const workspace = reportPage.locator('[data-report-workspace]');
  await workspace.evaluate((element) => element.setAttribute('data-plan-069-workspace', 'pending-publication'));
  trace.checkpoint('pending-publication');

  await controlFocusedResponse(reportPage, 'arm');
  const search = reportPage.getByRole('textbox', {
    name: 'Filter sessions by title, project, model, provider, or harness',
  });
  try {
    await search.fill('pending-publication');
    await controlFocusedResponse(reportPage, 'waitUntilBlocked');
    await sessions.getByRole('button', { name: 'Run now' }).click();
    await expect(sessions.getByText('Running', { exact: true })).toBeVisible();
    shouldRestoreCodexSessions = true;
    await sessions.getByRole('checkbox', { name: 'Enabled' }).uncheck();
    await expect(sessions.getByText('Pausing after current run', { exact: true })).toBeVisible();
    await expect
      .poll(async () => publicationRevisionNumber(await revisionCode.getAttribute('title')))
      .toBe(initialRevision + 1);
  } finally {
    await controlFocusedResponse(reportPage, 'release');
  }

  await expect(reportPage.locator('[data-report-refresh-pending]')).toHaveCount(0);
  const workspaceWasRetained =
    (await reportPage.locator('[data-report-workspace]').getAttribute('data-plan-069-workspace')) ===
    'pending-publication';
  expect(workspaceWasRetained).toBe(true);
  process.stdout.write(
    `${JSON.stringify({
      scenario: 'publication-while-destination-pending',
      type: 'plan-069-gate-0',
      value: { counts: trace.counts('pending-publication'), workspaceWasRetained },
    })}\n`,
  );
  trace.dispose();
  await reportPage.close();
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

  await openHydratedSources(page);
  await page.locator('[data-healthy-source-summary] > summary').click();
  for (const definition of collectionSourceDefinitions) {
    await expect(page.getByRole('heading', { level: 3, name: definition.label })).toBeVisible();
  }
});

test('describes report publishing in plain language in both the waiting and the up-to-date states', async ({
  page,
}) => {
  const sources = collectionSourceDefinitions.map((definition) => ({
    availability: 'detected' as const,
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: 'success' as const,
    lifecycle: 'scheduled' as const,
    policy: 'enabled' as const,
    reason: { code: 'none' as const },
    warnings: [],
  }));
  const snapshot = {
    generatedAt: '2026-07-16T10:00:00.000Z',
    generation: 12,
    instanceId: 'e2e-waiting-publication',
    publication: {
      acknowledgedRequestGeneration: 1,
      dirty: true,
      dirtyGeneration: 2,
      lastOutcome: 'failed' as const,
      pendingDemand: true,
      publishedGeneration: 1,
      queued: false,
      requestedGeneration: 3,
      revision: 'e2e-waiting-publication-revision',
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 2,
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
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      contentType: 'text/event-stream',
      status: 200,
    });
  });

  await openHydratedSources(page);
  await expect(page.getByRole('heading', { level: 2, name: 'Report publishing' })).toBeVisible();
  await expect(page.locator('[data-publication-status]')).toHaveText(
    'New data is waiting to be published once RTK savings enrichment catches up.',
  );
  await page.locator('[data-publication-details] > summary').click();
  await expect(page.getByText('Pending publish requests', { exact: true })).toBeVisible();
  await expect(page.locator('[data-publication-pending-requests]')).toHaveText('2');
  await expect(page.locator('[data-publication-rtk="behind"]')).toHaveText('Behind — publishing waits for it');
  await expect(page.locator('[data-publication-outcome="failed"]')).toHaveText('Failed');
  expect(await page.locator('main').innerText()).not.toMatch(PUBLICATION_JARGON_PATTERN);
});

test('renders only deviation cards beside the healthy-source summary', async ({ page }) => {
  const sources = collectionSourceDefinitions.map((definition) => ({
    availability: 'detected' as const,
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: definition.id === 'codex.sessions' ? ('failed' as const) : ('success' as const),
    lifecycle: 'scheduled' as const,
    policy: 'enabled' as const,
    reason:
      definition.id === 'codex.sessions'
        ? { code: 'run-failed' as const, message: 'Synthetic collection failure.' }
        : { code: 'none' as const },
    warnings: [],
  }));
  const snapshot = {
    generatedAt: '2026-07-20T20:41:00.000Z',
    generation: 13,
    instanceId: 'e2e-degraded-source',
    publication: {
      acknowledgedRequestGeneration: 1,
      dirty: false,
      dirtyGeneration: 1,
      lastOutcome: 'success',
      pendingDemand: false,
      publishedGeneration: 1,
      queued: false,
      requestedGeneration: 1,
      revision: 'e2e-degraded-source-revision',
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 1,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources,
  };
  await page.route('**/api/source-control', async (route) => {
    await route.fulfill({
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      contentType: 'text/event-stream',
      status: 200,
    });
  });

  await openHydratedSources(page);
  const sourceCards = page.locator('main [data-source-card]');
  await expect(sourceCards).toHaveCount(1);
  await expect(sourceCards.getByRole('heading', { level: 3, name: 'Codex sessions' })).toBeVisible();
  await expect(sourceCards.getByText('Failed', { exact: true })).toBeVisible();
  await expect(page.locator('[data-healthy-source-summary]')).toContainText(
    `${collectionSourceDefinitions.length - 1} sources`,
  );
  const sessionsGroup = page.getByRole('heading', { level: 2, name: 'Sessions' }).locator('..');
  await expect(sessionsGroup.getByText('1 source', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Provider usage' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Enrichments' })).toHaveCount(0);
});

test('answers the first run when no session source has detected input', async ({ page }) => {
  const sessionSourceIds: ReadonlySet<string> = new Set(
    collectionSourceDefinitions.filter((definition) => definition.group === 'sessions').map(({ id }) => id),
  );
  const sources = collectionSourceDefinitions.map((definition) => {
    const undetected = sessionSourceIds.has(definition.id);
    return {
      availability: undetected ? ('not-detected' as const) : ('detected' as const),
      cadenceMs: definition.cadenceMs,
      id: definition.id,
      label: definition.label,
      lastOutcome: undetected ? ('not-run' as const) : ('success' as const),
      lifecycle: undetected ? ('dormant' as const) : ('scheduled' as const),
      policy: 'enabled' as const,
      reason: undetected
        ? { code: 'input-missing' as const, message: 'No supported local input was found.' }
        : { code: 'none' as const },
      warnings: [],
    };
  });
  const snapshot = {
    generatedAt: '2026-08-19T09:15:00.000Z',
    generation: 14,
    instanceId: 'e2e-first-run',
    publication: {
      acknowledgedRequestGeneration: 1,
      dirty: false,
      dirtyGeneration: 1,
      lastOutcome: 'success',
      pendingDemand: false,
      publishedGeneration: 1,
      queued: false,
      requestedGeneration: 1,
      revision: 'e2e-first-run-revision',
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 1,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources,
  };
  await page.route('**/api/source-control', async (route) => {
    await route.fulfill({
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      contentType: 'text/event-stream',
      status: 200,
    });
  });

  await openHydratedSources(page);
  const guidance = page.locator('[data-first-run-guidance]');
  await expect(guidance).toBeVisible();
  await expect(guidance.getByRole('heading', { level: 2, name: 'No local history detected yet' })).toBeVisible();

  const harnessRows = guidance.locator('[data-first-run-harness]');
  await expect(harnessRows).toHaveCount(sessionSourceIds.size);
  // Literal copy on purpose: a test that re-imported the panel's own constant would assert nothing.
  for (const { harness, paths } of [
    { harness: 'Claude Code', paths: ['~/.claude/projects/**/*.jsonl', '~/.claude.json'] },
    { harness: 'Codex', paths: ['~/.codex/sessions/**/*.jsonl'] },
    {
      harness: 'OpenCode',
      paths: [
        '~/.local/share/opencode/opencode.db',
        '~/Library/Application Support/opencode/opencode.db',
        '~/AppData/Local/opencode/opencode.db',
      ],
    },
    { harness: 'Cursor (macOS)', paths: ['~/Library/Application Support/Cursor/User/globalStorage/state.vscdb'] },
  ]) {
    const row = harnessRows.filter({ hasText: harness });
    await expect(row).toHaveCount(1);
    for (const path of paths) {
      await expect(row.getByText(path, { exact: true })).toBeVisible();
    }
  }

  // The panel tells the reader to "run Detect all", so the action has to be beside the instruction
  // rather than somewhere they have to go find. It cannot be clicked here: the first-run state is
  // only reachable by stubbing the source-control stream, and a stubbed stream ends immediately,
  // which drops the connection out of `live` and correctly disables every mutation. That disabled
  // state is itself the invariant worth pinning — the button must not stay armed in front of a
  // control plane that cannot accept the command.
  const detectAll = guidance.getByRole('button', { name: 'Detect all' });
  await expect(detectAll).toHaveCount(1);
  await expect(detectAll).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Connection interrupted');

  // The alternative path for usage that lives on another machine has to be reachable, not just described.
  await expect(guidance.getByRole('link', { name: 'Open Sync' })).toHaveAttribute('href', '/sync');
  // The panel answers "what now"; the per-source deviation cards still state each source's own outcome.
  await expect(page.getByRole('heading', { level: 2, name: 'Sessions' })).toBeVisible();
  await expect(page.locator('main [data-source-card]')).toHaveCount(sessionSourceIds.size);
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

  await openHydratedSources(page);
  await page.locator('[data-healthy-source-summary] > summary').click();
  await expect(page.getByText('Reading local rollout history')).toBeVisible();
});
