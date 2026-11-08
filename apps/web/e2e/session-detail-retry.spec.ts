import { expect, openHydratedReport, test } from './browser-test';

test('failed drawer chunk retries retain keyboard focus and announce each failure', async ({
  page,
  browserFailureGate,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openHydratedReport(page);
  const allowances = new Map<string, () => void>();
  await page.route('**/src/lib/features/sessions/detail/session-detail-members-query-slot.svelte*', async (route) => {
    const url = route.request().url();
    if (!allowances.has(url)) {
      allowances.set(url, browserFailureGate.allowScriptResponses({ url, status: 503, maximum: 3 }));
    }
    await route.fulfill({ status: 503, contentType: 'text/javascript', body: '' });
  });
  try {
    await page.addScriptTag({ type: 'module', url: '/src/lib/features/sessions/detail/session-detail.e2e-fixture.ts' });
    const retry = page.getByRole('button', { name: 'Retry session details', exact: true });
    await expect(retry).toBeVisible();
    const original = await retry.elementHandle();
    await retry.focus();
    for (const attempt of [1, 2]) {
      await page.keyboard.press('Enter');
      await expect(retry).toBeFocused();
      expect(await original?.evaluate((element) => element.isConnected)).toBe(true);
      await expect(page.getByRole('status')).toHaveText(`Session details retry ${attempt} failed. Try again.`);
      await expect(retry).toBeFocused();
      expect(await original?.evaluate((element) => element.isConnected)).toBe(true);
      await expect(retry).toHaveAttribute('aria-disabled', 'false');
    }
  } finally {
    for (const verify of allowances.values()) {
      verify();
    }
  }
});
