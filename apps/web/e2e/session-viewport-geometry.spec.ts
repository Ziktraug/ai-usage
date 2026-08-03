import { expect, openHydratedReport, test } from './browser-test';

const SESSION_VIEWPORT_BOTTOM_INSET = 24;

const viewportCases = [
  {
    height: 900,
    maximumRowHeight: 96,
    minimumRowHeight: 43,
    mode: 'desktop',
    rowSelector: 'tr[data-index]',
    width: 1024,
  },
  {
    height: 844,
    maximumRowHeight: 188,
    minimumRowHeight: 188,
    mode: 'mobile',
    rowSelector: 'li[data-index]',
    width: 390,
  },
] as const;

test('anchors the virtual Session viewport inside the screen on desktop and mobile', async ({ page }) => {
  for (const viewportCase of viewportCases) {
    await page.setViewportSize({ height: viewportCase.height, width: viewportCase.width });
    await openHydratedReport(page, '/?tab=sessions');

    const surface = page.locator(`[data-session-surface="${viewportCase.mode}"]`);
    const regionStart = page.locator('[data-session-region-start]');
    await expect(surface).toBeVisible();
    await expect(regionStart).toBeVisible();

    await expect
      .poll(
        async () =>
          await surface.evaluate((element, bottomInset) => {
            const rect = element.getBoundingClientRect();
            const regionRect = document.querySelector('[data-session-region-start]')?.getBoundingClientRect();
            const expectedHeight = Math.max(1, window.innerHeight - Math.max(0, rect.top) - bottomInset);
            return {
              activeElementInsideRegion: Boolean(document.activeElement?.closest('[data-session-region-start]')),
              fillsAvailableHeight: Math.abs(element.clientHeight - expectedHeight) <= 2,
              maxHeight: getComputedStyle(element).maxHeight,
              minHeight: getComputedStyle(element).minHeight,
              regionStartsInViewport: Boolean(
                regionRect && regionRect.top >= -1 && regionRect.top < window.innerHeight * 0.2,
              ),
              surfaceStartsInViewport: rect.top >= 0 && rect.top < window.innerHeight * 0.25,
              windowScrolledPastChrome: window.scrollY > 0,
            };
          }, SESSION_VIEWPORT_BOTTOM_INSET),
      )
      .toEqual({
        activeElementInsideRegion: false,
        fillsAvailableHeight: true,
        maxHeight: 'none',
        minHeight: '0px',
        regionStartsInViewport: true,
        surfaceStartsInViewport: true,
        windowScrolledPastChrome: true,
      });

    const rowHeight = await surface
      .locator(viewportCase.rowSelector)
      .first()
      .evaluate((row) => Math.round(row.getBoundingClientRect().height));
    expect(rowHeight).toBeGreaterThanOrEqual(viewportCase.minimumRowHeight);
    expect(rowHeight).toBeLessThanOrEqual(viewportCase.maximumRowHeight);

    await page.setViewportSize({
      height: viewportCase.mode === 'desktop' ? 220 : 300,
      width: viewportCase.width,
    });
    await expect
      .poll(async () => await surface.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const outerScrollPosition = await page.evaluate(() => window.scrollY);
    expect(outerScrollPosition).toBeGreaterThan(0);
    await surface.evaluate((element) => {
      element.scrollTop = Math.min(40, element.scrollHeight - element.clientHeight);
    });
    await expect.poll(async () => await surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(outerScrollPosition);
  }
});
