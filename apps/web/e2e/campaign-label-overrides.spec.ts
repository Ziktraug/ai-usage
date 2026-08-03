import type { Locator, Page } from '@playwright/test';
import { expect, reportViewsFor, test } from './browser-test';

const CAMPAIGN_KEY = 'fixture-machine:codex:campaign-root';
const DERIVED_LABEL = 'Build report UI';
const RENAMED_LABEL = 'Release train';
const CAMPAIGN_LABEL_RPC_PATH = '/rpc/campaign/setLabelOverride';
const CAMPAIGN_OVERVIEW_PATTERN = /Campaign ·/;
const CAMPAIGN_FILTER_URL = `/?filters=${encodeURIComponent(JSON.stringify({ campaign: CAMPAIGN_KEY }))}&tab=sessions`;

const campaignFilterFromUrl = (page: Page): string | null => {
  const serializedFilters = new URL(page.url()).searchParams.get('filters');
  if (!serializedFilters) {
    return null;
  }
  const parsed: unknown = JSON.parse(serializedFilters);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const campaign = Reflect.get(parsed, 'campaign');
  return typeof campaign === 'string' ? campaign : null;
};

const campaignRow = (page: Page, label: string): Locator =>
  page.locator('[data-session-row-id]').filter({ hasText: label }).first();

const campaignOverviewButton = (page: Page, label: string): Locator =>
  page.getByRole('button').filter({ hasText: label }).filter({ hasText: CAMPAIGN_OVERVIEW_PATTERN }).first();

const collectCampaignLabelRpcRequests = (page: Page): string[] => {
  const paths: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === CAMPAIGN_LABEL_RPC_PATH) {
      paths.push(pathname);
    }
  });
  return paths;
};

test('renames and resets one page-local campaign label without changing its filter key', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1024 });
  const campaignLabelRpcRequests = collectCampaignLabelRpcRequests(page);
  await page.goto(CAMPAIGN_FILTER_URL);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect.poll(() => campaignFilterFromUrl(page)).toBe(CAMPAIGN_KEY);
  await expect(page.getByTitle('Clear Campaign filter')).toContainText(`Campaign: ${CAMPAIGN_KEY}`);

  await campaignRow(page, DERIVED_LABEL).click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  const labelInput = drawer.getByRole('textbox', { name: 'Campaign label' });
  const renameButton = drawer.getByRole('button', { exact: true, name: 'Rename' });
  await expect(labelInput).toHaveValue(DERIVED_LABEL);
  await labelInput.fill(RENAMED_LABEL);
  await expect(renameButton).toBeEnabled();
  await renameButton.click();
  await expect(labelInput).toHaveValue(RENAMED_LABEL);
  await expect(drawer.getByText(RENAMED_LABEL, { exact: true })).toBeVisible();
  await expect.poll(() => campaignFilterFromUrl(page)).toBe(CAMPAIGN_KEY);

  await drawer.getByRole('button', { name: 'Close session details' }).click();
  await expect(drawer).not.toBeVisible();
  await expect(campaignRow(page, RENAMED_LABEL)).toBeVisible();

  await campaignRow(page, RENAMED_LABEL).click();
  await expect(labelInput).toHaveValue(RENAMED_LABEL);
  await expect(drawer.getByRole('button', { exact: true, name: 'Reset' })).toBeEnabled();
  await drawer.getByRole('button', { name: 'Close session details' }).click();

  const freshPage = await page.context().newPage();
  const freshPageCampaignLabelRpcRequests = collectCampaignLabelRpcRequests(freshPage);
  await freshPage.setViewportSize({ height: 900, width: 1024 });
  await freshPage.goto(CAMPAIGN_FILTER_URL);
  await expect(freshPage.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(campaignRow(freshPage, DERIVED_LABEL)).toBeVisible();
  await campaignRow(freshPage, DERIVED_LABEL).click();
  await expect(
    freshPage.getByRole('dialog', { name: 'Session details' }).getByRole('textbox', { name: 'Campaign label' }),
  ).toHaveValue(DERIVED_LABEL);
  expect(freshPageCampaignLabelRpcRequests).toEqual([]);
  await freshPage.close();

  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Overview' }).click();
  await expect(campaignOverviewButton(page, RENAMED_LABEL)).toBeVisible();
  const dateRange = page.getByRole('region', { name: 'Date range' });
  const chartOptions = dateRange.locator('details[aria-label="Chart options"]');
  await chartOptions.locator('summary').click();
  await chartOptions.getByRole('radio', { exact: true, name: 'Campaign' }).click();
  await expect(dateRange.getByTitle(RENAMED_LABEL, { exact: true })).toContainText(RENAMED_LABEL);
  await expect.poll(() => campaignFilterFromUrl(page)).toBe(CAMPAIGN_KEY);

  await campaignOverviewButton(page, RENAMED_LABEL).click();
  await expect(labelInput).toHaveValue(RENAMED_LABEL);
  const resetButton = drawer.getByRole('button', { exact: true, name: 'Reset' });
  await resetButton.click();
  await expect(labelInput).toHaveValue(DERIVED_LABEL);
  await expect(resetButton).toBeDisabled();
  await drawer.getByRole('button', { name: 'Close session details' }).click();

  await expect(campaignOverviewButton(page, DERIVED_LABEL)).toBeVisible();
  await expect(dateRange.getByTitle(DERIVED_LABEL, { exact: true })).toContainText(DERIVED_LABEL);
  await expect(dateRange.getByTitle(RENAMED_LABEL, { exact: true })).toHaveCount(0);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
  await expect(campaignRow(page, DERIVED_LABEL)).toBeVisible();
  await expect.poll(() => campaignFilterFromUrl(page)).toBe(CAMPAIGN_KEY);
  expect(campaignLabelRpcRequests).toEqual([]);
});
