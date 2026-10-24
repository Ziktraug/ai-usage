import { expect, openHydratedReport, test } from './browser-test';

// Panda 1 emitted its breakpoints as `@media screen and (min-width: …)`, so a printed report always
// used the base layout. A Letter or A4 page box is about 720px wide in portrait and 960px or more in
// landscape, which a bare `(width >= …)` query matches: `sm:` styles would print in portrait, `md:`
// and `lg:` styles in landscape. The Models view shows it plainly: its desktop table replaces the
// card list at `md`.
const PRINT_WIDTHS = [720, 1024] as const;
const MODEL_TABLE_MIN_WIDTH_PX = 768;
const WIDTH_FEATURE = /\bwidth\b/;

for (const width of PRINT_WIDTHS) {
  test(`prints the report in its base layout on a ${width}px page`, async ({ page }) => {
    await page.setViewportSize({ height: 1000, width });
    await openHydratedReport(page, '/?tab=models');
    const panel = page.locator('[data-breakdown-panel="models"]');
    const table = panel.locator('[data-model-analysis-table]');
    const cards = panel.locator('[data-model-analysis-cards]');
    await expect(width >= MODEL_TABLE_MIN_WIDTH_PX ? table : cards).toBeVisible();

    await page.emulateMedia({ media: 'print' });
    const printedWidthQueries = await page.evaluate((widthFeatureSource) => {
      const widthFeature = new RegExp(widthFeatureSource);
      const matched = new Set<string>();
      const pending = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
      while (pending.length > 0) {
        const rule = pending.pop();
        if (
          rule instanceof CSSMediaRule &&
          widthFeature.test(rule.conditionText) &&
          window.matchMedia(rule.conditionText).matches
        ) {
          matched.add(rule.conditionText);
        }
        if (rule instanceof CSSGroupingRule) {
          pending.push(...Array.from(rule.cssRules));
        }
      }
      return [...matched].sort();
    }, WIDTH_FEATURE.source);

    expect(printedWidthQueries).toEqual([]);
    await expect(table).toBeHidden();
    await expect(cards).toBeVisible();
  });
}
