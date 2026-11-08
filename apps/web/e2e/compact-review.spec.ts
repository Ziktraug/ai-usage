import {
  collectionSourceDefinitions,
  type SourceControlEntryView,
  type SourceControlView,
} from '@ai-usage/report-core/source-control';
import { expect, test } from './browser-test';

test('compact workspace geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const path of ['/', '/?tab=sessions', '/skills', '/sources']) {
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    if (path === '/sources') {
      await expect(page.locator('[data-route-shell="sources"]')).toHaveAttribute('data-hydrated', 'true');
      await expect(page.locator('[data-publication-status]')).toBeVisible();
    }
    const header = page.locator('[data-workspace-header]');
    await expect(header).toBeVisible();
    await expect(header.locator('svg')).toHaveAttribute('viewBox', '0 -140 720 560');
    await expect(header.locator('svg')).toHaveAttribute('preserveAspectRatio', 'none');
    const height = await header.evaluate((el) => el.getBoundingClientRect().height);
    const expected = path === '/skills' ? { min: 105, max: 109 } : { min: 129, max: 133 };
    expect(height).toBeGreaterThanOrEqual(expected.min);
    expect(height).toBeLessThanOrEqual(expected.max);
  }
});

test('Work mobile utility links and filters stay usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/work');
  await expect(page.locator('#work-task-search')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const link of await page.locator('.wt-page-meta a').all()) {
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(
      await link.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      }),
    ).toBe(1);
  }
  expect((await page.locator('#work-task-search').boundingBox())?.width).toBeGreaterThanOrEqual(300);
  const checkbox = page.locator('.wt-switch input');
  await checkbox.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#work-task-project')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#work-task-search')).toBeFocused();
  const gap = await checkbox.evaluate((input) => {
    const label = input.parentElement;
    if (!label?.lastChild) {
      throw new Error('Checkbox label is missing');
    }
    const text = document.createRange();
    text.selectNode(label.lastChild);
    return text.getBoundingClientRect().left - input.getBoundingClientRect().right;
  });
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(10);
});

test('two warning source rows fit below compact healthy publishing at 1440×900', async ({ page }) => {
  const snapshot: SourceControlView = {
    generatedAt: '2026-06-11T12:00:00.000Z',
    generation: 1,
    instanceId: 'compact-review',
    publication: {
      acknowledgedRequestGeneration: 1,
      requestedGeneration: 1,
      dirty: false,
      dirtyGeneration: 1,
      lastOutcome: 'success',
      pendingDemand: false,
      publishedGeneration: 1,
      queued: false,
      rtkCompletedGeneration: 1,
      rtkRequiredGeneration: 1,
      running: false,
    },
    queueDepth: 0,
    runningCount: 0,
    sources: collectionSourceDefinitions.map(
      (definition): SourceControlEntryView => ({
        availability: 'detected',
        cadenceMs: definition.cadenceMs,
        id: definition.id,
        label: definition.label,
        lastOutcome: definition.id === 'claude.sessions' || definition.id === 'codex.sessions' ? 'warning' : 'success',
        lifecycle: 'scheduled',
        policy: 'enabled',
        reason: { code: 'none' },
        warnings:
          definition.id === 'claude.sessions' || definition.id === 'codex.sessions'
            ? [
                { code: 'recordRejected', message: `${definition.label} rejected local records.` },
                {
                  code: 'incompleteRecord',
                  message: `${definition.label} completed with an incomplete or rejected local record.`,
                },
                {
                  code: 'incompleteRecord',
                  message: `${definition.label} completed with an incomplete or rejected local record.`,
                },
              ]
            : [],
      }),
    ),
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/source-control', (route) =>
    route.fulfill({
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      contentType: 'text/event-stream',
    }),
  );
  await page.goto('/sources');
  const rows = page.locator('[data-source-card]');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('[data-publication-treatment="compact"]')).toBeVisible();
  for (const row of await rows.all()) {
    await expect(row).toContainText('(×2)');
    const box = await row.boundingBox();
    if (!box) {
      throw new Error('Source row has no rendered bounds');
    }
    expect(box.y + box.height).toBeLessThanOrEqual(900);
  }
});

test('compact atmosphere keeps the whole crest at desktop and mobile widths', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, name] of [
      ['/?tab=sessions', 'sessions'],
      ['/campaigns', 'campaigns'],
    ] as const) {
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      const fits = await page.locator('[data-workspace-atmosphere] svg').evaluate((svg) => {
        const bounds = svg.getBoundingClientRect();
        return Array.from(svg.querySelectorAll('path')).every((contour) => {
          const curve = contour.getBoundingClientRect();
          return curve.top > bounds.top && curve.bottom < bounds.bottom;
        });
      });
      expect(fits).toBe(true);
      if (name === 'campaigns') {
        const description = await page.locator('[data-workspace-header] p').last().boundingBox();
        const control = await page.getByRole('button', { name: 'Agent Map', exact: true }).boundingBox();
        if (!(description && control)) {
          throw new Error('Campaign header controls are missing');
        }
        expect(control.y - description.y - description.height).toBeGreaterThanOrEqual(12);
        expect(control.y - description.y - description.height).toBeLessThanOrEqual(16);
      }
      // These contours are deliberately faint; the default pixel threshold can
      // otherwise treat a clipped crest as equivalent to an intact one.
      await expect(page.locator('[data-workspace-atmosphere]')).toHaveScreenshot(`atmosphere-${name}-${width}.png`, {
        threshold: 0.01,
      });
    }
  }
});
