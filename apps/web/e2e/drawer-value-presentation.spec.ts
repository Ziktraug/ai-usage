import { expect, openHydratedReport, reportViewsFor, test, waitForFocusedReportSettled } from './browser-test';

const OPEN_BUILD_REPORT_UI_PATTERN = /^Open details for Build report UI\./;

test('uses one token magnitude and accessible drawer explanations', async ({ page }) => {
  await openHydratedReport(page, '/?origin=%5B%5D');
  const topSessionTrigger = page.getByRole('button', { name: OPEN_BUILD_REPORT_UI_PATTERN });
  await topSessionTrigger.click();

  const drawer = page.getByRole('dialog', { name: 'Session details' });
  // The Overview row is the campaign aggregate (203,500 + 76,600 + 120,800 tokens),
  // and the drawer states which scope its values cover.
  await expect(drawer.locator('[data-session-drawer-scope="campaign"]')).toHaveCount(1);
  const totalTokens = drawer.locator('[data-detail-item="Total tokens"]');
  await expect(totalTokens).toContainText('401k');
  await expect(totalTokens).not.toContainText('400,900');

  const subValueHelp = drawer.getByRole('button', {
    name: 'About Subscription value',
  });
  await expect(subValueHelp).toHaveAttribute('aria-haspopup', 'dialog');
  const hintGeometry = await subValueHelp.evaluate((button) => {
    const glyph = button.querySelector('[data-detail-hint-glyph]');
    const row = button.parentElement;
    if (!(glyph instanceof HTMLElement && row instanceof HTMLElement)) {
      throw new Error('Expected the hint glyph inside its label row');
    }
    const style = getComputedStyle(button);
    return {
      background: style.backgroundColor,
      borderWidth: style.borderTopWidth,
      glyphWidth: Math.round(glyph.getBoundingClientRect().width),
      hitHeight: Math.round(button.getBoundingClientRect().height),
      hitWidth: Math.round(button.getBoundingClientRect().width),
      rowHeight: Math.round(row.getBoundingClientRect().height),
    };
  });
  expect(hintGeometry.hitWidth).toBeGreaterThanOrEqual(44);
  expect(hintGeometry.hitHeight).toBeGreaterThanOrEqual(44);
  expect(hintGeometry.borderWidth).toBe('0px');
  expect(hintGeometry.background).toBe('rgba(0, 0, 0, 0)');
  expect(hintGeometry.glyphWidth).toBeLessThanOrEqual(16);
  expect(hintGeometry.rowHeight).toBeLessThanOrEqual(24);
  await subValueHelp.click();
  await expect(page.getByText('Cursor export value covered by the subscription quota')).toBeVisible();
  await subValueHelp.click();

  const taskOpenHelp = drawer.getByRole('button', {
    name: 'About Root task-open time',
  });
  await expect(taskOpenHelp).toHaveAttribute('aria-haspopup', 'dialog');
  await taskOpenHelp.focus();
  await taskOpenHelp.press('Enter');
  const taskOpenExplanation = page.getByText(
    'Sum of recorded Codex task-open spans. This includes time waiting for tools and subagents; it is not model runtime.',
  );
  await expect(taskOpenExplanation).toBeVisible();

  await drawer.getByRole('button', { name: 'Close session details' }).evaluate(async (button) => {
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected the Drawer close control to be a button');
    }
    const detailSlot = document.querySelector<HTMLElement>('[data-session-detail-slot]');
    const selectedRowBeforeClose = detailSlot?.dataset.selectedRowId;
    const competingSession = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes('Review analytics model'),
    );
    if (!(detailSlot && selectedRowBeforeClose && competingSession)) {
      throw new Error('Expected a selected session and a competing Overview session action');
    }
    button.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'j' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
    competingSession.click();
    await Promise.resolve();
    if (detailSlot.dataset.selectedRowId !== selectedRowBeforeClose) {
      throw new Error('Session selection changed while the Drawer was closing');
    }
    button.click();
  });
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
  const partialSessionRow = page.locator('tbody tr').filter({ hasText: 'Explore report sketch' });
  await partialSessionRow.locator('td').first().click();

  const partialHelp = drawer.getByRole('button', { name: 'About Partial' });
  await expect(partialHelp).toHaveAttribute('aria-haspopup', 'dialog');
  await partialHelp.click();
  const partialExplanation = page.getByText(
    'This row may be missing part of the session data for counters and aggregate metrics.',
  );
  await expect(partialExplanation).toBeVisible();

  await drawer.getByRole('button', { name: 'Previous session (k)' }).click();
  await expect(partialHelp).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Close session details' }).evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected the Drawer close control to be a button');
    }
    button.click();
    button.click();
  });
  await expect(drawer).not.toBeVisible();
  await expect(partialExplanation).not.toBeVisible();
  await expect(partialSessionRow).toBeFocused();
});
