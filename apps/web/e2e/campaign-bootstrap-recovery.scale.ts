import type { ReportRevisionBootstrapResult } from '@ai-usage/web-contract/report';
import type { Page } from '@playwright/test';
import { expect, test, waitForHydratedNavigation } from './browser-test';
import { CONTINUITY_ROOT_TITLE } from './campaign-continuity-fixture';
import { encodeRpcResponseBody } from './rpc-test-transport';
import { freezeSessionScrollCollectionSources } from './session-scroll-source-control';

const BOOTSTRAP_PATH = '/rpc/report/revisionBootstrap';
const BOOTSTRAP_GLOB = '**/rpc/report/revisionBootstrap**';
const PAGE_PATH = '/rpc/session/page';
const CHILDREN_PATH = '/rpc/session/campaignChildren';
const INITIAL_FAILURE = 'The fixture report is temporarily unavailable.';
const REPEATED_FAILURE = 'The fixture report is still unavailable after retry.';

const installBootstrapFailure = async (page: Page, failedAttempts = 1) => {
  const released = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let attempts = 0;
  await page.route(BOOTSTRAP_GLOB, async (route) => {
    const attempt = ++attempts;
    try {
      const response = attempt > failedAttempts ? await route.fetch() : null;
      if (attempt === 2) {
        await released.promise;
      }
      if (attempt <= failedAttempts) {
        const result: ReportRevisionBootstrapResult = {
          error: {
            message: attempt === 1 ? INITIAL_FAILURE : REPEATED_FAILURE,
            tag: 'RevisionUnavailable',
          },
          ok: false,
          requestFingerprint: 'report-bootstrap:v1:{}',
        };
        await route.fulfill({ body: encodeRpcResponseBody(result), contentType: 'application/json', status: 200 });
      } else {
        if (!response) {
          throw new Error('Recovered bootstrap must come from the isolated production server');
        }
        await route.fulfill({ response });
      }
    } finally {
      if (attempt === 2) {
        completed.resolve();
      }
    }
  });
  return {
    attempts: () => attempts,
    completed: completed.promise,
    release: () => released.resolve(),
  };
};

const captureRequests = (page: Page) => {
  const documents: string[] = [];
  const campaigns: string[] = [];
  const ordered: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.resourceType() === 'document') {
      documents.push(request.url());
    }
    if ([PAGE_PATH, CHILDREN_PATH].includes(pathname)) {
      campaigns.push(`${request.url()} ${request.postData() ?? ''}`);
    }
    if ([BOOTSTRAP_PATH, PAGE_PATH, CHILDREN_PATH].includes(pathname)) {
      ordered.push(pathname);
    }
  });
  return { campaigns, documents, ordered };
};

