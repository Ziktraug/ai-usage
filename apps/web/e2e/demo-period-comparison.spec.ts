import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForFocusedReportSettled, waitForHydratedReport } from './browser-test';

/**
 * The synthetic report is generated on 11 June 2026 and its history starts on 12 April 2026.
 * Today holds one 203,500-token session worth $3.20; the day before holds one 76,600-token
 * session worth $0.17.
 */
const TODAY_API_VALUE_STATEMENT = '1782% higher than the previous equal-length period.';
const IN_PROGRESS_CAVEAT = 'This period is still in progress, so the comparison is provisional.';
const NO_PREVIOUS_PERIOD = 'No previous period exists before the full recorded range.';
const PROCESSED_TOKENS_EXPLANATION = [
  'Previous period, same filters: Jun 10, 2026 · 76,600 processed tokens',
  IN_PROGRESS_CAVEAT,
].join('\n');
const MAX_TAB_STOPS = 60;
/**
 * An open tooltip is portalled to the document body, outside every landmark, which the
 * best-practice `region` rule reports for any tooltip of the design system. The open state is
 * therefore checked against the WCAG A and AA rules; the settled page runs every default rule.
 */
const WCAG_RULE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];

const heroFor = (page: Page): Locator => page.getByRole('region', { name: 'Estimated API-equivalent value' });
const comparisonFor = (page: Page): Locator => heroFor(page).locator('[data-period-comparison]');
const processedTokensDeltaFor = (page: Page): Locator =>
  page.locator('[data-executive-metrics] > div').filter({ hasText: 'Processed tokens' }).locator('[data-period-delta]');
const sessionFilterFor = (page: Page): Locator =>
  page.getByRole('textbox', { name: 'Filter sessions by title, project, model, provider, or harness' });

const selectPeriod = async (page: Page, name: string): Promise<void> => {
  await page.getByRole('region', { name: 'Report period' }).getByRole('button', { exact: true, name }).click();
  await waitForFocusedReportSettled(page);
};

const openOverview = async (page: Page): Promise<void> => {
  await page.goto('/');
  await waitForHydratedReport(page);
  await waitForFocusedReportSettled(page);
};

const tabTo = async (page: Page, target: Locator): Promise<void> => {
  for (let stop = 0; stop < MAX_TAB_STOPS; stop += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  throw new Error('The keyboard never reached the comparison explanation');
};

test('compares each period with the previous one, or says why it cannot', async ({ page }) => {
  await openOverview(page);
  const comparison = comparisonFor(page);
  const delta = processedTokensDeltaFor(page);

  // Default 30 days: recorded history starts inside the previous 30 days.
  await expect(comparison).toHaveAttribute('data-period-comparison', 'history-shorter-than-window');
  await expect(comparison).toContainText('No percentage: the previous period is only partly recorded.');
  await expect(comparison.getByRole('button')).toHaveAccessibleName(
    'Recorded history starts Apr 12, 2026 under the current filters.\nPrevious period, same filters: Apr 11, 2026 – May 11, 2026',
  );
  await expect(delta).toHaveCount(0);

  await selectPeriod(page, 'Today');
  await expect(comparison).toHaveAttribute('data-period-comparison', 'change');
  await expect(comparison).toContainText(TODAY_API_VALUE_STATEMENT);
  await expect(comparison.locator('[data-period-comparison-caveat]')).toHaveText(IN_PROGRESS_CAVEAT);
  await expect(comparison.getByRole('button')).toHaveAccessibleName(
    'Previous period, same filters: Jun 10, 2026 · $0.17 API-equivalent value',
  );
  await expect(delta).toContainText('+166% vs previous period');
  await expect(page.locator('[data-period-delta]')).toHaveCount(1);

  // The comparison follows the filter set: this title only matches the session of today.
  await sessionFilterFor(page).fill('Build report UI');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Build report UI');
  await waitForFocusedReportSettled(page);
  await expect(comparison).toHaveAttribute('data-period-comparison', 'history-shorter-than-window');
  await expect(comparison).toContainText(NO_PREVIOUS_PERIOD);
  await expect(delta).toHaveCount(0);
  await sessionFilterFor(page).fill('');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBeNull();
  await waitForFocusedReportSettled(page);
  await expect(delta).toHaveCount(1);

  await selectPeriod(page, '7d');
  await expect(comparison).toHaveAttribute('data-period-comparison', 'no-previous-sessions');
  await expect(comparison).toContainText('No sessions exist in the previous period.');
  await expect(delta).toHaveCount(0);

  await selectPeriod(page, 'All time');
  await expect(comparison).toHaveAttribute('data-period-comparison', 'full-range');
  await expect(comparison).toContainText(NO_PREVIOUS_PERIOD);
  await expect(comparison.getByRole('button')).toHaveCount(0);
  await expect(delta).toHaveCount(0);
});

test('explains the processed-token delta to keyboard, pointer and assistive technology alike', async ({ page }) => {
  await openOverview(page);
  await selectPeriod(page, 'Today');
  const marker = processedTokensDeltaFor(page).getByRole('button');
  const tooltip = page.getByRole('tooltip');

  await expect(marker).toHaveAccessibleName(PROCESSED_TOKENS_EXPLANATION);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole('region', { name: 'Report period' }).getByRole('button', { exact: true, name: 'Today' }).focus();
  await tabTo(page, marker);
  await expect(tooltip).toHaveText(PROCESSED_TOKENS_EXPLANATION);
  expect((await new AxeBuilder({ page }).withTags(WCAG_RULE_TAGS).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);

  await heroFor(page).locator('strong').first().hover();
  await marker.hover();
  await expect(tooltip).toHaveText(PROCESSED_TOKENS_EXPLANATION);
});

test('keeps the Overview free of accessibility violations when no percentage can be shown', async ({ page }) => {
  await openOverview(page);
  await expect(comparisonFor(page)).toHaveAttribute('data-period-comparison', 'history-shorter-than-window');

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
