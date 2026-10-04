import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test, waitForHydratedNavigation } from './browser-test';

const ROOT_TITLE = 'Build forecast model';
const NESTED_TITLE = 'Verify ingestion edge cases';
const STANDALONE_TITLE = 'Review release notes';
const CURSOR_TITLE = 'Explore dashboard layout';
const ORPHAN_TITLE = 'Check migration compatibility';
const STANDALONE_KEY = 'campaign-demo-machine:claude:release-notes';

const timeline = (page: Page): Locator => page.locator('[data-project-timeline]');
const campaign = (page: Page, title: string): Locator =>
  page.locator('[data-timeline-campaign]').filter({
    has: page.getByRole('button', { exact: true, name: `Select campaign ${title}` }),
  });
const session = (page: Page, title: string): Locator =>
  page.locator('[data-timeline-session]').filter({
    has: page.getByRole('button', { exact: true, name: `Open session ${title}` }),
  });

const revealTimelineRow = async (page: Page, target: Locator): Promise<void> => {
  const viewport = page.locator('[data-campaign-scroll="timeline"]');
  await viewport.scrollIntoViewIfNeeded();
  await viewport.focus();
  await page.keyboard.press('Home');
  // Chromium animates native Home scrolling; wait until it finishes before sending wheel input.
  await expect.poll(() => viewport.evaluate((element) => Math.abs(element.scrollTop))).toBeLessThan(1);
  for (let index = 0; index < 60; index++) {
    const box = await viewport.boundingBox();
    if (!box) {
      throw new Error('Timeline viewport is unavailable');
    }
    const top = Math.max(box.y, 0);
    const bottom = Math.min(box.y + box.height, page.viewportSize()?.height ?? 720);
    const targetBox = await target.boundingBox({ timeout: 50 }).catch(() => null);
    if (targetBox && targetBox.y >= top && targetBox.y + targetBox.height <= bottom) {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const nextBox = await target.boundingBox({ timeout: 50 }).catch(() => null);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const settledBox = await target.boundingBox({ timeout: 50 }).catch(() => null);
      if (
        nextBox &&
        settledBox &&
        Math.abs(nextBox.y - targetBox.y) < 1 &&
        Math.abs(settledBox.y - targetBox.y) < 1 &&
        settledBox.y >= top &&
        settledBox.y + settledBox.height <= bottom
      ) {
        await expect(target).toBeVisible();
        return;
      }
      continue;
    }
    await page.mouse.move(box.x + box.width / 2, (top + bottom) / 2);
    await page.mouse.wheel(0, box.height * 0.4 * (targetBox && targetBox.y < box.y ? -1 : 1));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  throw new Error(`Timeline target was not reached by scrolling: ${target}`);
};

const projectHeader = (page: Page, label: string): Locator =>
  page
    .locator('[data-timeline-project]')
    .filter({ has: page.getByRole('button', { name: `Collapse project ${label}`, exact: true }) });

const openTimeline = async (page: Page, url = '/campaigns?campaignView=timeline'): Promise<void> => {
  await page.goto(url);
  await waitForHydratedNavigation(page);
  await expect(timeline(page)).toBeVisible();
  await expect(page.locator('[data-timeline-session]')).toHaveCount(5);
};

const selectCampaign = async (page: Page, title: string, sessionCount: number): Promise<void> => {
  const trigger = page.getByRole('button', { exact: true, name: `Select campaign ${title}` });
  await revealTimelineRow(page, trigger);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-timeline-session]')).toHaveCount(sessionCount);
  await expect(session(page, title)).toBeVisible();
};