const enterCampaigns = async (page: Page): Promise<void> => {
  // Sources has no report bootstrap. Its ready control proves the initial publication event was
  // consumed before Campaigns acquires a cold Query owner, so that event cannot race the Retry gesture.
  await page.goto('/sources?range=all&q=Continuity');
  await waitForHydratedNavigation(page);
  await expect(page.locator('main[data-route-shell="sources"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Detect all', exact: true })).toBeEnabled();
  await page.locator('[data-app-navigation="desktop"]').getByRole('link', { name: 'Campaigns', exact: true }).click();
  await expect(page.locator('main[data-route-shell="campaigns"]')).toBeVisible();
  await expect(page.getByText(INITIAL_FAILURE, { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
};

const expectNoPendingRevision = (requests: ReturnType<typeof captureRequests>): void => {
  expect(requests.campaigns.filter((request) => request.includes('pending-campaigns'))).toEqual([]);
  expect(requests.documents, 'Recovery and navigation stay in the original document').toHaveLength(1);
};

test.beforeEach(async ({ request, baseURL }) => {
  await freezeSessionScrollCollectionSources(request, baseURL!);
});

test('retries an unavailable bootstrap before acquiring campaigns without reloading', async ({ page }, testInfo) => {
  const requests = captureRequests(page);
  const bootstrap = await installBootstrapFailure(page);
  try {
    await enterCampaigns(page);
    expect(bootstrap.attempts()).toBe(1);
    expect(requests.campaigns).toEqual([]);

    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await retry.click({ timeout: 20_000 });
    await expect.poll(bootstrap.attempts).toBe(2);
    await expect(retry).toBeDisabled();
    expect(requests.campaigns).toEqual([]);
    bootstrap.release();

    await expect(page.locator('[data-campaign-card]').first()).toContainText(CONTINUITY_ROOT_TITLE);
    await expect(page.locator('[data-campaign-scroll="map"] [data-campaign-node]').first()).toBeVisible();
    await expect(retry).toHaveCount(0);
    expect(requests.ordered.slice(0, 3)).toEqual([BOOTSTRAP_PATH, BOOTSTRAP_PATH, PAGE_PATH]);
    expectNoPendingRevision(requests);
  } finally {
    bootstrap.release();
    await testInfo.attach('bootstrap-recovery-requests.json', {
      body: JSON.stringify({ attempts: bootstrap.attempts(), ...requests }, null, 2),
      contentType: 'application/json',
    });
  }
});

test('keeps a second bootstrap failure visible and prevents duplicate retries while busy', async ({ page }) => {
  const requests = captureRequests(page);
  const bootstrap = await installBootstrapFailure(page, 2);
  try {
    await enterCampaigns(page);
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    const box = await retry.boundingBox();
    if (!box) {
      throw new Error('The bootstrap Retry control must be visible');
    }
    await retry.click({ timeout: 20_000 });
    await expect.poll(bootstrap.attempts).toBe(2);
    await expect(retry).toBeDisabled();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 3 });
    // A bounded quiescence interval catches retries started by repeated gestures or automatic policies.
    await page.waitForTimeout(350);
    expect(bootstrap.attempts()).toBe(2);
    expect(requests.campaigns).toEqual([]);
    bootstrap.release();

    await expect(page.getByText(REPEATED_FAILURE, { exact: false })).toBeVisible();
    await expect(retry).toBeEnabled();
    await page.waitForTimeout(350);
    expect(bootstrap.attempts()).toBe(2);
    expect(requests.campaigns).toEqual([]);

    await retry.click({ timeout: 20_000 });
    await expect(page.locator('[data-campaign-card]').first()).toContainText(CONTINUITY_ROOT_TITLE);
    await expect(retry).toHaveCount(0);
    expect(bootstrap.attempts()).toBe(3);
    expectNoPendingRevision(requests);
  } finally {
    bootstrap.release();
  }
});

test('uses the latest filters when a delayed bootstrap retry recovers', async ({ page }) => {
  const requests = captureRequests(page);
  const bootstrap = await installBootstrapFailure(page);
  try {
    await enterCampaigns(page);
    await page.getByRole('button', { name: 'Retry', exact: true }).click({ timeout: 20_000 });
    await expect.poll(bootstrap.attempts).toBe(2);
    await page.getByRole('searchbox', { name: 'Find a campaign', exact: true }).fill('Continuity campaign 0159');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Continuity campaign 0159');
    expect(requests.campaigns).toEqual([]);
    bootstrap.release();

    await expect(page.locator('[data-campaign-card]')).toHaveCount(1);
    await expect(page.locator('[data-campaign-card]')).toContainText('Continuity campaign 0159');
    await expect(page.locator('[data-campaign-scroll="map"] [data-campaign-node]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    expect(bootstrap.attempts()).toBe(2);
    expectNoPendingRevision(requests);
  } finally {
    bootstrap.release();
  }
});

test('does not restart campaign acquisition after leaving a delayed bootstrap recovery', async ({ page }) => {
  const requests = captureRequests(page);
  const bootstrap = await installBootstrapFailure(page);
  try {
    await enterCampaigns(page);
    await page.getByRole('button', { name: 'Retry', exact: true }).click({ timeout: 20_000 });
    await expect.poll(bootstrap.attempts).toBe(2);
    await page.locator('[data-app-navigation="desktop"]').getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(page.locator('main[data-route-shell="projects"]')).toBeVisible();
    bootstrap.release();
    await bootstrap.completed;
    // Leave time for the released request and any erroneous imperative exploration refetch to settle.
    await page.waitForTimeout(350);
    await expect(page.locator('main[data-route-shell="projects"]')).toBeVisible();
    await expect(page.locator('main[data-route-shell="campaigns"]')).toHaveCount(0);
    expect(requests.campaigns).toEqual([]);
    expectNoPendingRevision(requests);
  } finally {
    bootstrap.release();
  }
});
