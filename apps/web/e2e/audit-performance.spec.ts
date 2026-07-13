import { expect, type Locator, type Page, test } from '@playwright/test';

interface SessionDomMeasurement {
  mobileSummaryNodes: number;
  sessionSurfaceNodes: number;
  tableNodes: number;
  viewportWidth: number;
}

const countDomNodes = async (locator: Locator): Promise<number> =>
  await locator.evaluate((element) => element.querySelectorAll('*').length + 1);

const countSessionSurfaceNodes = async (locator: Locator): Promise<number> =>
  await locator.evaluate((element) => {
    const surface = element.parentElement;
    return surface ? surface.querySelectorAll('*').length + 1 : 0;
  });

const measureSessionsAt = async (page: Page, viewportWidth: number): Promise<SessionDomMeasurement> => {
  await page.setViewportSize({ height: 900, width: viewportWidth });
  await page.goto('/?tab=sessions');
  await expect(page.getByText('4 / 4 sessions', { exact: true })).toBeVisible();

  const table = page.locator('table');
  const mobileSummaries = page.locator('ul[aria-label="Session summaries"]');
  await expect(table).toHaveCount(1);
  await expect(mobileSummaries).toHaveCount(1);

  if (viewportWidth === 361) {
    await expect(mobileSummaries).toBeVisible();
    await expect(table).not.toBeVisible();
  } else {
    await expect(table).toBeVisible();
    await expect(mobileSummaries).not.toBeVisible();
  }

  return {
    mobileSummaryNodes: await countDomNodes(mobileSummaries),
    sessionSurfaceNodes: await countSessionSurfaceNodes(mobileSummaries),
    tableNodes: await countDomNodes(table),
    viewportWidth,
  };
};

test('records deterministic duplicate DOM baselines for the audit', async ({ page }) => {
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
  expect(advancedAnalysisNodes).toBeGreaterThan(3);
  await expect(advancedAnalysis.getByText('Punchcard data', { exact: true })).toHaveCount(1);

  expect(mobile.tableNodes).toBeGreaterThan(1);
  expect(mobile.mobileSummaryNodes).toBeGreaterThan(1);
  expect(desktop.tableNodes).toBeGreaterThan(1);
  expect(desktop.mobileSummaryNodes).toBeGreaterThan(1);

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
