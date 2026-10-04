import { expect, openHydratedReport, test } from './browser-test';

for (const viewport of [
  { height: 900, width: 1280, mode: 'desktop' },
  { height: 844, width: 390, mode: 'mobile' },
]) {
  test(`preserves the visible Session identity and focus after inserted rows on ${viewport.mode}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openHydratedReport(page, '/');
    await page.addScriptTag({ type: 'module', url: '/src/lib/features/sessions/table/session-anchor.e2e-fixture.ts' });
    const surface = page.locator(`[data-session-surface="${viewport.mode}"]`);
    await expect(surface).toBeVisible();
    await surface.hover();
    await page.mouse.wheel(0, viewport.mode === 'desktop' ? 6500 : 28_200);
    await expect.poll(() => surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(6000);
    const before = await surface.evaluate((element) => {
      const top = Math.max(
        element.getBoundingClientRect().top,
        element.querySelector('thead')?.getBoundingClientRect().bottom ?? 0,
      );
      const row = [...element.querySelectorAll<HTMLElement>('[data-session-row-id]')].find(
        (item) =>
          item.getBoundingClientRect().top >= top &&
          item.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom,
      );
      if (!row) {
        throw new Error('No visible anchor row');
      }
      const control = row.matches('[data-session-index]')
        ? row
        : row.querySelector<HTMLElement>('[data-session-index]');
      control?.focus({ preventScroll: true });
      return { id: row.dataset.sessionRowId, top: row.getBoundingClientRect().top };
    });
    if (!before.id) {
      throw new Error('Missing stable Session identity');
    }
    await page.keyboard.press('Alt+Shift+R');
    await expect(
      surface.locator(viewport.mode === 'desktop' ? 'table' : 'li[data-session-row-id]').first(),
    ).toHaveAttribute(viewport.mode === 'desktop' ? 'aria-rowcount' : 'aria-setsize', '360');
    const anchor = surface.locator(`[data-session-row-id="${before.id}"]`);
    await expect(anchor).toBeVisible();
    await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before.top)).toBeLessThan(2);
    const control = viewport.mode === 'desktop' ? anchor : anchor.locator('[data-session-index]');
    await expect(control).toBeFocused();
    const mountedRows = await surface.locator('[data-session-row-id]').count();
    expect(mountedRows).toBeLessThan(60);
    await test.info().attach('session-anchor-evidence', {
      body: JSON.stringify({
        mode: viewport.mode,
        mountedRows,
        storedRows: 360,
        anchorDelta: (await anchor.boundingBox())!.y - before.top,
      }),
      contentType: 'application/json',
    });
  });
}
