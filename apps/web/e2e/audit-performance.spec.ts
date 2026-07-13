import { expect, type Locator, type Page, test } from '@playwright/test';

interface SessionDomMeasurement {
  mobileSummaryNodes: number;
  sessionSurfaceNodes: number;
  tableNodes: number;
  viewportWidth: number;
}

const countDomNodes = async (locator: Locator): Promise<number> =>
  await locator.evaluate((element) => element.querySelectorAll('*').length + 1);

const measureSessionsAt = async (page: Page, viewportWidth: number): Promise<SessionDomMeasurement> => {
  await page.setViewportSize({ height: 900, width: viewportWidth });
  await page.goto('/?tab=sessions');
  await expect(page.getByText('4 / 4 sessions', { exact: true })).toBeVisible();

  const table = page.locator('table');
  const mobileSummaries = page.locator('ul[aria-label="Session summaries"]');
  const surface = page.locator('[data-session-surface]').filter({ hasNot: page.locator('[data-session-surface]') });

  if (viewportWidth === 361) {
    await expect(table).toHaveCount(0);
    await expect(mobileSummaries).toHaveCount(1);
    await expect(mobileSummaries).toBeVisible();
  } else {
    await expect(table).toHaveCount(1);
    await expect(mobileSummaries).toHaveCount(0);
    await expect(table).toBeVisible();
  }
  await expect(surface).toHaveCount(1);

  return {
    mobileSummaryNodes: viewportWidth === 361 ? await countDomNodes(mobileSummaries) : 0,
    sessionSurfaceNodes: await countDomNodes(surface),
    tableNodes: viewportWidth === 361 ? 0 : await countDomNodes(table),
    viewportWidth,
  };
};

test('records deterministic bounded DOM measurements for the audit', async ({ page }) => {
  const mobile = await measureSessionsAt(page, 361);
  const desktop = await measureSessionsAt(page, 1024);

  await page.goto('/');
  await expect(page.getByText('4 / 4 sessions', { exact: true })).toBeVisible();
  const advancedAnalysis = page.locator('details').filter({
    has: page.getByText('Advanced analysis', { exact: true }),
  });
  await expect(advancedAnalysis).toHaveCount(1);
  await expect(advancedAnalysis).not.toHaveAttribute('open', '');
  const advancedAnalysisNodes = await countDomNodes(advancedAnalysis);
  expect(advancedAnalysisNodes).toBeLessThan(10);
  await expect(advancedAnalysis.getByText('Punchcard data', { exact: true })).toHaveCount(0);

  expect(mobile.tableNodes).toBe(0);
  expect(mobile.mobileSummaryNodes).toBeGreaterThan(1);
  expect(desktop.tableNodes).toBeGreaterThan(1);
  expect(desktop.mobileSummaryNodes).toBe(0);

  process.stdout.write(
    `${JSON.stringify({
      auditPerformanceDom: {
        advancedAnalysisClosed: { nodes: advancedAnalysisNodes },
        fixture: { sessions: 4, source: 'VITE_AI_USAGE_E2E demo report' },
        sessions: { desktop, mobile },
      },
    })}\n`,
  );
});
