import type { AnalysisRevisionMetadata, SessionAnalysis } from '@ai-usage/web-contract/session-distillation';
import AxeBuilder from '@axe-core/playwright';
import { expect, openHydratedReport, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';

const READ_OPERATION = /\/(status|get|evidence)$/;

const metadata = (revision: number): AnalysisRevisionMetadata => ({
  id: `analysis-${revision}`,
  revision,
  createdAt: '2026-10-04T12:00:00.000Z',
  projectId: 'synthetic-project',
  nativeSessionId: 'synthetic-session',
  machineId: 'synthetic-machine',
  packetDigest: 'a'.repeat(64),
});

const assertion = (text: string) => ({
  text,
  basis: 'reported' as const,
  evidence: [{ eventId: 'event-1', quote: 'Inspect the bounded reader.' }],
});
const analysis = (revision: number): SessionAnalysis => ({
  ...metadata(revision),
  schemaVersion: 1,
  normalizationVersion: 1,
  extractorVersion: 'session-distillation-v1',
  source: {
    harnessKey: 'codex',
    machineId: 'synthetic-machine',
    nativeSessionId: 'synthetic-session',
    projectId: 'synthetic-project',
    reportAnchor: { revision: 'report-synthetic', rowId: 'synthetic-row' },
    version: { bytes: 100, totalBytes: 100, modifiedAtMs: 0, digest: 'b'.repeat(64) },
  },
  coverage: {
    childDiscovery: 'not-performed',
    childrenNotAnalyzed: null,
    completion: 'interrupted',
    exclusions: [{ reason: 'text-budget', count: 1 }],
    includedEvents: 1,
    lines: 1,
    scope: 'session-only',
    status: 'partial',
  },
  content: {
    schemaVersion: 1,
    summary: assertion(`Synthetic account revision ${revision}: investigate the bounded reader.`),
    episodes: [
      {
        id: 'bounded-reader',
        objective: assertion('Inspect the bounded reader.'),
        attempts: [],
        result: {
          status: 'unresolved',
          assertion: { text: 'No verification result was recorded.', basis: 'unknown', evidence: [] },
        },
        difficulties: [],
        decisions: [],
        entryPoints: [
          { text: 'Historical entry: packages/local-machine/src/session-detail.ts', basis: 'inferred', evidence: [] },
        ],
        openQuestions: [{ text: 'Does the reader retain the expected version?', basis: 'unknown', evidence: [] }],
      },
    ],
    abstention: null,
  },
  producer: { kind: 'active-harness', sessionId: null, attribution: 'unknown' },
  validation: 'schema-and-references',
});

test('loads the account on demand, keeps a chosen revision, and checks exact evidence without starting generation', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  let latestRevision = 1;
  let sourceChanged = false;
  let regenerationFailed = false;
  const calls: { path: string; input: unknown }[] = [];
  const semanticModules: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/session-distillation.svelte')) {
      semanticModules.push(request.url());
    }
  });
  await page.route('**/rpc/sessionDistillation/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const input = decodeRpcResponseBody(route.request().postData() ?? '');
    calls.push({ path, input });
    let output: unknown;
    if (path.endsWith('/status')) {
      output = {
        state: regenerationFailed ? 'failed' : 'available',
        latest: metadata(latestRevision),
        revisions: Array.from({ length: latestRevision }, (_, index) => metadata(latestRevision - index)),
        revisionsOmitted: 0,
        job: regenerationFailed
          ? { id: 'job-failed', state: 'failed', attempt: 1, errorCode: 'worker-failed', analysisId: null }
          : null,
        sourceStatus: 'unchecked',
      };
    } else if (path.endsWith('/get')) {
      const id = (input as { analysisId: string }).analysisId;
      output = analysis(Number(id.slice(-1)));
    } else if (path.endsWith('/evidence')) {
      output = sourceChanged
        ? { status: 'changed', events: [] }
        : {
            status: 'available',
            events: [
              {
                id: 'event-1',
                callId: null,
                kind: 'user',
                line: 1,
                nativeTurnId: null,
                redacted: false,
                roundId: null,
                text: 'Inspect the bounded reader.',
                timestamp: null,
                toolName: null,
                truncated: false,
              },
            ],
          };
    } else {
      throw new Error(`Unexpected semantic operation ${path}`);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: encodeRpcResponseBody(output) });
  });

  const response = await openHydratedReport(page);
  expect(await response?.text()).not.toContain('Synthetic account revision');
  await page.addScriptTag({ type: 'module', url: '/src/lib/features/sessions/detail/session-detail.e2e-fixture.ts' });
  await expect(page.getByRole('list', { name: 'Rounds', exact: true })).toBeVisible();
  expect(calls).toEqual([]);
  expect(semanticModules).toEqual([]);
  const drawer = await page.locator('[data-session-drawer-body]').elementHandle();
  const initialUrl = page.url();
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  await expect(page.getByText('Synthetic account revision 1: investigate the bounded reader.')).toBeVisible();
  const account = page.getByRole('region', { name: 'Session account', exact: true });
  await expect(account.getByRole('heading').first()).toHaveJSProperty('tagName', 'H2');
  await expect(account.getByRole('heading', { name: 'Episode 1 · Unresolved', level: 3 })).toBeVisible();
  await expect(account.getByRole('heading', { name: 'Result', level: 4, exact: true })).toBeVisible();
  expect(calls.map((entry) => entry.path)).toEqual(['/rpc/sessionDistillation/status', '/rpc/sessionDistillation/get']);
  expect(semanticModules.length).toBeGreaterThan(0);
  expect(page.url()).toBe(initialUrl);
  await page.getByRole('button', { name: 'Evidence 1', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Selected evidence' }).locator('pre')).toHaveText(
    'Inspect the bounded reader.',
  );
  sourceChanged = true;
  await page.getByRole('button', { name: 'Recheck source', exact: true }).click();
  await expect(page.getByText('Source changed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected evidence' }).locator('pre')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close evidence', exact: true }).click();

  latestRevision = 2;
  regenerationFailed = true;
  await page.getByRole('button', { name: 'Refresh analysis status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read the latest analysis' })).toBeVisible();
  await expect(
    page.getByText('The latest attempt failed. The selected earlier analysis remains available.'),
  ).toBeVisible();
  await expect(page.getByText('Synthetic account revision 1: investigate the bounded reader.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await page.getByRole('button', { name: 'Release detail', exact: true }).click();
  await expect(page.getByText('Synthetic account revision 1: investigate the bounded reader.')).toBeVisible();
  await page.getByRole('button', { name: 'Read the latest analysis' }).click();
  await expect(page.getByText('Synthetic account revision 2: investigate the bounded reader.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Analysis revision', exact: true }).selectOption('analysis-1');
  await expect(page.getByText('Synthetic account revision 1: investigate the bounded reader.')).toBeVisible();
  await page.getByRole('tab', { name: 'Summary', exact: true }).click();
  const countWhileHidden = calls.length;
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  await expect(page.getByText('Synthetic account revision 1: investigate the bounded reader.')).toBeVisible();
  expect(calls.length).toBe(countWhileHidden);
  expect(await drawer?.evaluate((element) => element.isConnected)).toBe(true);
  expect(calls.every(({ path }) => READ_OPERATION.test(path))).toBe(true);
  await page.getByText('Partial source', { exact: false }).click();
  await expect(page.getByText('Recorded session completion: interrupted.')).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('[data-session-distillation]').analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('analysis-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Synthetic account revision 1: investigate the bounded reader.')).toBeVisible();
  expect(await drawer?.evaluate((element) => element.isConnected)).toBe(true);
  await page.getByRole('button', { name: 'Evidence 1', exact: true }).first().click();
  await expect(page.getByText('Source changed.', { exact: false })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('analysis-mobile.png') });
});

