import { expect, test } from '@playwright/test';

const NON_EMPTY_ATTRIBUTE_PATTERN = /.+/;
const SESSION_QUERY_FINGERPRINT_PATTERN = /^session-query-v1:[0-9a-f]{16}$/;
const SESSION_NEIGHBOR_FINGERPRINT_PATTERN = /^session-neighbor-v1:[0-9a-f]{16}$/;
const FOCUSED_OVERVIEW_FINGERPRINT_PREFIX = 'focused-overview-v1:';

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
  await page.goto('/');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inspect timeline bucket' })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('No dated sessions match the current filters')).toHaveCount(0);
});

test('hydrates and pages Sessions through the production revision protocol', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Pause auto-refresh' }).click();
  const revision = await report.getAttribute('data-report-revision');
  const requestFingerprint = await report.getAttribute('data-request-fingerprint');
  if (!(revision && requestFingerprint)) {
    throw new Error('Production Sessions diagnostics must expose a revision and request fingerprint');
  }

  const loadMore = page.getByRole('button', { name: 'Load more sessions' });
  await expect(loadMore).toBeVisible();
  for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
    if ((await loadMore.count()) === 0) {
      break;
    }
    await loadMore.click();
  }
  await expect(loadMore).toHaveCount(0);

  await page.locator('tbody tr:not([data-virtual-spacer])').first().locator('td').last().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const nextSession = page.getByRole('button', { name: 'Next session' });
  await expect(nextSession).toBeEnabled();
  await nextSession.click();
  await expect(page.getByRole('button', { name: 'Previous session' })).toBeEnabled();
  await expect(report).toHaveAttribute('data-report-revision', revision);
  await expect(report).toHaveAttribute('data-request-fingerprint', requestFingerprint);
  expect(await overviewResponseCount()).toBe(0);

  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Overview' }).click();
  const advancedSummary = page.locator('summary').filter({ hasText: 'Advanced analysis' });
  await expect(advancedSummary).toBeVisible();
  await expect.poll(overviewResponseCount).toBe(1);
  await advancedSummary.click();
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
