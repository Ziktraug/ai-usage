import { expect, openHydratedReport, reportViewsFor, test, waitForFocusedReportSettled } from './browser-test';

const OPEN_BUILD_REPORT_UI_PATTERN = /^Open details for Build report UI\./;

test('uses one token magnitude and accessible drawer explanations', async ({ page }) => {
  await openHydratedReport(page, '/?origin=%5B%5D');
  const topSessionTrigger = page.getByRole('button', { name: OPEN_BUILD_REPORT_UI_PATTERN });
  await topSessionTrigger.click();

  const drawer = page.getByRole('dialog', { name: 'Session details' });
  const totalTokens = drawer.locator('[data-detail-item="Total tokens"]');
  await expect(totalTokens).toContainText('204k');
  await expect(totalTokens).not.toContainText('203,500');

  const subValueHelp = drawer.getByRole('button', {
    name: 'About Sub value',
  });
  await expect(subValueHelp).toHaveAttribute('aria-haspopup', 'dialog');
  await subValueHelp.click();
  await expect(page.getByText('Cursor export value covered by the subscription quota')).toBeVisible();
  await subValueHelp.click();

  const taskOpenHelp = drawer.getByRole('button', {
    name: 'About Task-open time',
  });
  await expect(taskOpenHelp).toHaveAttribute('aria-haspopup', 'dialog');
  await taskOpenHelp.focus();
  await taskOpenHelp.press('Enter');
  const taskOpenExplanation = page.getByText(
    'Sum of recorded Codex task-open spans. This includes time waiting for tools and subagents; it is not model runtime.',
  );
  await expect(taskOpenExplanation).toBeVisible();

  await drawer.getByRole('button', { name: 'Close session details' }).click();
  await expect(drawer).not.toBeVisible();
  await expect(taskOpenExplanation).not.toBeVisible();
  await expect(topSessionTrigger).toBeFocused();
  await page
    .getByRole('region', { name: 'Report period' })
    .getByRole('button', { exact: true, name: 'All time' })
    .click();
  await waitForFocusedReportSettled(page);
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
  await waitForFocusedReportSettled(page);
  await page.locator('tbody tr').filter({ hasText: 'Explore report sketch' }).locator('td').first().click();

  const partialHelp = drawer.getByRole('button', { name: 'About Partial' });
  await expect(partialHelp).toHaveAttribute('aria-haspopup', 'dialog');
  await partialHelp.click();
  await expect(
    page.getByText('This row may be missing part of the session data for counters and aggregate metrics.'),
  ).toBeVisible();
});
