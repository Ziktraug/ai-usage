import type { Locator, Page } from '@playwright/test';
import {
  FOCUSED_REPORT_E2E_ENABLED_KEY,
  FOCUSED_REPORT_E2E_MODEL_TAIL_KEY,
  FOCUSED_REPORT_E2E_NINETY_DAY_COMPARISON_KEY,
  FOCUSED_REPORT_E2E_VISIBLE_TREND_KEY,
} from '../src/focused-report-e2e-fixture';
import { expect, openHydratedReport, reportViewsFor, test, waitForFocusedReportSettled } from './browser-test';
import { createServerStateNetworkTrace } from './server-state-network';

const CALENDAR_NAME_PATTERN = /Daily activity calendar/;
const CHART_VIEW_PATTERN = /Chart view:/;
const DELEGATED_LEGEND_PATTERN = /^Delegated\b/;
const HUMAN_LEGEND_PATTERN = /^Human\b/;
const API_VALUE_BUCKET_PATTERN = /API value: \$/;
const PROCESSED_TOKEN_BUCKET_PATTERN = /Processed tokens: [0-9,]+ tokens$/;
const PUNCHCARD_CELL_BUTTON_PATTERN = /^Filter report to /;
const PUNCHCARD_CELL_LABEL_PATTERN =
  /^Filter report to (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) ([0-9]{2}):00–[0-9]{2}:59, ([0-9,]+) sessions?$/;
const SESSION_SUMMARY_PATTERN = / sessions$/;

const SESSION_COUNT_PATTERN = /^[0-9,]+ sessions$/;
const RANGE_DAYS_PATTERN = /·\s*(\d+)\s*days?/;
const READABLE_CUSTOM_RANGE_PATTERN = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;
// The bug this guards against bound the class to the `'start' | 'end'` edge
// name, so the generated style never applied. Assert the edge name itself never
// reaches the class list rather than pattern-matching a Panda atom, which a
// hyphenated domain value would also satisfy.
const HANDLE_EDGE_NAMES = ['start', 'end'] as const;
// WCAG 2.5.5 Target Size (Enhanced); `timeSliderThumb` is sized for it.
const HANDLE_MINIMUM_TARGET_PX = 44;
const BRUSH_GEOMETRY_VIEWPORTS = [
  { height: 1000, width: 1440 },
  { height: 900, width: 1024 },
  { height: 900, width: 768 },
  // The frozen narrow viewport the responsive suites use elsewhere.
  { height: 800, width: 361 },
] as const;

interface BrushHandleGeometry {
  centerX: number;
  classes: string[];
  height: number;
  label: string | null;
  position: string;
  role: string | null;
  valueText: string | null;
  width: number;
}

interface BrushGeometry {
  handles: BrushHandleGeometry[];
  offsets: number[];
}

const readBrushGeometry = (element: Element): BrushGeometry => {
  const selection = element.querySelector('[aria-label="Selected report window"]');
  if (!selection) {
    throw new Error('Expected the selected report window');
  }
  const selectionBox = selection.getBoundingClientRect();
  const handles = [...element.querySelectorAll('[role="slider"]')].map((handle) => {
    const box = handle.getBoundingClientRect();
    return {
      centerX: box.left + box.width / 2,
      classes: [...handle.classList],
      height: box.height,
      label: handle.getAttribute('aria-label'),
      position: getComputedStyle(handle).position,
      role: handle.getAttribute('role'),
      valueText: handle.getAttribute('aria-valuetext'),
      width: box.width,
    };
  });
  const edgeFor = (label: string): number => (label === 'Start date' ? selectionBox.left : selectionBox.right);
  return {
    handles,
    offsets: handles.map((handle) => Math.round(handle.centerX - edgeFor(handle.label ?? ''))),
  };
};

const reportRangeValue = (page: Page): string | null => new URL(page.url()).searchParams.get('range');
const ninetyDayReportUrl = (): string => `/?${new URLSearchParams({ range: JSON.stringify({ mode: '90d' }) })}`;

const navigationEntryKey = async (page: Page): Promise<string | null> =>
  await page.evaluate(() => {
    const states = Reflect.get(history.state ?? {}, 'sveltekit:states');
    if (!(states && typeof states === 'object')) {
      return null;
    }
    const key = Reflect.get(states, 'aiUsageNavigationKey');
    return typeof key === 'string' ? key : null;
  });

const reportPeriodFor = (page: Page): Locator => page.getByRole('region', { name: 'Report period' });
const activityFor = (page: Page): Locator => page.getByRole('region', { name: 'Activity' });
const activityMetricFor = (page: Page): Locator => activityFor(page).getByRole('group', { name: 'Activity metric' });
const activityExplorerFor = (page: Page): Locator =>
  activityFor(page).locator('details[aria-label="Explore activity"]');
const openActivityExplorer = async (page: Page): Promise<Locator> => {
  const explorer = activityExplorerFor(page);
  if ((await explorer.getAttribute('open')) === null) {
    await explorer.locator('summary').click();
  }
  await expect(explorer).toHaveAttribute('open', '');
  return explorer;
};
const openCustomPeriod = async (page: Page): Promise<{ from: Locator; to: Locator }> => {
  await reportPeriodFor(page).getByRole('button', { name: 'Choose a custom report period' }).click();
  return {
    from: page.getByLabel('From', { exact: true }),
    to: page.getByLabel('To', { exact: true }),
  };
};

