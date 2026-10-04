import { expect, openHydratedReport, test } from './browser-test';

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 3840, height: 2160 },
]) {
  test(`fills an initially short ${viewport.height}px viewport through asynchronous pages with bounded acquisition`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    let concurrent = 0;
    let maximumConcurrent = 0;
    const cursors: number[] = [];
    await page.route('**/__campaign-short-page-fixture?*', async (route) => {
      const cursor = Number(new URL(route.request().url()).searchParams.get('cursor'));
      cursors.push(cursor);
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      // A real pending fetch separates each measured page from the next acquisition.
      await new Promise((resolve) => setTimeout(resolve, 40));
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          nextCursor: cursor < 500 ? cursor + 1 : null,
          rows: [{ key: `row-${cursor}`, label: `Short page session ${cursor}` }],
        }),
      });
      concurrent -= 1;
    });
    await openHydratedReport(page, '/');
    await page.addScriptTag({ type: 'module', url: '/src/lib/features/campaigns/campaign-short-page.e2e-fixture.ts' });
    const surface = page.getByRole('region', { name: 'Short page sessions', exact: true });
    await expect(surface).toBeVisible();
    try {
      // No wheel, key, resize or fetch invocation from the test: the initial viewport must fill itself.
      await expect
        .poll(() => surface.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(0);
      // Quiescence proves that a still-near boundary does not download the remaining corpus.
      await page.waitForTimeout(300);
      const viewportHeight = await surface.evaluate((element) => element.clientHeight);
      expect(cursors.length).toBeGreaterThan(2);
      expect(cursors.length).toBeLessThanOrEqual(Math.ceil(viewportHeight / 80) + 2);
      expect(maximumConcurrent).toBe(1);
      expect(cursors).toEqual(Array.from({ length: cursors.length }, (_, index) => index + 1));
      expect(await page.locator('[data-short-page-row]').count()).toBeLessThanOrEqual(
        Math.ceil(viewportHeight / 80) + 9,
      );
    } finally {
      const geometry = await surface.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      }));
      await testInfo.attach('short-page-acquisition', {
        body: JSON.stringify({ ...geometry, cursors, maximumConcurrent }, null, 2),
        contentType: 'application/json',
      });
    }
  });
}
