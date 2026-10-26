import AxeBuilder from '@axe-core/playwright';
import type { Locator } from '@playwright/test';
import { expect, test, waitForHydratedReport } from './browser-test';

test.use({ colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } });

/** Measure the painted labels as well as the targets: a fixed rail can overflow internally without page overflow. */
const expectNavigationGeometry = async (targets: Locator, visibleLabels: boolean): Promise<void> => {
  expect(await targets.count()).toBeGreaterThan(0);
  const failures = await targets.evaluateAll((elements, checkText) => {
    const issues: string[] = [];
    const tolerance = 0.5;
    const intersects = (a: DOMRect, b: DOMRect): boolean =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance;
    const controls = elements.map((element) => {
      const label = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? 'Unnamed target';
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width < 44 || box.height < 44) {
        issues.push(`${label}: target is ${box.width}×${box.height}, smaller than 44×44`);
      }
      if (
        box.left < -tolerance ||
        box.right > document.documentElement.clientWidth + tolerance ||
        box.top < -tolerance ||
        box.bottom > window.innerHeight + tolerance
      ) {
        issues.push(`${label}: target extends outside the viewport`);
      }
      const textRects: DOMRect[] = [];
      if (!checkText) {
        return { box, label, textRects };
      }
      const content = {
        left: box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
        right: box.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight),
        top: box.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop),
        bottom: box.bottom - Number.parseFloat(style.borderBottomWidth) - Number.parseFloat(style.paddingBottom),
      };
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || node.parentElement?.closest('[aria-hidden="true"], svg')) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (!(rect.width && rect.height)) {
            continue;
          }
          textRects.push(rect);
          if (
            rect.left < content.left - tolerance ||
            rect.right > content.right + tolerance ||
            rect.top < content.top - tolerance ||
            rect.bottom > content.bottom + tolerance
          ) {
            issues.push(`${label}: text extends outside its target's padded content box`);
          }
          const container = node.parentElement?.getBoundingClientRect();
          if (
            container &&
            (rect.left < container.left - tolerance ||
              rect.right > container.right + tolerance ||
              rect.top < container.top - tolerance ||
              rect.bottom > container.bottom + tolerance)
          ) {
            issues.push(`${label}: text extends outside its label container`);
          }
        }
      }
      if (!textRects.length) {
        issues.push(`${label}: no rendered label text`);
      }
      return { box, label, textRects };
    });
    for (const [index, current] of controls.entries()) {
      for (const other of controls.slice(index + 1)) {
        if (intersects(current.box, other.box)) {
          issues.push(`${current.label} / ${other.label}: targets overlap`);
        }
        if (current.textRects.some((rect) => other.textRects.some((otherRect) => intersects(rect, otherRect)))) {
          issues.push(`${current.label} / ${other.label}: labels overlap`);
        }
      }
    }
    return issues;
  }, visibleLabels);
  expect(failures).toEqual([]);
};

const expectReadableRailTooltip = async (link: Locator): Promise<void> => {
  const label = (await link.textContent())?.trim();
  expect(label).toBeTruthy();
  const tooltip = link.locator('[data-rail-tooltip]');
  await expect(tooltip).toBeVisible();
  await expect(link).toHaveAccessibleName(label ?? '');
  const rendered = await tooltip.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      // Generated tooltip content has no DOM text node for Range; inspect the painted pseudo-element instead.
      content: getComputedStyle(element, '::before').content,
      unclipped: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
      inViewport:
        box.left >= 0 &&
        box.right <= document.documentElement.clientWidth &&
        box.top >= 0 &&
        box.bottom <= window.innerHeight,
    };
  });
  expect(rendered).toEqual({ content: JSON.stringify(label), unclipped: true, inViewport: true });
};

for (const width of [320, 375, 390]) {
  test(`mobile navigation keeps labels separate and unclipped with 44px targets at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/work');
    const navigation = page.locator('[data-app-navigation="mobile"][data-hydrated="true"]');
    await expect(navigation).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectNavigationGeometry(navigation.locator('a, button'), true);
    await expect(navigation.getByRole('link')).toHaveText(['Work', 'Overview', 'Sessions', 'Analysis']);
    await expect(navigation.getByRole('button', { name: 'Manage', exact: true })).toBeVisible();
    const work = navigation.getByRole('link', { name: 'Work', exact: true });
    await expect(work).toHaveAttribute('aria-current', 'page');
    await navigation.getByRole('link', { name: 'Overview', exact: true }).click();
    await waitForHydratedReport(page);
    await work.click();
    await expect(page.getByRole('heading', { level: 1, name: 'One thread per task.', exact: true })).toBeVisible();
    await expectNavigationGeometry(navigation.locator('a, button'), true);
  });
}

for (const width of [768, 1024, 1279]) {
  test(`icon rail keeps Work reachable, 44px targets and readable keyboard and hover labels at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const rail = page.locator('[data-app-navigation="desktop"][data-hydrated="true"]');
    await expect(rail).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(rail.getByRole('button', { name: 'Switch to dark theme', exact: true })).toBeVisible();
    await expectNavigationGeometry(rail.locator('a, button'), false);
    for (const link of await rail.getByRole('link').all()) {
      await link.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(link).toBeFocused();
      await expectReadableRailTooltip(link);
    }
    const work = rail.getByRole('link', { name: 'Work', exact: true });
    await work.hover();
    await expectReadableRailTooltip(work);
    await work.click();
    await expect(page.getByRole('heading', { level: 1, name: 'One thread per task.', exact: true })).toBeVisible();
    await expect(work).toHaveAttribute('aria-current', 'page');
  });
}

test('mobile Manage opens Campaigns, reports its active destination and preserves report filters', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?range=all&q=Build%20report%20UI');
  await waitForHydratedReport(page);
  const navigation = page.locator('[data-app-navigation="mobile"][data-hydrated="true"]');
  await expect(navigation).toBeVisible();
  const manage = navigation.getByRole('button', { name: 'Manage', exact: true });
  await expect(manage).not.toHaveAttribute('aria-current', 'page');
  await manage.focus();
  await page.keyboard.press('Enter');
  const destinations = page.getByRole('navigation', { name: 'Manage destinations', exact: true });
  await expect(destinations).toBeVisible();
  const campaigns = destinations.getByRole('link', { name: 'Campaigns', exact: true });
  await expect(campaigns).toHaveAttribute('href', `/campaigns${new URL(page.url()).search}`);
  await page.evaluate(() => document.fonts.ready);
  await expectNavigationGeometry(destinations.getByRole('link'), true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await campaigns.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('q')).toBe('Build report UI');
  expect(new URL(page.url()).searchParams.get('range')).toBe('all');
  await expect(manage).toHaveAttribute('aria-current', 'page');
  await expect(manage).toHaveAttribute('aria-expanded', 'false');
  await expect(destinations).toHaveCount(0);
  await manage.click();
  await expect(campaigns).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(manage).toBeFocused();
  await expect(destinations).toHaveCount(0);
  await navigation.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(navigation.getByRole('link', { name: 'Sessions', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(manage).not.toHaveAttribute('aria-current', 'page');
  expect(new URL(page.url()).searchParams.get('q')).toBe('Build report UI');
  expect(new URL(page.url()).searchParams.get('range')).toBe('all');
});
