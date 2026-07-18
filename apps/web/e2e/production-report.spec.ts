import { expect, test } from '@playwright/test';

const NON_EMPTY_ATTRIBUTE_PATTERN = /.+/;
const SESSION_QUERY_FINGERPRINT_PATTERN = /^session-query-v1:[0-9a-f]{16}$/;
const SESSION_NEIGHBOR_FINGERPRINT_PATTERN = /^session-neighbor-v1:[0-9a-f]{16}$/;
const FOCUSED_OVERVIEW_FINGERPRINT_PREFIX = 'focused-overview-v1:';
const SOURCES_URL_PATTERN = /\/sources$/;

interface CapturedServerFunctionResponse {
  body: Promise<string>;
  status: number;
}

interface ProtocolIdentity {
  fingerprints: string[];
  revisions: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const wireString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value) && typeof value.s === 'string') {
    return value.s;
  }
  return;
};

const collectWireFieldValues = (value: unknown, fieldName: string, values: string[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWireFieldValues(item, fieldName, values);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const properties = value.p;
  if (isRecord(properties) && Array.isArray(properties.k) && Array.isArray(properties.v)) {
    for (const [index, key] of properties.k.entries()) {
      const propertyValue = properties.v[index];
      if (key === fieldName) {
        const stringValue = wireString(propertyValue);
        if (stringValue !== undefined) {
          values.push(stringValue);
        }
      }
      collectWireFieldValues(propertyValue, fieldName, values);
    }
  }
};

const protocolIdentityFrom = (body: string): ProtocolIdentity => {
  const serialized: unknown = JSON.parse(body);
  const fingerprints: string[] = [];
  const revisions: string[] = [];
  collectWireFieldValues(serialized, 'requestFingerprint', fingerprints);
  collectWireFieldValues(serialized, 'revision', revisions);
  return { fingerprints, revisions };
};

const expectExactProtocolIdentity = (
  body: string,
  revision: string,
  fingerprintPattern: RegExp,
  expectedFingerprint?: string,
): void => {
  const identity = protocolIdentityFrom(body);
  expect(identity.fingerprints.length).toBeGreaterThan(0);
  expect(identity.revisions.length).toBeGreaterThan(0);
  expect(new Set(identity.revisions)).toEqual(new Set([revision]));
  for (const fingerprint of identity.fingerprints) {
    expect(fingerprint).toMatch(fingerprintPattern);
    if (expectedFingerprint !== undefined) {
      expect(fingerprint).toBe(expectedFingerprint);
    }
  }
};

test('renders the report timeline on the initial production Overview', async ({ page }) => {
  const initialResponse = await page.request.get('/');
  const initialHtml = await initialResponse.text();
  expect(initialResponse.ok()).toBe(true);
  expect(initialHtml).toContain('Loading report data');
  expect(initialHtml).not.toContain('Production browser session');
  expect(initialHtml).not.toContain('production-browser-');

  await page.addInitScript(() => {
    Reflect.set(globalThis, '__aiUsageFalseEmptyRange', false);
    const recordFalseEmptyRange = () => {
      if (document.body?.textContent?.includes('No dated sessions match the current filters')) {
        Reflect.set(globalThis, '__aiUsageFalseEmptyRange', true);
      }
    };
    new MutationObserver(recordFalseEmptyRange).observe(document, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener('DOMContentLoaded', recordFalseEmptyRange, { once: true });
  });
  const overviewGate = Promise.withResolvers<void>();
  let serverFunctionRequestCount = 0;
  await page.route('**/_serverFn/**', async (route) => {
    serverFunctionRequestCount++;
    // A cold source-control bootstrap may return one pending manifest before
    // report-published prompts the exact-revision owner to retry.
    if (serverFunctionRequestCount <= 3) {
      await route.continue();
      return;
    }
    await overviewGate.promise;
    await route.continue();
  });
  await page.goto('/');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const dateRange = page.getByRole('region', { name: 'Date range' });
  try {
    await expect(dateRange).toContainText('May 30, 2026');
    await expect(dateRange).toContainText('Jun 29, 2026');
    await expect(dateRange.getByText('Loading report range…', { exact: true })).toHaveCount(0);
  } finally {
    overviewGate.resolve();
  }
  await expect(
    dateRange.getByRole('button', { name: 'Inspect activity timeline. Use arrow keys to inspect days.' }),
  ).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('No dated sessions match the current filters')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(globalThis, '__aiUsageFalseEmptyRange'))).toBe(false);
});