test('preserves the project timeline mode and selected campaign through reload and Back', async ({ page }) => {
  await page.goto('/campaigns');
  await waitForHydratedNavigation(page);
  await expect(page.getByRole('region', { exact: true, name: 'Agent Map' })).toBeVisible();
  await page.getByRole('button', { exact: true, name: 'Project timeline' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('campaignView')).toBe('timeline');
  await expect(timeline(page)).toBeVisible();
  for (const project of ['world-state', 'ai-usage', 'aroven']) {
    await revealTimelineRow(page, projectHeader(page, project));
  }
  for (const title of [ROOT_TITLE, STANDALONE_TITLE, CURSOR_TITLE, ORPHAN_TITLE]) {
    await revealTimelineRow(page, campaign(page, title));
  }
  await selectCampaign(page, STANDALONE_TITLE, 1);
  await expect.poll(() => new URL(page.url()).searchParams.get('selectedCampaign')).toBe(STANDALONE_KEY);

  await page.reload();
  await waitForHydratedNavigation(page);
  await expect(session(page, STANDALONE_TITLE)).toBeVisible();
  await expect(page.getByRole('button', { exact: true, name: 'Project timeline' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { exact: true, name: 'Agent Map' }).click();
  await expect(page.getByRole('region', { exact: true, name: 'Agent Map' })).toContainText(STANDALONE_TITLE);
  await expect(timeline(page)).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('campaignView')).toBe('timeline');
  await expect.poll(() => new URL(page.url()).searchParams.get('selectedCampaign')).toBe(STANDALONE_KEY);
  await expect(session(page, STANDALONE_TITLE)).toBeVisible();
});

test('collapses projects independently and expands only the selected campaign', async ({ page }) => {
  await openTimeline(page);
  await revealTimelineRow(page, campaign(page, STANDALONE_TITLE));
  await revealTimelineRow(page, campaign(page, ORPHAN_TITLE));
  await selectCampaign(page, STANDALONE_TITLE, 1);
  await page.getByRole('button', { exact: true, name: 'Collapse project ai-usage' }).click();
  await expect(campaign(page, STANDALONE_TITLE)).toHaveCount(0);
  await expect(campaign(page, ORPHAN_TITLE)).toHaveCount(0);
  await revealTimelineRow(page, campaign(page, ROOT_TITLE));
  await expect(campaign(page, ROOT_TITLE)).toBeVisible();
  await expect(page.locator('[data-timeline-session]')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('selectedCampaign')).toBe(STANDALONE_KEY);
  const expandProject = page.getByRole('button', { exact: true, name: 'Expand project ai-usage' });
  await revealTimelineRow(page, expandProject);
  await expandProject.click();
  await revealTimelineRow(page, campaign(page, STANDALONE_TITLE));
  await revealTimelineRow(page, campaign(page, ORPHAN_TITLE));
  await expect(session(page, STANDALONE_TITLE)).toBeVisible();

  await page.getByRole('button', { exact: true, name: `Collapse sessions for ${STANDALONE_TITLE}` }).click();
  await expect(page.locator('[data-timeline-session]')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('selectedCampaign')).toBe(STANDALONE_KEY);
  const expandRoot = page.getByRole('button', { exact: true, name: `Expand sessions for ${ROOT_TITLE}` });
  await revealTimelineRow(page, expandRoot);
  await expandRoot.click();
  await expect(page.locator('[data-timeline-session]')).toHaveCount(5);
  await expect(session(page, STANDALONE_TITLE)).toHaveCount(0);
  await expect(session(page, NESTED_TITLE)).toHaveAttribute('data-depth', '2');
});

test('opens standalone and nested sessions with the keyboard and restores detail focus', async ({ page }) => {
  await openTimeline(page);
  for (const { title, tokens, count } of [
    { title: STANDALONE_TITLE, tokens: '80,000', count: 1 },
    { title: ROOT_TITLE, tokens: '160k', count: 5 },
  ]) {
    await selectCampaign(page, title, count);
    const sessionTitle = title === ROOT_TITLE ? NESTED_TITLE : title;
    const trigger = page.getByRole('button', { exact: true, name: `Open session ${sessionTitle}` });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { exact: true, name: 'Session details' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(sessionTitle, { exact: true })).toBeVisible();
    await expect(drawer.locator('[data-detail-item="Total tokens"]')).toContainText(tokens);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  }
});

test('aligns campaigns and parallel sessions on the shared observed time axis', async ({ page }) => {
  await openTimeline(page, '/campaigns?campaignView=timeline&range=all');
  await expect(timeline(page)).toHaveAttribute('data-axis-start', '2026-06-11T06:45:00.000Z');
  await expect(timeline(page)).toHaveAttribute('data-axis-end', '2026-06-11T09:20:00.000Z');
  await page.evaluate(async () => await document.fonts.ready);
  const rootCampaignBar = await campaign(page, ROOT_TITLE).locator('[data-timeline-campaign-bar]').boundingBox();
  const rootSessionBar = await session(page, ROOT_TITLE).locator('[data-timeline-session-bar]').boundingBox();
  const projectBar = await projectHeader(page, 'world-state').locator('[data-timeline-project-bar]').boundingBox();
  await revealTimelineRow(page, campaign(page, STANDALONE_TITLE));
  const earlierCampaignBar = await campaign(page, STANDALONE_TITLE)
    .locator('[data-timeline-campaign-bar]')
    .boundingBox();
  await revealTimelineRow(page, session(page, 'Define the data model'));
  const modelBar = await session(page, 'Define the data model').locator('[data-timeline-session-bar]').boundingBox();
  const ingestionBar = await session(page, 'Implement market ingestion')
    .locator('[data-timeline-session-bar]')
    .boundingBox();
  if (!(rootCampaignBar && rootSessionBar && projectBar && earlierCampaignBar && modelBar && ingestionBar)) {
    throw new Error('Recorded campaigns and sessions must expose their timeline bars');
  }
  expect(projectBar.height).toBe(6);
  expect(rootSessionBar.height).toBe(8);
  expect(rootCampaignBar.height).toBe(14);
  expect(Math.abs(rootCampaignBar.x - rootSessionBar.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(rootCampaignBar.width - rootSessionBar.width)).toBeLessThanOrEqual(1);
  expect(earlierCampaignBar.x + earlierCampaignBar.width).toBeLessThan(rootCampaignBar.x);
  expect(modelBar.x).toBeLessThan(ingestionBar.x);
  expect(modelBar.x + modelBar.width).toBeGreaterThan(ingestionBar.x);
  expect(ingestionBar.x + ingestionBar.width).toBeGreaterThan(modelBar.x + modelBar.width);
});

test('keeps full campaign chronology when a child matches search and preserves timeline filters', async ({ page }) => {
  await openTimeline(page);
  const search = page.getByRole('searchbox', { exact: true, name: 'Find a campaign' });
  await search.fill('edge cases');
  await page.getByRole('button', { exact: true, name: 'Apply filters' }).click();
  await expect(page.locator('[data-timeline-campaign]')).toHaveCount(1);
  await expect(campaign(page, ROOT_TITLE)).toHaveAttribute('data-start', '2026-06-11T08:00:00.000Z');
  await expect(campaign(page, ROOT_TITLE)).toHaveAttribute('data-end', '2026-06-11T09:20:00.000Z');
  await expect(page.locator('[data-timeline-session]')).toHaveCount(5);
  await expect.poll(() => new URL(page.url()).searchParams.get('campaignView')).toBe('timeline');

  await search.fill('');
  for (const range of ['today', '7d']) {
    await page.getByRole('combobox', { exact: true, name: 'Period' }).selectOption(range);
    await page.getByRole('button', { exact: true, name: 'Apply filters' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('range')).toBe(range);
    await expect(page.getByText('4 of 4 campaigns loaded.', { exact: false })).toBeVisible();
    for (const title of [ROOT_TITLE, STANDALONE_TITLE, CURSOR_TITLE, ORPHAN_TITLE]) {
      await revealTimelineRow(page, campaign(page, title));
    }
    await expect(timeline(page)).toBeVisible();
  }
  const readAnchor = () =>
    page.locator('[data-campaign-scroll="timeline"]').evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll<HTMLElement>('[data-virtual-key]')].find(
        (candidate) => candidate.getBoundingClientRect().bottom > top + 1,
      );
      return { key: row?.dataset.virtualKey, offset: row ? row.getBoundingClientRect().top - top : 0 };
    });
  const savedAnchor = await readAnchor();
  expect(savedAnchor.key).toBeDefined();
  expect(
    await page.locator('[data-campaign-scroll="timeline"]').evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(100);
  await search.fill('no-campaign-matches-this-query');
  await page.getByRole('button', { exact: true, name: 'Apply filters' }).click();
  await expect(
    page.getByText('No campaigns match this period and search. Try a wider period or clear the search.'),
  ).toBeVisible();
  await expect(page.locator('[data-timeline-campaign]')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByText('4 of 4 campaigns loaded.', { exact: false })).toBeVisible();
  const expectRestoredAnchor = () =>
    expect
      .poll(async () => {
        const restored = await readAnchor();
        return restored.key === savedAnchor.key && Math.abs(restored.offset - savedAnchor.offset) < 2;
      })
      .toBe(true);
  await expectRestoredAnchor();
  await page.goForward();
  await expect(page.locator('[data-timeline-campaign]')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByText('4 of 4 campaigns loaded.', { exact: false })).toBeVisible();
  await expectRestoredAnchor();
  for (const title of [ROOT_TITLE, STANDALONE_TITLE, CURSOR_TITLE, ORPHAN_TITLE]) {
    await revealTimelineRow(page, campaign(page, title));
  }
  await expect(search).toHaveValue('');
  await expect.poll(() => new URL(page.url()).searchParams.get('campaignView')).toBe('timeline');
});

test('shows a single recorded time as a point and keeps unavailable parent lineage explicit', async ({ page }) => {
  await openTimeline(page);
  await selectCampaign(page, CURSOR_TITLE, 1);
  await expect(campaign(page, CURSOR_TITLE)).toContainText('Timing incomplete');
  await expect(campaign(page, CURSOR_TITLE).locator('[data-timeline-campaign-bar]')).toHaveCSS(
    'border-style',
    'dashed',
  );
  await expect(campaign(page, CURSOR_TITLE)).toHaveAttribute('data-start', '2026-06-11T07:00:00.000Z');
  expect(await campaign(page, CURSOR_TITLE).getAttribute('data-end')).toBeNull();
  await expect(session(page, CURSOR_TITLE)).toContainText('End not recorded');
  const point = session(page, CURSOR_TITLE).locator('[data-timeline-session-bar]');
  await expect(point).toBeVisible();
  const pointBox = await point.boundingBox();
  expect(pointBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(10);

  await selectCampaign(page, ORPHAN_TITLE, 1);
  await expect(session(page, ORPHAN_TITLE)).toContainText('Lineage: parent unavailable');
  await selectCampaign(page, STANDALONE_TITLE, 1);
  await expect(session(page, STANDALONE_TITLE)).not.toContainText('Lineage: parent unavailable');
});

test('opens a directly selected campaign outside the loaded timeline results in Agent Map', async ({ page }) => {
  const selectedCampaign = 'campaign-demo-machine:codex:forecast-root';
  const search = new URLSearchParams({
    campaignView: 'timeline',
    q: 'no-campaign-matches-this-query',
    selectedCampaign,
  });
  await page.goto(`/campaigns?${search.toString()}`);
  await waitForHydratedNavigation(page);
  await expect(page.locator('[data-timeline-campaign]')).toHaveCount(0);
  await expect(page.getByText('The selected campaign is outside the loaded results.')).toBeVisible();
  await page.getByRole('button', { exact: true, name: 'Open Agent Map' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('campaignView')).toBeNull();
  await expect.poll(() => new URL(page.url()).searchParams.get('selectedCampaign')).toBe(selectedCampaign);
  const map = page.getByRole('region', { exact: true, name: 'Agent Map' });
  await expect(map.getByRole('heading', { exact: true, name: ROOT_TITLE })).toBeVisible();
  await expect(map.locator('[data-campaign-node]')).toHaveCount(5);
});

test('recovers from an unavailable selected campaign when timeline results are empty', async ({ page }) => {
  const search = new URLSearchParams({
    campaignView: 'timeline',
    q: 'no-campaign-matches-this-query',
    selectedCampaign: 'campaign-demo-machine:codex:missing-campaign',
  });
  await page.goto(`/campaigns?${search.toString()}`);
  await waitForHydratedNavigation(page);
  await expect(page.locator('[data-timeline-campaign]')).toHaveCount(0);
  await expect(page.getByText('This campaign is unavailable in the current served revision.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('selectedCampaign')).toBeNull();
  await expect.poll(() => new URL(page.url()).searchParams.get('campaignView')).toBe('timeline');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('no-campaign-matches-this-query');
  await expect(page.getByText('This campaign is unavailable in the current served revision.')).toHaveCount(0);
  await expect(
    page.getByText('No campaigns match this period and search. Try a wider period or clear the search.'),
  ).toBeVisible();
});

test('keeps project and session chronology accessible on desktop and narrow screens', async ({ page }, testInfo) => {
  await openTimeline(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ height: 900, width });
    await expect(session(page, NESTED_TITLE)).toBeVisible();
    await page.evaluate(async () => await document.fonts.ready);
    const overflow = await page.evaluate(
      () =>
        Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.flatMap(({ target }) => target) })),
    ).toEqual([]);
    const screenshotPath = testInfo.outputPath(`campaign-timeline-${width}px.png`);
    await page.screenshot({ fullPage: true, path: screenshotPath });
    await testInfo.attach(`campaign-timeline-${width}px`, { contentType: 'image/png', path: screenshotPath });
  }
});
