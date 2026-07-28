import { expect, reportViewsFor, test } from './browser-test';

const TOP_SESSION_PATTERN = /Top session/;

test('uses one token magnitude and accessible drawer explanations', async ({ page }) => {
  await page.goto('/?origin=%5B%5D');
  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();

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
  await expect(
    page.getByText(
      'Sum of recorded Codex task-open spans. This includes time waiting for tools and subagents; it is not model runtime.',
    ),
  ).toBeVisible();

  await drawer.getByRole('button', { name: 'Close session details' }).click();
  await page.getByRole('region', { name: 'Date range' }).getByRole('button', { exact: true, name: 'All' }).click();
  await reportViewsFor(page).getByRole('link', { exact: true, name: 'Sessions' }).click();
  await page.locator('tbody tr').filter({ hasText: 'Explore report sketch' }).locator('td').first().click();

  const partialHelp = drawer.getByRole('button', { name: 'About Partial' });
  await expect(partialHelp).toHaveAttribute('aria-haspopup', 'dialog');
  await partialHelp.click();
  await expect(
    page.getByText('This row may be missing part of the session data for counters and aggregate metrics.'),
  ).toBeVisible();
});