test('provides one accessible responsive source-control surface', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();

  const sourceSummary = page.getByRole('region', { name: 'Collection source status' }).locator('a[href="/sources"]');
  await expect(sourceSummary).toBeVisible();
  await sourceSummary.focus();
  await expect(page.getByText('Collection sources', { exact: true })).toBeVisible();
  await sourceSummary.press('Enter');

  await expect(page).toHaveURL(SOURCES_URL_PATTERN);
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Sessions' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Provider usage' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Enrichments' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Enabled' })).toHaveCount(7);
  await expect(page.getByText('codex.sessions', { exact: true })).toBeVisible();

  const detectAll = page.getByRole('button', { name: 'Detect all' });
  await expect(detectAll).toBeEnabled();
  await detectAll.focus();
  await expect(detectAll).toBeFocused();
});

test('keeps the Report range mounted while focused chart options refresh', async ({ page }) => {
  await page.goto('/');
  const dateRange = page.getByRole('region', { name: 'Date range' });
  const timeline = dateRange.getByRole('button', {
    name: 'Inspect activity timeline. Use arrow keys to inspect days.',
  });
  await expect(timeline).toBeVisible({ timeout: 5000 });
  const advancedAnalysis = page.getByRole('region', { name: 'Advanced analysis' });
  await expect(advancedAnalysis.getByRole('heading', { level: 2, name: 'Punchcard' })).toBeVisible();
  await dateRange.evaluate((element) => element.setAttribute('data-stability-marker', 'original-range'));
  await timeline.evaluate((element) => element.setAttribute('data-stability-marker', 'original-chart'));
  await advancedAnalysis.evaluate((element) => element.setAttribute('data-stability-marker', 'original-analysis'));
  await page.route('**/_serverFn/**', async (route) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    await route.continue();
  });
  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Model' }).click();
  await expect(dateRange).toHaveAttribute('data-stability-marker', 'original-range', { timeout: 1000 });
  await expect(timeline).toHaveAttribute('data-stability-marker', 'original-chart');
  await expect(advancedAnalysis).toHaveAttribute('data-stability-marker', 'original-analysis');
  await expect(dateRange).toHaveAttribute('data-stability-marker', 'original-range');
  await expect(timeline).toHaveAttribute('data-stability-marker', 'original-chart');
  await expect(advancedAnalysis).toHaveAttribute('data-stability-marker', 'original-analysis');
  await expect(advancedAnalysis.getByRole('heading', { level: 2, name: 'Punchcard' })).toBeVisible();
});

test('keeps the last complete report visible while the report range changes', async ({ page }) => {
  await page.goto('/');
  const dateRange = page.getByRole('region', { name: 'Date range' });
  const timeline = dateRange.getByRole('button', {
    name: 'Inspect activity timeline. Use arrow keys to inspect days.',
  });
  await expect(timeline).toBeVisible({ timeout: 5000 });
  await dateRange.evaluate((element) => element.setAttribute('data-stability-marker', 'original-range'));
  await timeline.evaluate((element) => element.setAttribute('data-stability-marker', 'original-chart'));

  const overviewGate = Promise.withResolvers<void>();
  await page.route('**/_serverFn/**', async (route) => {
    await overviewGate.promise;
    await route.continue();
  });

  try {
    await dateRange.getByRole('button', { exact: true, name: '7d' }).click();
    await expect(dateRange).toHaveAttribute('data-stability-marker', 'original-range');
    await expect(timeline).toHaveAttribute('data-stability-marker', 'original-chart');
    await expect(dateRange.getByText('Loading report range…', { exact: true })).toHaveCount(0);
    await expect(dateRange.getByText('No dated sessions match the current filters', { exact: true })).toHaveCount(0);
  } finally {
    overviewGate.resolve();
  }

  await expect(dateRange.getByRole('textbox', { name: 'Start date' })).toHaveValue('2026-06-22');
  await expect(timeline).toHaveAttribute('data-stability-marker', 'original-chart');
});