test('uses one report range for the dashboard and activity chart', async ({ page }) => {
  await page.addInitScript(
    ({ enabledKey, trendKey }) => {
      Reflect.set(globalThis, enabledKey, true);
      Reflect.set(globalThis, trendKey, true);
    },
    { enabledKey: FOCUSED_REPORT_E2E_ENABLED_KEY, trendKey: FOCUSED_REPORT_E2E_VISIBLE_TREND_KEY },
  );
  await openHydratedReport(page);
  await waitForFocusedReportSettled(page);

  const period = reportPeriodFor(page);
  const activity = activityFor(page);
  await expect(period.getByRole('button', { exact: true, name: 'All time' })).toBeVisible();
  await expect(period.getByRole('button', { exact: true, name: 'Today' })).toBeVisible();
  await expect(period.getByRole('button', { exact: true, name: '7d' })).toBeVisible();
  await expect(period.getByRole('button', { exact: true, name: '30d' })).toBeVisible();
  await expect(period.getByRole('button', { exact: true, name: '90d' })).toBeVisible();
  await expect(period.getByRole('button', { name: 'Choose a custom report period' })).toBeVisible();
  await expect(period.getByRole('button', { exact: true, name: '30d' })).toHaveAttribute('aria-pressed', 'true');
  await expect(period.getByText('May 12 → Jun 11, 2026 · 31 days', { exact: true })).toBeVisible();
  await expect(period.getByText('Filters the entire report', { exact: true })).toHaveCount(0);
  await expect(activity.getByTitle('Filter by Codex')).toHaveCount(1);
  expect(
    await period
      .locator('[data-report-range-part]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-report-range-part'))),
  ).toEqual(['summary']);
  expect(
    await activity
      .locator('[data-report-range-part]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-report-range-part'))),
  ).toEqual(['total-legend', 'chart', 'chart-axis', 'activity-explorer', 'brush', 'brush-axis']);
  await expect(activity.getByText(CHART_VIEW_PATTERN)).toHaveCount(0);
  await expect(activity.getByRole('button', { name: 'Zoom chart' })).toHaveCount(0);
  await expect(activity.getByRole('slider', { name: 'Graph view start' })).toHaveCount(0);

  const chartOptions = activityExplorerFor(page);
  await expect(chartOptions).not.toHaveAttribute('open', '');
  await expect(
    activityFor(page).getByText('Harness · Day · Estimated API-equivalent value', { exact: true }),
  ).toBeVisible();
  await expect(chartOptions.getByText('Group by', { exact: true })).not.toBeVisible();

  await chartOptions.locator('summary').click();

  await expect(chartOptions).toHaveAttribute('open', '');
  await expect(chartOptions.getByText('Group by', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Interval', { exact: true })).toBeVisible();
  await expect(chartOptions.getByText('Metric', { exact: true })).toHaveCount(0);
  await expect(chartOptions.locator('[data-brush-tick]')).toHaveText(['May', 'Jun']);

  const timeline = activity.getByRole('button', {
    name: 'Inspect activity timeline. Use arrow keys to inspect days.',
  });
  await timeline.focus();
  await timeline.press('End');
  const trend = activity.locator('[data-timeline-trend]');
  await expect(trend).toBeVisible();
  await expect(trend).toHaveText('▲ 100%');
});

test('switches API value and processed tokens locally without changing report identity', async ({ page }) => {
  await openHydratedReport(page);
  await waitForFocusedReportSettled(page);

  const activity = activityFor(page);
  const metricControl = activityMetricFor(page);
  const apiValue = metricControl.getByRole('button', { exact: true, name: 'API value' });
  const tokens = metricControl.getByRole('button', { exact: true, name: 'Tokens' });
  const sessions = metricControl.getByRole('button', { exact: true, name: 'Sessions' });
  const share = metricControl.getByRole('button', { exact: true, name: 'Share' });
  const chart = activity.locator('[data-report-range-part="chart"]');
  const firstBucket = chart.getByRole('img').first();
  await expect(metricControl.getByRole('button')).toHaveCount(4);
  await expect(apiValue).toHaveAttribute('aria-pressed', 'true');
  await expect(firstBucket).toHaveAccessibleName(API_VALUE_BUCKET_PATTERN);
  const costLabel = await firstBucket.getAttribute('aria-label');
  const initialUrl = page.url();

  const serverStateTrace = createServerStateNetworkTrace(page);
  serverStateTrace.checkpoint('activity-metric-toggle');
  await tokens.click();
  await expect(tokens).toHaveAttribute('aria-pressed', 'true');
  await expect(activity.locator('[data-timeline-metric="tokens"]')).toBeVisible();
  await expect(firstBucket).toHaveAccessibleName(PROCESSED_TOKEN_BUCKET_PATTERN);
  expect(await firstBucket.getAttribute('aria-label')).not.toBe(costLabel);

  await apiValue.click();
  await expect(apiValue).toHaveAttribute('aria-pressed', 'true');
  await expect(activity.locator('[data-timeline-metric="cost"]')).toBeVisible();
  await expect(firstBucket).toHaveAttribute('aria-label', costLabel ?? '');

  const explorer = await openActivityExplorer(page);
  await expect(explorer.getByRole('radiogroup', { name: 'Metric' })).toHaveCount(0);
  await sessions.click();
  await expect(apiValue).toHaveAttribute('aria-pressed', 'false');
  await expect(tokens).toHaveAttribute('aria-pressed', 'false');
  await expect(sessions).toHaveAttribute('aria-pressed', 'true');
  await share.click();
  await expect(share).toHaveAttribute('aria-pressed', 'true');
  await expect(metricControl.locator('[aria-pressed="true"]')).toHaveCount(1);
  await tokens.focus();
  await page.keyboard.press('Space');
  await expect(tokens).toBeFocused();
  await expect(tokens).toHaveAttribute('aria-pressed', 'true');
  await apiValue.click();
  await expect(apiValue).toHaveAttribute('aria-pressed', 'true');

  expect(page.url()).toBe(initialUrl);
  expect(serverStateTrace.counts('activity-metric-toggle')).toEqual({
    operations: {},
    owners: {},
    routeData: 0,
    totalRpc: 0,
  });
  serverStateTrace.dispose();
});