test('clears the account on neighboring sessions and reports an unprocessed session without acquiring an analysis', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  let firstRow: string | undefined;
  const reads: string[] = [];
  await page.route('**/rpc/sessionDistillation/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const input = decodeRpcResponseBody(route.request().postData() ?? '') as { selection: { rowId: string } };
    reads.push(path);
    firstRow ??= input.selection.rowId;
    const sameRow = firstRow === input.selection.rowId;
    const output = path.endsWith('/get')
      ? analysis(1)
      : {
          state: sameRow ? 'available' : 'not-analyzed',
          latest: sameRow ? metadata(1) : null,
          revisions: sameRow ? [metadata(1)] : [],
          revisionsOmitted: 0,
          job: null,
          sourceStatus: 'unchecked',
        };
    await route.fulfill({ status: 200, contentType: 'application/json', body: encodeRpcResponseBody(output) });
  });
  await openHydratedReport(page);
  await page.addScriptTag({ type: 'module', url: '/src/lib/features/sessions/detail/session-detail.e2e-fixture.ts' });
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  await expect(page.getByText('Synthetic account revision 1: investigate the bounded reader.')).toBeVisible();
  const getCount = reads.filter((path) => path.endsWith('/get')).length;
  await page.getByRole('button', { name: 'Next session (j)', exact: true }).click();
  await expect(page.getByText('This session has not been analyzed.', { exact: false })).toBeVisible();
  await expect(page.getByText('Synthetic account revision 1: investigate the bounded reader.')).toHaveCount(0);
  expect(reads.filter((path) => path.endsWith('/get')).length).toBe(getCount);
  await page.keyboard.press('k');
  await expect(page.getByText('Synthetic account revision 1: investigate the bounded reader.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Session details', exact: true })).not.toBeVisible();
});
