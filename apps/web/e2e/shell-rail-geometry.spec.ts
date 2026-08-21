import { expect, openHydratedReport, test } from './browser-test';

/**
 * The shell rail changes shape twice — hidden below `md`, a 56px icon column between `md` and `xl`,
 * a 216px labelled column at `xl`. Only 390, 1080, 1280 and 1440 were ever exercised, so the two
 * edges of the icon band and the first `lg` width had no scenario contradicting a wrong threshold.
 *
 * Geometry rather than a screenshot on purpose: the numbers here are the layout contract
 * (`app-navigation.svelte` rail width and the `app-shell.svelte` offset that mirrors it), and a
 * pixel diff would fail on unrelated content churn while saying nothing about the rail.
 */
const RAIL_ICON_WIDTH_PX = 56;
const RAIL_LABELLED_WIDTH_PX = 216;
const VIEWPORT_HEIGHT_PX = 900;

const RAIL_SCENARIOS = [
  { expectedWidth: null, width: 390 },
  { expectedWidth: null, width: 767 },
  { expectedWidth: RAIL_ICON_WIDTH_PX, width: 768 },
  { expectedWidth: RAIL_ICON_WIDTH_PX, width: 900 },
  { expectedWidth: RAIL_ICON_WIDTH_PX, width: 1024 },
  { expectedWidth: RAIL_ICON_WIDTH_PX, width: 1279 },
  { expectedWidth: RAIL_LABELLED_WIDTH_PX, width: 1280 },
  { expectedWidth: RAIL_LABELLED_WIDTH_PX, width: 1440 },
] as const;

for (const scenario of RAIL_SCENARIOS) {
  test(`reserves the shell rail column without overflow at ${scenario.width}px`, async ({ page }) => {
    await page.setViewportSize({ height: VIEWPORT_HEIGHT_PX, width: scenario.width });
    await openHydratedReport(page);

    const desktopRail = page.locator('[data-app-navigation="desktop"]');
    const content = page.locator('[data-app-shell-content]');

    if (scenario.expectedWidth === null) {
      await expect(desktopRail).toBeHidden();
      // The rail is out, so the content must not keep paying for a column that is not there.
      expect(await content.evaluate((node) => Number.parseFloat(getComputedStyle(node).marginLeft))).toBe(0);
    } else {
      await expect(desktopRail).toBeVisible();
      const railBox = await desktopRail.boundingBox();
      expect(railBox?.width).toBe(scenario.expectedWidth);
      // The offset mirrors the fixed rail. If the two ever disagree the rail overlaps the report or
      // leaves a dead gutter, and neither shows up in a rail-only assertion.
      expect(await content.evaluate((node) => Number.parseFloat(getComputedStyle(node).marginLeft))).toBe(
        scenario.expectedWidth,
      );
    }

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);
  });
}