test('keeps period targets tactile and wraps chart options below the narrow viewport', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openHydratedReport(page);
  await waitForFocusedReportSettled(page);

  const period = reportPeriodFor(page);
  const periodButtons = period.getByRole('button');
  await expect(periodButtons).toHaveCount(6);
  for (const button of await periodButtons.all()) {
    expect(Math.round((await button.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(44);
  }
  const activityMetricButtons = activityMetricFor(page).getByRole('button');
  await expect(activityMetricButtons).toHaveCount(4);
  for (const button of await activityMetricButtons.all()) {
    expect(Math.round((await button.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(44);
  }

  await period.getByRole('button', { name: 'Choose a custom report period' }).click();
  await waitForFocusedReportSettled(page);
  const customFields = period.locator('[data-report-range-part="adjustments"]');
  const customInputs = customFields.getByRole('textbox');
  await expect(customInputs).toHaveCount(2);
  await expect(customFields.locator('input[title="Date as YYYY-MM-DD"]')).toHaveCount(2);
  const customGeometry = await customFields.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      left: bounds.left,
      right: bounds.right,
      scrollWidth: element.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  expect(customGeometry.scrollWidth).toBeLessThanOrEqual(customGeometry.clientWidth);
  expect(customGeometry.left).toBeGreaterThanOrEqual(0);
  expect(customGeometry.right).toBeLessThanOrEqual(customGeometry.viewportWidth);
  for (const input of await customInputs.all()) {
    const bounds = await input.boundingBox();
    expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? customGeometry.viewportWidth + 1)).toBeLessThanOrEqual(
      customGeometry.viewportWidth,
    );
  }

  await page.setViewportSize({ height: 844, width: 320 });
  const summary = activityExplorerFor(page).locator('summary');
  const geometry = await summary.evaluate((element) => {
    const current = element.querySelector('span:last-child');
    if (!(current instanceof HTMLElement)) {
      throw new Error('Expected the current chart-options summary');
    }
    const currentStyle = getComputedStyle(current);
    return {
      clientWidth: element.clientWidth,
      currentMinWidth: currentStyle.minWidth,
      currentWhiteSpace: currentStyle.whiteSpace,
      scrollWidth: element.scrollWidth,
    };
  });

  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.currentMinWidth).toBe('0px');
  expect(geometry.currentWhiteSpace).toBe('normal');
});

test('restores a bounded 90d period from a mobile deep link, reload, and history', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await openHydratedReport(page, ninetyDayReportUrl());
  await waitForFocusedReportSettled(page);

  let period = reportPeriodFor(page);
  await expect(period.getByRole('button', { exact: true, name: '90d' })).toHaveAttribute('aria-pressed', 'true');
  await expect(period.getByText('Mar 13 → Jun 11, 2026 · 91 days', { exact: true })).toBeVisible();
  const executiveValue = page.getByRole('region', { name: 'Estimated API-equivalent value' });
  await expect(executiveValue).toContainText('last 90 days');
  await expect(executiveValue).toContainText('No sessions exist in the previous period.');

  await page.reload();
  await waitForFocusedReportSettled(page);
  period = reportPeriodFor(page);
  await expect(period.getByRole('button', { exact: true, name: '90d' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/?range=90d');
  await waitForFocusedReportSettled(page);
  await expect(reportPeriodFor(page).getByRole('button', { exact: true, name: '90d' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await period.getByRole('button', { exact: true, name: '7d' }).click();
  await waitForFocusedReportSettled(page);
  await expect.poll(() => reportRangeValue(page)).toContain('7d');

  await page.goBack();
  await waitForFocusedReportSettled(page);
  await expect.poll(() => reportRangeValue(page)).toContain('90d');
  await expect(reportPeriodFor(page).getByRole('button', { exact: true, name: '90d' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.goForward();
  await waitForFocusedReportSettled(page);
  await expect.poll(() => reportRangeValue(page)).toContain('7d');
  await expect(reportPeriodFor(page).getByRole('button', { exact: true, name: '7d' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('compares 90d with the previous equal-length period when that boundary has data', async ({ page }) => {
  await page.addInitScript(
    ({ comparisonKey, enabledKey }) => {
      Reflect.set(globalThis, enabledKey, true);
      Reflect.set(globalThis, comparisonKey, true);
    },
    {
      comparisonKey: FOCUSED_REPORT_E2E_NINETY_DAY_COMPARISON_KEY,
      enabledKey: FOCUSED_REPORT_E2E_ENABLED_KEY,
    },
  );
  await openHydratedReport(page);

  await reportPeriodFor(page).getByRole('button', { exact: true, name: '90d' }).click();
  await waitForFocusedReportSettled(page);

  const executiveValue = page.getByRole('region', { name: 'Estimated API-equivalent value' });
  await expect(executiveValue.locator('strong').first()).toHaveText('$3.54');
  await expect(executiveValue).toContainText('321% higher than the previous equal-length period.');
  await expect(executiveValue).not.toContainText('Partially measured');
  await expect(executiveValue).not.toContainText('No sessions exist in the previous period.');
  await expect(page.locator('[data-period-insight]')).toHaveCount(1);
});

test('uses clickable heatmap days as Rhythm activity-day controls without a native date input', async ({ page }) => {
  await openHydratedReport(page);

  const calendar = page.getByRole('toolbar', { name: CALENDAR_NAME_PATTERN });
  const rhythm = page.locator('section').filter({ has: calendar });
  const heatmapDays = calendar.locator('button[data-heatmap-day]');
  await expect(rhythm.getByRole('heading', { exact: true, name: 'Rhythm' })).toBeVisible();
  await expect(rhythm.locator('input[type="date"]')).toHaveCount(0);
  expect(await heatmapDays.count()).toBeGreaterThan(0);

  await heatmapDays.first().click();
  await waitForFocusedReportSettled(page);
  await expect(reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('filters the report from non-empty Punchcard cells with click and keyboard', async ({ page }) => {
  await openHydratedReport(page);

  const heading = page.getByRole('heading', { exact: true, name: 'Punchcard' });
  const punchcard = heading.locator('xpath=ancestor::section[1]');
  const timeCellButtons = punchcard.getByRole('button', { name: PUNCHCARD_CELL_BUTTON_PATTERN });
  await expect(heading).toBeVisible();
  expect(await timeCellButtons.count()).toBeGreaterThan(0);
  expect(await punchcard.locator('[title*="0 sessions"]').count()).toBeGreaterThan(0);
  await expect(punchcard.locator('button[title*="0 sessions"]')).toHaveCount(0);

  const ariaLabel = await timeCellButtons.first().getAttribute('aria-label');
  if (ariaLabel === null) {
    throw new Error('Expected a Punchcard cell label');
  }
  const match = ariaLabel.match(PUNCHCARD_CELL_LABEL_PATTERN);
  if (!match) {
    throw new Error('Expected a canonical Punchcard cell label');
  }
  const weekday = match[1] ?? '';
  const hour = match[2] ?? '';
  const formattedCount = match[3] ?? '';
  const weekdayCodes = new Map<string, string>([
    ['Monday', 'MON'],
    ['Tuesday', 'TUE'],
    ['Wednesday', 'WED'],
    ['Thursday', 'THU'],
    ['Friday', 'FRI'],
    ['Saturday', 'SAT'],
    ['Sunday', 'SUN'],
  ]);
  const weekdayCode = weekdayCodes.get(weekday);
  if (!(weekdayCode && hour && formattedCount)) {
    throw new Error('Expected a complete Punchcard cell label');
  }
  const timeCellValue = `${weekdayCode}-${hour}`;
  const period = `${weekday} ${hour}:00–${hour}:59`;
  const timePill = page.getByTitle('Clear Time filter');
  const summary = page.locator('[data-active-filters] span[aria-live="polite"]').filter({
    hasText: SESSION_SUMMARY_PATTERN,
  });
  const firstTimeCell = punchcard.getByRole('button', { exact: true, name: ariaLabel });

  await firstTimeCell.focus();
  await firstTimeCell.press('Enter');
  await expect.poll(() => new URL(page.url()).searchParams.get('timeCell')).toBe(timeCellValue);
  await waitForFocusedReportSettled(page);
  await expect(timePill).toHaveText(`Time · ${period} ×`);
  await expect(summary).toContainText(`${formattedCount} / `);

  await timePill.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('timeCell')).toBeNull();
  await waitForFocusedReportSettled(page);
  await expect(timePill).toHaveCount(0);

  await punchcard.getByRole('button', { exact: true, name: ariaLabel }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('timeCell')).toBe(timeCellValue);
  await waitForFocusedReportSettled(page);
  await expect(timePill).toHaveText(`Time · ${period} ×`);
  await timePill.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('timeCell')).toBeNull();
  await waitForFocusedReportSettled(page);
});

test('changes every chart option from its segmented controls', async ({ page }) => {
  await openHydratedReport(page);

  const chartOptions = await openActivityExplorer(page);

  for (const option of ['Campaign', 'Machine', 'Origin', 'Model', 'Provider', 'Project', 'Harness']) {
    await chartOptions.getByRole('radio', { exact: true, name: option }).click();
    await expect(chartOptions.getByRole('radio', { exact: true, name: option })).toBeChecked();
  }

  for (const option of ['Week', 'Month', 'Day']) {
    await chartOptions.getByRole('radio', { exact: true, name: option }).click();
    await expect(chartOptions.getByRole('radio', { exact: true, name: option })).toBeChecked();
  }
  await chartOptions.getByRole('radio', { exact: true, name: 'Auto (Day)' }).click();
  await expect(chartOptions.getByRole('radio', { exact: true, name: 'Auto (Day)' })).toBeChecked();

  for (const option of ['Share', 'Sessions', 'Tokens', 'API value']) {
    await activityMetricFor(page).getByRole('button', { exact: true, name: option }).click();
    await expect(activityMetricFor(page).getByRole('button', { exact: true, name: option })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  await expect(
    activityFor(page).getByText('Harness · Day · Estimated API-equivalent value', { exact: true }),
  ).toBeVisible();
});

test('resolves Auto to Week for a long readable custom range and permits a Day override', async ({ page }) => {
  await openHydratedReport(page, '/?range=2026-01-01..2026-06-11');
  await waitForFocusedReportSettled(page);

  const activity = activityFor(page);
  const chartOptions = await openActivityExplorer(page);
  const buckets = activity.locator('[data-report-range-part="chart"] [role="img"]');
  await expect(chartOptions.getByRole('radio', { exact: true, name: 'Auto (Week)' })).toBeChecked();
  await expect(activity.getByText('Harness · Week · Estimated API-equivalent value', { exact: true })).toBeVisible();
  const weeklyBucketCount = await buckets.count();

  await chartOptions.getByRole('radio', { exact: true, name: 'Day' }).click();
  await waitForFocusedReportSettled(page);
  await expect(activity.getByText('Harness · Day · Estimated API-equivalent value', { exact: true })).toBeVisible();
  await expect.poll(() => buckets.count()).toBeGreaterThan(weeklyBucketCount);

  await page.goto('/?range=2024-01-01..2026-06-11');
  await waitForFocusedReportSettled(page);
  const monthActivity = activityFor(page);
  const monthOptions = await openActivityExplorer(page);
  await expect(monthOptions.getByRole('radio', { exact: true, name: 'Auto (Month)' })).toBeChecked();
  await expect(
    monthActivity.getByText('Harness · Month · Estimated API-equivalent value', { exact: true }),
  ).toBeVisible();
});

test('keeps readable open ranges ordered outside the known report domain', async ({ page }) => {
  await openHydratedReport(page, '/?range=..2025-01-01');
  await waitForFocusedReportSettled(page);
  await expect(reportPeriodFor(page).getByText('Jan 1 → Jan 01, 2025 · 1 day', { exact: true })).toBeVisible();

  await page.goto('/?range=2027-01-01..');
  await waitForFocusedReportSettled(page);
  await expect(reportPeriodFor(page).getByText('Jan 1 → Jan 01, 2027 · 1 day', { exact: true })).toBeVisible();
});

test('groups the timeline by campaign, machine, and origin with matching legends', async ({ page }) => {
  await openHydratedReport(page);

  const activity = activityFor(page);
  const chartOptions = await openActivityExplorer(page);

  await chartOptions.getByRole('radio', { exact: true, name: 'Campaign' }).click();
  await expect(activity.getByText('Campaign · Day · Estimated API-equivalent value', { exact: true })).toBeVisible();
  await expect(activity.getByTitle('Build report UI', { exact: true })).toContainText('Build report UI');
  await expect(activity.getByTitle('Recover Claude history', { exact: true })).toContainText('Recover Claude history');
  // `Inspect OpenCode root` runs a free model, so it carries no API-equivalent value and the value
  // legend legitimately omits it. It has to reappear once the metric counts sessions instead.
  await expect(activity.getByTitle('Inspect OpenCode root', { exact: true })).toHaveCount(0);
  await activityMetricFor(page).getByRole('button', { exact: true, name: 'Sessions' }).click();
  await expect(activity.getByTitle('Inspect OpenCode root', { exact: true })).toContainText('Inspect OpenCode root');
  await activityMetricFor(page).getByRole('button', { exact: true, name: 'API value' }).click();

  await chartOptions.getByRole('radio', { exact: true, name: 'Machine' }).click();
  await expect(activity.getByText('Machine · Day · Estimated API-equivalent value', { exact: true })).toBeVisible();
  await expect(activity.getByTitle('Filter by Fixture Machine · Stale')).toContainText('Fixture Machine · Stale');
  // The unattributed session is the free-model one, so the value legend drops it for the same reason
  // as the campaign above. Counting sessions brings it back.
  await expect(activity.getByTitle('Unknown machine')).toHaveCount(0);

  await activityMetricFor(page).getByRole('button', { exact: true, name: 'Sessions' }).click();
  await expect(activity.getByTitle('Unknown machine')).toContainText('Unknown machine');
  await chartOptions.getByRole('radio', { exact: true, name: 'Origin' }).click();
  await expect(activity.getByText('Origin · Day · Sessions', { exact: true })).toBeVisible();
  await expect(activity.getByRole('button', { name: HUMAN_LEGEND_PATTERN })).toContainText('Human');
  await expect(activity.getByRole('button', { name: DELEGATED_LEGEND_PATTERN })).toContainText('Delegated');
});

test('commits preset, text, keyboard, and pointer report ranges to the URL', async ({ page }) => {
  await openHydratedReport(page);

  const period = reportPeriodFor(page);
  await period.getByRole('button', { exact: true, name: 'All time' }).click();
  await expect.poll(() => reportRangeValue(page)).not.toBeNull();
  await waitForFocusedReportSettled(page);
  await period.getByRole('button', { exact: true, name: '30d' }).click();
  await expect.poll(() => reportRangeValue(page)).toBeNull();
  await waitForFocusedReportSettled(page);
  await period.getByRole('button', { exact: true, name: '90d' }).click();
  await expect.poll(() => reportRangeValue(page)).toContain('90d');
  await waitForFocusedReportSettled(page);
  await expect(period.getByText('Mar 13 → Jun 11, 2026 · 91 days', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Estimated API-equivalent value' })).toContainText('last 90 days');

  let custom = await openCustomPeriod(page);
  await expect(custom.from).toHaveValue('2026-03-13');
  await expect(custom.to).toHaveValue('2026-06-11');
  await expect.poll(() => reportRangeValue(page)).toContain('2026-03-13..');
  await waitForFocusedReportSettled(page);
  const urlBeforeInvalidDraft = page.url();
  await custom.from.fill('');
  await custom.from.press('Tab');
  await expect(custom.from).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).toHaveText('Enter a valid From date (YYYY-MM-DD).');
  expect(page.url()).toBe(urlBeforeInvalidDraft);
  await custom.from.press('Escape');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(custom.from).toHaveValue('2026-03-13');

  const urlBeforeReversedDraft = page.url();
  await custom.from.fill('2026-06-12');
  await custom.from.press('Tab');
  await expect(custom.from).toHaveAttribute('aria-invalid', 'true');
  await expect(custom.to).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).toHaveText('From date must be on or before To date.');
  expect(page.url()).toBe(urlBeforeReversedDraft);
  await custom.from.press('Escape');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(custom.from).toHaveValue('2026-03-13');

  await custom.to.fill('2026-06-05');
  await custom.to.press('Tab');
  await expect.poll(() => reportRangeValue(page)).toContain('..2026-06-05');
  await custom.from.fill('2026-05-25');
  await custom.from.press('Tab');
  await expect.poll(() => reportRangeValue(page)).toContain('2026-05-25..');
  await waitForFocusedReportSettled(page);
  await expect(
    period.getByRole('button', { exact: true, name: 'Choose a custom report period, selected' }),
  ).toBeVisible();
  await expect(period.getByText('May 25 → Jun 05, 2026 · 12 days', { exact: true })).toBeVisible();

  // Keep the interaction checks on a non-empty window: moving the May 25
  // boundary by one day intentionally produces the filtered-zero state, where
  // Activity is no longer rendered.
  await period.getByRole('button', { exact: true, name: '30d' }).click();
  await waitForFocusedReportSettled(page);

  const explorer = await openActivityExplorer(page);
  const startHandle = explorer.getByRole('slider', { name: 'Start date' });
  const selectedRange = explorer.getByRole('button', { name: 'Selected report window' });
  const textUrl = page.url();
  const keyboardStart = await startHandle.getAttribute('aria-valuenow');
  await startHandle.press('ArrowRight');
  await expect(startHandle).not.toHaveAttribute('aria-valuenow', keyboardStart ?? '');
  await expect(startHandle).toHaveAttribute('aria-valuetext', 'May 13, 2026');
  await expect.poll(() => page.url()).not.toBe(textUrl);

  const keyboardUrl = page.url();
  const pointerStart = await startHandle.getAttribute('aria-valuetext');
  const selectedRangeBox = await selectedRange.boundingBox();
  expect(selectedRangeBox).not.toBeNull();
  if (selectedRangeBox) {
    const startX = selectedRangeBox.x + selectedRangeBox.width / 2;
    const startY = selectedRangeBox.y + selectedRangeBox.height / 2;
    const hitTarget = await selectedRange.evaluate(
      (_selectedElement, { x, y }) => {
        const element = document.elementFromPoint(x, y);
        return {
          ariaLabel: element?.getAttribute('aria-label') ?? null,
          tagName: element?.tagName ?? null,
        };
      },
      { x: startX, y: startY },
    );
    expect(hitTarget).toEqual({ ariaLabel: 'Selected report window', tagName: 'BUTTON' });
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await expect(selectedRange).toHaveAttribute('data-dragging', 'true');
    await page.mouse.move(startX - 50, startY, { steps: 4 });
    await expect(selectedRange).toHaveAttribute('data-dragging', 'true');
    await page.mouse.up();
  }
  await expect(startHandle).not.toHaveAttribute('aria-valuetext', pointerStart ?? '');
  await expect.poll(() => page.url()).not.toBe(keyboardUrl);

  const committedPointerSummary = await period.locator('[data-report-range-part="summary"]').innerText();
  await page.reload();
  await waitForFocusedReportSettled(page);
  await expect(reportPeriodFor(page).locator('[data-report-range-part="summary"]')).toHaveText(committedPointerSummary);

  const beforeFirstBlurKey = await navigationEntryKey(page);
  custom = await openCustomPeriod(page);
  await custom.to.fill('2026-06-05');
  await custom.to.press('Tab');
  await expect.poll(() => reportRangeValue(page)).toContain('..2026-06-05');
  await custom.from.fill('2026-05-20');
  await custom.from.press('Tab');
  await expect.poll(() => reportRangeValue(page)).toContain('2026-05-20..');
  await expect.poll(() => navigationEntryKey(page)).not.toBe(beforeFirstBlurKey);
  const firstBlurredEditKey = await navigationEntryKey(page);
  expect(firstBlurredEditKey).not.toBeNull();
  const firstBlurredEditUrl = page.url();

  await custom.from.fill('2026-05-21');
  await custom.to.fill('2026-06-05');
  await custom.to.press('Tab');
  await expect.poll(() => reportRangeValue(page)).toContain('2026-05-21..');
  await expect.poll(() => navigationEntryKey(page)).not.toBe(firstBlurredEditKey);
  const secondBlurredEditKey = await navigationEntryKey(page);
  expect(secondBlurredEditKey).not.toBeNull();
  const secondBlurredEditUrl = page.url();
  expect(secondBlurredEditUrl).not.toBe(firstBlurredEditUrl);

  await page.goBack();
  await expect.poll(() => page.url()).toBe(firstBlurredEditUrl);
  await expect.poll(() => navigationEntryKey(page)).not.toBe(secondBlurredEditKey);
  await waitForFocusedReportSettled(page);
  await expect.poll(() => page.url()).toBe(firstBlurredEditUrl);
  await expect(reportPeriodFor(page).getByText('May 20 → Jun 05, 2026 · 17 days', { exact: true })).toBeVisible();
});

test('does not capture wheel scrolling over the activity chart', async ({ page }) => {
  await openHydratedReport(page);

  const timeline = activityFor(page).getByRole('button', {
    name: 'Inspect activity timeline. Use arrow keys to inspect days.',
  });
  const initialScrollY = await page.evaluate(() => window.scrollY);
  await timeline.hover({ position: { x: 20, y: 20 } });
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => await page.evaluate(() => window.scrollY)).toBeGreaterThan(initialScrollY);
});

test('keeps the report range canonical across granularity and domain changes', async ({ page }) => {
  await openHydratedReport(page);

  const period = reportPeriodFor(page);
  const activity = activityFor(page);
  await period.getByRole('button', { exact: true, name: '7d' }).click();
  await waitForFocusedReportSettled(page);
  const selectedRange = reportRangeValue(page);

  const chartOptions = await openActivityExplorer(page);
  await chartOptions.getByRole('radio', { exact: true, name: 'Month' }).click();
  expect(reportRangeValue(page)).toBe(selectedRange);

  await activity.getByTitle('Filter by Codex').click();
  await waitForFocusedReportSettled(page);

  const reportStart = chartOptions.getByRole('slider', { name: 'Start date' });
  const reportEnd = chartOptions.getByRole('slider', { name: 'End date' });
  await expect(reportStart).toHaveAttribute('aria-valuemax', '7');
  await expect(reportStart).toHaveAttribute('aria-valuenow', '0');
  await expect(reportEnd).toHaveAttribute('aria-valuenow', '7');
  await expect(activity.getByRole('slider', { name: 'Graph view start' })).toHaveCount(0);
});

test('anchors the brush handles to the selected report window at every viewport', async ({ page }) => {
  await openHydratedReport(page);

  const brush = (await openActivityExplorer(page)).locator('[data-report-range-part="brush"]');
  const measureBrush = (): Promise<BrushGeometry> => brush.evaluate(readBrushGeometry);
  const track = brush.getByRole('button', { name: 'Selected report window' }).locator('..');
  const tickLabels = brush.locator('[data-report-range-part="brush-axis"] [data-brush-tick]');

  for (const viewport of BRUSH_GEOMETRY_VIEWPORTS) {
    await page.setViewportSize(viewport);

    // The handles are positioned from the same percentages as the selection, so
    // their centres must land on its edges however wide the track becomes.
    await expect.poll(async () => (await measureBrush()).offsets).toEqual([0, 0]);

    const geometry = await measureBrush();
    expect(geometry.handles).toHaveLength(2);
    for (const handle of geometry.handles) {
      // An edge name in the class list means a loop binding shadowed the Panda
      // class and the thumb silently lost its absolute positioning.
      expect(handle.classes.filter((token) => HANDLE_EDGE_NAMES.includes(token as 'end' | 'start'))).toEqual([]);
      expect(handle.position).toBe('absolute');
    }

    await expect(tickLabels).toHaveText(['May', 'Jun']);
    await expect(brush.locator('[data-brush-tick-mark]')).toHaveCount(2);
    const trackBox = await track.boundingBox();
    const tickGeometry = await tickLabels.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { center: box.left + box.width / 2, index: Number(node.getAttribute('data-brush-tick-index')) };
      }),
    );
    expect(trackBox).not.toBeNull();
    for (const tick of tickGeometry) {
      const expectedCenter = (trackBox?.x ?? 0) + (tick.index / 60) * (trackBox?.width ?? 0);
      expect(Math.abs(tick.center - expectedCenter)).toBeLessThanOrEqual(1);
    }
  }

  await page.setViewportSize(BRUSH_GEOMETRY_VIEWPORTS[0]);
  const startHandle = brush.getByRole('slider', { name: 'Start date' });
  const before = await measureBrush();
  await startHandle.press('ArrowRight');
  await expect.poll(async () => (await measureBrush()).offsets).toEqual([0, 0]);
  // One day later must move the thumb rightwards, not merely somewhere else.
  const afterKeyboard = await measureBrush();
  expect(afterKeyboard.handles[0]?.centerX ?? 0).toBeGreaterThan(before.handles[0]?.centerX ?? 0);
});

test('drags a brush handle with the pointer and keeps it on the selection edge', async ({ page }) => {
  await openHydratedReport(page);

  const brush = (await openActivityExplorer(page)).locator('[data-report-range-part="brush"]');
  const startHandle = brush.getByRole('slider', { name: 'Start date' });
  // `page.mouse` works in viewport coordinates and does not scroll, so the
  // handle has to be in view before its box is turned into a pointer position.
  await startHandle.scrollIntoViewIfNeeded();
  const before = await startHandle.boundingBox();
  const startedAt = await startHandle.getAttribute('aria-valuetext');
  expect(before).not.toBeNull();
  if (!before) {
    return;
  }

  // The handle became a `<button>`; prove pointer capture still drags it.
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 - 120, before.y + before.height / 2, { steps: 6 });
  await page.mouse.up();

  await expect(startHandle).not.toHaveAttribute('aria-valuetext', startedAt ?? '');
  await expect.poll(async () => (await brush.evaluate(readBrushGeometry)).offsets).toEqual([0, 0]);
  const after = await startHandle.boundingBox();
  expect(after?.x ?? 0).toBeLessThan(before.x);
  // Dragging must not leave the pointer captured on the thumb.
  await expect(brush.locator('[data-dragging="true"]')).toHaveCount(0);
});

test('draws only the selected report range and never overflows the plot', async ({ page }) => {
  await openHydratedReport(page);

  const period = reportPeriodFor(page);
  const chart = activityFor(page).locator('[data-report-range-part="chart"]');
  const readChart = () =>
    chart.evaluate((element) => {
      const boundaryRow = document.querySelector('[data-timeline-boundary-row]');
      return {
        boundaries: [...(boundaryRow?.querySelectorAll('[data-timeline-boundary]') ?? [])].map((node) =>
          (node.textContent ?? '').trim(),
        ),
        buckets: element.querySelectorAll('[role="img"]').length,
        clientWidth: element.clientWidth,
        // A per-bucket minimum that ignores the container turned 249 days into
        // roughly a thousand pixels of overflow past the panel.
        scrollWidth: element.scrollWidth,
      };
    });

  for (const preset of ['30d', '7d', 'All time'] as const) {
    await period.getByRole('button', { exact: true, name: preset }).click();
    await waitForFocusedReportSettled(page);

    const summary = await period.locator('[data-report-range-part="summary"]').innerText();
    const days = Number(RANGE_DAYS_PATTERN.exec(summary)?.[1] ?? Number.NaN);
    expect(days, summary).not.toBeNaN();

    const geometry = await readChart();
    // One bucket per calendar day the range covers, inclusive of both ends.
    expect(geometry.buckets, preset).toBe(days);
    expect(geometry.scrollWidth, preset).toBeLessThanOrEqual(geometry.clientWidth);
    // The axis must report the window, not the domain the brush can address.
    const explorer = activityExplorerFor(page);
    const selectedStart = await explorer
      .locator('[role="slider"][aria-label="Start date"]')
      .getAttribute('aria-valuetext');
    const selectedEnd = await explorer.locator('[role="slider"][aria-label="End date"]').getAttribute('aria-valuetext');
    expect(geometry.boundaries[0], preset).toBe(selectedStart);
    expect(geometry.boundaries[1], preset).toBe(selectedEnd);
  }
});

test('holds the brush scale still while dragging a range that starts before the data', async ({ page }) => {
  await openHydratedReport(page);

  // A custom range opening before the first dated session makes the index origin
  // `selectedFrom` instead of the data start, so committing on every pointermove
  // used to move the origin — and the scale — underneath the drag.
  const custom = await openCustomPeriod(page);
  await waitForFocusedReportSettled(page);
  await custom.from.fill('2026-01-01');
  await waitForFocusedReportSettled(page);

  const explorer = await openActivityExplorer(page);
  const startHandle = explorer.getByRole('slider', { name: 'Start date' });

  const scaleBefore = await startHandle.getAttribute('aria-valuemax');
  const initialValue = await startHandle.getAttribute('aria-valuetext');
  expect(scaleBefore).not.toBeNull();

  await startHandle.scrollIntoViewIfNeeded();
  const box = await startHandle.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  for (const step of [45, 90, 135, 180]) {
    await page.mouse.move(originX + step, originY);
    // The scale must not move while the handle's locally announced day follows the pointer.
    await expect(startHandle).toHaveAttribute('aria-valuemax', scaleBefore ?? '');
  }
  await expect(startHandle).not.toHaveAttribute('aria-valuetext', initialValue ?? '');
  await page.mouse.up();
  await waitForFocusedReportSettled(page);

  expect(reportRangeValue(page)).toMatch(READABLE_CUSTOM_RANGE_PATTERN);
});

test('lands the dragged range once on release while the headline follows the handle', async ({ page }) => {
  await openHydratedReport(page);

  const endHandle = (await openActivityExplorer(page)).getByRole('slider', { name: 'End date' });
  const hero = page.getByRole('region', { name: 'Estimated API-equivalent value' });
  const headline = hero.locator('strong').first();
  const urlBeforeDrag = page.url();

  await endHandle.scrollIntoViewIfNeeded();
  const box = await endHandle.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  for (const step of [30, 60, 90, 120]) {
    await page.mouse.move(originX - step, originY);
  }
  // The range is what a commit writes, so an unchanged URL is the drag having committed nothing.
  // Committing per pointermove refetched the report on every day boundary and made `pending`
  // flicker under the pointer, so the whole body dimmed and the counters above blinked.
  expect(page.url()).toBe(urlBeforeDrag);
  // The amount is summed locally from the buckets already drawn, so the headline stays live while
  // its qualifiers — which only the server knows — say they are lagging rather than mismatching.
  await expect(hero.locator('[aria-busy="true"]').first()).toBeVisible();
  // The live figure must never be dimmed along with the stale body around it.
  await expect(page.locator('[data-report-complete-output]')).toHaveCSS('opacity', '1');

  const dragged = await headline.textContent();
  await page.mouse.up();
  // Whatever the gesture ended on must survive the release: the preview retires on commit, not on
  // pointerup, so the headline cannot rebound to the range that was left behind.
  expect(await headline.textContent()).toBe(dragged);
  await waitForFocusedReportSettled(page);

  // Exactly one commit, and it happened on release.
  expect(page.url()).not.toBe(urlBeforeDrag);
  expect(new URL(page.url()).searchParams.get('range')).not.toBeNull();
  await expect(hero.locator('[aria-busy="true"]')).toHaveCount(0);
});

test('reports legend shares and the range total over the selected window', async ({ page }) => {
  await openHydratedReport(page);

  const activity = activityFor(page);
  const legend = activity.locator('[data-report-range-part="total-legend"]');
  const readLegend = () =>
    legend.evaluate((element) => ({
      series: [...element.querySelectorAll('[data-series-key]')].map((node) =>
        (node.textContent ?? '').trim().replace(/\s+/g, ' '),
      ),
      total: element.querySelector('[data-report-range-total]')?.textContent?.trim() ?? null,
    }));

  const initial = await readLegend();
  // In value mode the total restated the hero verbatim, so only the shares remain here. The session
  // count is a different quantity the hero never states, so it keeps its slot — see below.
  expect(initial.total).toBeNull();
  // A series with nothing inside the window is noise, not information.
  expect(initial.series.filter((entry) => entry.endsWith('0.0%'))).toEqual([]);
  expect(initial.series.length).toBeGreaterThan(0);

  await reportPeriodFor(page).getByRole('button', { exact: true, name: 'Today' }).click();
  await waitForFocusedReportSettled(page);
  await expect(page.locator('[data-period-comparison-caveat]')).toHaveText(
    'This period is still in progress, so the comparison is provisional.',
  );

  const narrowed = await readLegend();
  expect(narrowed.total).toBeNull();
  expect(narrowed.series.length).toBeLessThanOrEqual(initial.series.length);
  const todayStack = activity.locator('[data-timeline-series-stack]');
  const todayBar = activity.locator('[data-report-range-part="chart"] [role="img"]');
  await expect(todayBar).toHaveCount(1);
  const [todayBarBox, todayStackBox] = await Promise.all([todayBar.boundingBox(), todayStack.boundingBox()]);
  expect(todayBarBox).not.toBeNull();
  expect(todayStackBox).not.toBeNull();
  expect(todayBarBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(65);
  const todayBarCenter = (todayBarBox?.x ?? 0) + (todayBarBox?.width ?? 0) / 2;
  const todayStackCenter = (todayStackBox?.x ?? 0) + (todayStackBox?.width ?? 0) / 2;
  expect(Math.abs(todayBarCenter - todayStackCenter)).toBeLessThanOrEqual(1);
  const peakBox = await activity.locator('[data-timeline-peak-value]').boundingBox();
  expect(peakBox).not.toBeNull();
  const intersectsPeak =
    (todayBarBox?.x ?? 0) < (peakBox?.x ?? 0) + (peakBox?.width ?? 0) &&
    (todayBarBox?.x ?? 0) + (todayBarBox?.width ?? 0) > (peakBox?.x ?? 0) &&
    (todayBarBox?.y ?? 0) < (peakBox?.y ?? 0) + (peakBox?.height ?? 0) &&
    (todayBarBox?.y ?? 0) + (todayBarBox?.height ?? 0) > (peakBox?.y ?? 0);
  expect(intersectsPeak).toBe(false);

  await openActivityExplorer(page);
  await activityMetricFor(page).getByRole('button', { exact: true, name: 'Sessions' }).click();
  await waitForFocusedReportSettled(page);
  expect((await readLegend()).total).toMatch(SESSION_COUNT_PATTERN);

  await activityMetricFor(page).getByRole('button', { exact: true, name: 'Share' }).click();
  await waitForFocusedReportSettled(page);
  // Share mode made this a constant 100%.
  expect((await readLegend()).total).toBeNull();
});

test('fills harness series with their branded tokens rather than one hashed hue', async ({ page }) => {
  await openHydratedReport(page);

  const fills = await activityFor(page).evaluate((element) => {
    const swatchFill = (key: string): string | null => {
      const node = element.querySelector(`[data-report-range-part="total-legend"] [data-series-key="${key}"] span`);
      return node ? getComputedStyle(node).backgroundColor : null;
    };
    const keys = [...element.querySelectorAll('[data-report-range-part="total-legend"] [data-series-key]')].map(
      (node) => node.getAttribute('data-series-key') ?? '',
    );
    return Object.fromEntries(keys.map((key) => [key, swatchFill(key)]));
  });

  const values = Object.values(fills).filter((fill): fill is string => typeof fill === 'string');
  expect(values.length).toBeGreaterThan(1);
  // A hash-derived palette produced neighbouring tans that read as one colour;
  // every harness must resolve to its own semantic token instead.
  expect(new Set(values).size).toBe(values.length);
  for (const [key, fill] of Object.entries(fills)) {
    expect(fill, key).not.toBeNull();
    expect(fill, key).not.toBe('rgba(0, 0, 0, 0)');
  }
});

test('assigns each ranked model series a distinct palette token and keeps the grouped tail inline', async ({
  page,
}) => {
  await page.addInitScript(
    ({ enabledKey, modelTailKey }) => {
      Reflect.set(globalThis, enabledKey, true);
      Reflect.set(globalThis, modelTailKey, true);
    },
    { enabledKey: FOCUSED_REPORT_E2E_ENABLED_KEY, modelTailKey: FOCUSED_REPORT_E2E_MODEL_TAIL_KEY },
  );
  await openHydratedReport(page);

  const activity = activityFor(page);
  const chartOptions = await openActivityExplorer(page);
  await chartOptions.getByRole('radio', { exact: true, name: 'Model' }).click();
  const entries = activity.locator('[data-report-range-part="total-legend"] [data-series-key]');
  await waitForFocusedReportSettled(page);
  await expect(entries).toHaveCount(12);
  const colors = await entries.evaluateAll((nodes) =>
    nodes.map((node) => {
      const swatch = node.querySelector('span');
      return swatch ? getComputedStyle(swatch).backgroundColor : '';
    }),
  );
  expect(colors.every((color) => color !== '' && color !== 'rgba(0, 0, 0, 0)')).toBe(true);
  expect(new Set(colors).size).toBe(colors.length);
  const aggregate = activity.locator('[data-timeline-legend-entry="aggregate"]');
  const [buttonBox, summaryBox] = await Promise.all([
    aggregate.getByRole('button', { name: 'Other' }).boundingBox(),
    aggregate.locator('details > summary').boundingBox(),
  ]);
  expect(buttonBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(Math.abs((summaryBox?.y ?? 0) - (buttonBox?.y ?? 0))).toBeLessThan(buttonBox?.height ?? 0);
  expect(summaryBox?.x ?? 0).toBeGreaterThanOrEqual((buttonBox?.x ?? 0) + (buttonBox?.width ?? 0) - 1);
});

test('announces each brush handle as a slider over the day it selects', async ({ page }) => {
  await openHydratedReport(page);

  const brush = (await openActivityExplorer(page)).locator('[data-report-range-part="brush"]');
  const handles = (await brush.evaluate(readBrushGeometry)).handles;

  expect(handles.map((handle) => handle.label)).toEqual(['Start date', 'End date']);
  for (const handle of handles) {
    expect(handle.role).toBe('slider');
    // A raw bucket index announces nothing useful, so the resolved day must be
    // exposed, and the pointer target must stay reachable on touch.
    expect(handle.valueText).toBe(handle.label === 'Start date' ? 'May 12, 2026' : 'Jun 11, 2026');
    expect(handle.width).toBeGreaterThanOrEqual(HANDLE_MINIMUM_TARGET_PX);
    expect(handle.height).toBeGreaterThanOrEqual(HANDLE_MINIMUM_TARGET_PX);
  }

  await brush.getByRole('slider', { name: 'Start date' }).press('ArrowRight');
  await expect(brush.getByRole('slider', { name: 'Start date' })).toHaveAttribute('aria-valuetext', 'May 13, 2026');
});