test('hydrates and automatically pages Sessions through the production revision protocol', async ({ page }) => {
  const serverFunctionResponses: CapturedServerFunctionResponse[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/_serverFn/')) {
      serverFunctionResponses.push({ body: response.text(), status: response.status() });
    }
  });
  const overviewResponseCount = async (): Promise<number> =>
    (await Promise.all(serverFunctionResponses.map(({ body }) => body))).filter((body) =>
      body.includes(FOCUSED_OVERVIEW_FINGERPRINT_PREFIX),
    ).length;

  await page.goto('/?tab=sessions');
  const report = page.locator('main[data-hydrated="true"]');
  await expect(report).toBeVisible();
  await expect(page.getByText('205 / 205 sessions', { exact: true })).toBeVisible();
  await expect(report).toHaveAttribute('data-report-revision', NON_EMPTY_ATTRIBUTE_PATTERN);
  await expect(report).toHaveAttribute('data-request-fingerprint', SESSION_QUERY_FINGERPRINT_PATTERN);
  const revision = await report.getAttribute('data-report-revision');
  const requestFingerprint = await report.getAttribute('data-request-fingerprint');
  if (!(revision && requestFingerprint)) {
    throw new Error('Production Sessions diagnostics must expose a revision and request fingerprint');
  }

  const sessionViewport = page.locator('[data-session-surface="desktop"]');
  await expect
    .poll(async () => {
      await sessionViewport.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      return await page
        .locator('tr[data-index]')
        .evaluateAll((rows) => Math.max(...rows.map((row) => Number(row.getAttribute('data-index')))));
    })
    .toBe(204);
  await expect(page.getByRole('button', { name: 'Load more sessions' })).toHaveCount(0);

  await sessionViewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator('tr[data-index="0"]').locator('td').last().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const nextSession = page.getByRole('button', { name: 'Next session' });
  await expect(nextSession).toBeEnabled();
  await nextSession.click();
  await expect(page.getByRole('button', { name: 'Previous session' })).toBeEnabled();
  await expect(report).toHaveAttribute('data-report-revision', revision);
  await expect(report).toHaveAttribute('data-request-fingerprint', requestFingerprint);
  await expect.poll(overviewResponseCount).toBe(1);

  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Advanced analysis' })).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: 'Advanced analysis' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Punchcard' })).toBeVisible();
  await expect.poll(overviewResponseCount).toBe(2);

  const responseBodies = await Promise.all(serverFunctionResponses.map(({ body }) => body));
  const sessionResponseBodies = responseBodies.filter((body) => body.includes('session-query-v1:'));
  expect(sessionResponseBodies.length).toBeGreaterThanOrEqual(2);
  for (const responseBody of sessionResponseBodies) {
    expectExactProtocolIdentity(responseBody, revision, SESSION_QUERY_FINGERPRINT_PATTERN, requestFingerprint);
  }
  const neighborResponseBodies = responseBodies.filter((body) => body.includes('session-neighbor-v1:'));
  expect(neighborResponseBodies.length).toBeGreaterThanOrEqual(2);
  for (const responseBody of neighborResponseBodies) {
    expectExactProtocolIdentity(responseBody, revision, SESSION_NEIGHBOR_FINGERPRINT_PATTERN);
  }
  expect(serverFunctionResponses.length).toBeGreaterThanOrEqual(5);
  expect(serverFunctionResponses.every(({ status }) => status === 200)).toBe(true);
});

test('automatically pages mobile Sessions while scrolling', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/?tab=sessions');

  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const summaries = page.getByRole('list', { name: 'Session summaries' });
  await expect(summaries).toBeVisible();
  const pagingSentinel = page.locator('[data-session-paging-sentinel="mobile"]');
  await expect
    .poll(async () => {
      await pagingSentinel.scrollIntoViewIfNeeded();
      return await summaries.locator('li').count();
    })
    .toBe(205);
  await expect(page.getByRole('button', { name: 'Load more sessions' })).toHaveCount(0);
});
