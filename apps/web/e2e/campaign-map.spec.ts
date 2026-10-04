import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, openHydratedReport, test, waitForHydratedNavigation } from './browser-test';

const ROOT_TITLE = 'Build forecast model';
const NESTED_TITLE = 'Verify ingestion edge cases';
const STANDALONE_TITLE = 'Review release notes';
const CURSOR_TITLE = 'Explore dashboard layout';
const ORPHAN_TITLE = 'Check migration compatibility';
const ROOT_CARD_NAME = /^Build forecast model /;
const STANDALONE_CARD_NAME = /^Review release notes /;
const CURSOR_CARD_NAME = /^Explore dashboard layout /;
const ORPHAN_CARD_NAME = /^Check migration compatibility /;

const agentMap = (page: Page): Locator => page.getByRole('region', { name: 'Agent Map', exact: true });

const node = (page: Page, title: string): Locator =>
  page.locator('[data-campaign-node]').filter({
    has: page.getByRole('button', { exact: true, name: `Open session ${title}` }),
  });

const openCampaigns = async (page: Page): Promise<void> => {
  await page.goto('/campaigns');
  await waitForHydratedNavigation(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns', exact: true })).toBeVisible();
  await expect(agentMap(page).getByRole('heading', { name: ROOT_TITLE, exact: true })).toBeVisible();
};

const selectCampaign = async (page: Page, name: RegExp, title: string): Promise<void> => {
  const back = page.getByRole('button', { name: 'Back to campaigns', exact: true });
  if (await back.isVisible()) {
    await back.click();
  }
  const card = page.getByRole('region', { name: 'Recent campaigns', exact: true }).getByRole('button', { name });
  const key = await card.getAttribute('data-campaign-key');
  await card.click();
  await expect(page.locator(`[data-campaign-card][data-campaign-key="${key}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(agentMap(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
};

test('discovers Campaigns from the report and shows observed hierarchy and overlap', async ({ page }) => {
  await openHydratedReport(page);
  await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
  await expect(page).toHaveURL('/campaigns');
  await expect(agentMap(page).getByRole('heading', { name: ROOT_TITLE, exact: true })).toBeVisible();
  await expect(page.locator('[data-campaign-card]')).toHaveCount(4);
  await expect(page.locator('[data-campaign-node]')).toHaveCount(5);
  await expect(node(page, ROOT_TITLE)).toHaveAttribute('data-depth', '0');
  await expect(node(page, ROOT_TITLE)).toHaveAttribute('data-relationship', 'root');
  await expect(node(page, NESTED_TITLE)).toHaveAttribute('data-depth', '2');
  await expect(node(page, NESTED_TITLE)).toHaveAttribute('data-relationship', 'child');
  await expect(agentMap(page)).toContainText('4 sessions');
  await expect(agentMap(page)).toContainText('1.3M');
  await expect(agentMap(page)).toContainText('does not prove continuous agent activity');

  await page.evaluate(async () => await document.fonts.ready);
  const modelBar = await node(page, 'Define the data model').locator('[data-campaign-bar]').boundingBox();
  const ingestionBar = await node(page, 'Implement market ingestion').locator('[data-campaign-bar]').boundingBox();
  if (!(modelBar && ingestionBar)) {
    throw new Error('Both parallel sessions must have visible timeline bars');
  }
  expect(modelBar.x).toBeLessThan(ingestionBar.x);
  expect(modelBar.x + modelBar.width).toBeGreaterThan(ingestionBar.x);
  expect(ingestionBar.x + ingestionBar.width).toBeGreaterThan(modelBar.x + modelBar.width);

  await page.getByRole('button', { name: 'Collapse descendants of Implement market ingestion', exact: true }).click();
  await expect(page.locator('[data-campaign-node]')).toHaveCount(4);
  await expect(node(page, NESTED_TITLE)).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand descendants of Implement market ingestion', exact: true }).click();
  await expect(node(page, NESTED_TITLE)).toBeVisible();
});

test('opens an individual nested session with the keyboard and restores focus after its details close', async ({
  page,
}) => {
  await openCampaigns(page);
  const trigger = page.getByRole('button', { name: `Open session ${NESTED_TITLE}`, exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(NESTED_TITLE, { exact: true })).toBeVisible();
  await expect(drawer.locator('[data-detail-item="Total tokens"]')).toContainText('160k');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('restores a partially visible clicked session without moving the map and still reveals keyboard targets', async ({
  page,
}) => {
  await openCampaigns(page);
  const viewport = page.locator('[data-campaign-scroll="map"]');
  const trigger = page.getByRole('button', { name: 'Open session Define the data model', exact: true });
  await viewport.scrollIntoViewIfNeeded();
  const viewportBox = await viewport.boundingBox();
  const triggerBox = await trigger.boundingBox();
  if (!(viewportBox && triggerBox)) {
    throw new Error('The map viewport and session must be available');
  }
  await page.mouse.move(viewportBox.x + viewportBox.width / 2, Math.min(viewportBox.y + 60, 680));
  await page.mouse.wheel(0, triggerBox.y - viewportBox.y + 30);
  const readPosition = () =>
    trigger.evaluate((element) => {
      const host = element.closest<HTMLElement>('[data-campaign-scroll="map"]');
      if (!host) {
        throw new Error('The session must belong to the map viewport');
      }
      return { offset: element.getBoundingClientRect().top - host.getBoundingClientRect().top, top: host.scrollTop };
    });
  await expect.poll(async () => (await readPosition()).offset).toBeLessThan(-20);
  const before = await readPosition();
  const click = await trigger.evaluate((element) => {
    const host = element.closest<HTMLElement>('[data-campaign-scroll="map"]');
    if (!host) {
      throw new Error('The session must belong to the map viewport');
    }
    const box = element.getBoundingClientRect();
    const bounds = host.getBoundingClientRect();
    return {
      x: box.x + box.width / 2,
      y: (Math.max(box.top, bounds.top, 0) + Math.min(box.bottom, bounds.bottom, innerHeight)) / 2,
    };
  });
  await page.mouse.click(click.x, click.y);
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Define the data model', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  const after = await readPosition();
  await test.info().attach('partial-session-focus', {
    body: JSON.stringify({ before, after }),
    contentType: 'application/json',
  });
  expect(Math.abs(after.offset - before.offset)).toBeLessThan(2);
  expect(Math.abs(after.top - before.top)).toBeLessThan(2);

  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('button', { name: `Collapse descendants of ${ROOT_TITLE}`, exact: true })).toBeFocused();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(1);
});

test('restores session inspection and its campaign through Back and Forward in the same revision', async ({ page }) => {
  await openCampaigns(page);
  const revision = await page.locator('[data-map-revision]').getAttribute('data-map-revision');
  expect(revision).toBeTruthy();
  await selectCampaign(page, STANDALONE_CARD_NAME, STANDALONE_TITLE);
  await page.getByRole('button', { name: `Open session ${STANDALONE_TITLE}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(STANDALONE_TITLE, { exact: true })).toBeVisible();

  await page.goBack();
  await expect(drawer).toBeHidden();
  await expect(agentMap(page).getByRole('heading', { name: STANDALONE_TITLE, exact: true })).toBeVisible();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('selectedCampaign')).toBeNull();
  await expect(agentMap(page).getByRole('heading', { name: ROOT_TITLE, exact: true })).toBeVisible();
  await expect(page.locator('[data-map-revision]')).toHaveAttribute('data-map-revision', revision!);
  await expect(drawer).toBeHidden();
  await page.goForward();
  await expect(agentMap(page).getByRole('heading', { name: STANDALONE_TITLE, exact: true })).toBeVisible();
  await expect(drawer).toBeHidden();
  await page.goForward();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(STANDALONE_TITLE, { exact: true })).toBeVisible();
});

test('keeps standalone, missing timing, and unavailable parents distinct and preserves selection on reload', async ({
  page,
}) => {
  await openCampaigns(page);
  await selectCampaign(page, STANDALONE_CARD_NAME, STANDALONE_TITLE);
  await expect(page.locator('[data-campaign-node]')).toHaveCount(1);
  await expect(node(page, STANDALONE_TITLE)).toHaveAttribute('data-relationship', 'root');
  await expect(agentMap(page)).toContainText('Claude');
  await expect(agentMap(page).getByText('Lineage: parent unavailable', { exact: true })).toHaveCount(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('selectedCampaign'))
    .toBe('campaign-demo-machine:claude:release-notes');
  await page.reload();
  await waitForHydratedNavigation(page);
  await expect(agentMap(page).getByRole('heading', { name: STANDALONE_TITLE, exact: true })).toBeVisible();

  await selectCampaign(page, CURSOR_CARD_NAME, CURSOR_TITLE);
  await expect(agentMap(page)).toContainText('Timing is incomplete.');
  await expect(agentMap(page)).toContainText('End not recorded');
  const timingPoint = agentMap(page).locator('[data-campaign-bar][data-timing="missing-end"]');
  await expect(timingPoint).toHaveCount(1);
  await expect(timingPoint).toHaveCSS('width', '3px');
  await expect(agentMap(page).locator('[data-campaign-bar][data-timing="recorded"]')).toHaveCount(0);
  await selectCampaign(page, ORPHAN_CARD_NAME, ORPHAN_TITLE);
  await expect(agentMap(page).getByText('Lineage: parent unavailable', { exact: true })).toBeVisible();
  await expect(page.locator('[data-campaign-node]')).toHaveCount(1);
});

test('filters through the URL, shows an empty result, and restores the prior campaign with Back', async ({ page }) => {
  await openCampaigns(page);
  const search = page.getByRole('searchbox', { name: 'Find a campaign', exact: true });
  await search.fill('no-campaign-matches-this-query');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('no-campaign-matches-this-query');
  await expect(
    page.getByText('No campaigns match this period and search. Try a wider period or clear the search.'),
  ).toBeVisible();
  await expect(page.locator('[data-campaign-card]')).toHaveCount(0);
  await expect(agentMap(page)).toHaveCount(0);
  await page.goBack();
  await expect(agentMap(page).getByRole('heading', { name: ROOT_TITLE, exact: true })).toBeVisible();
  await expect(search).toHaveValue('');
});

test('preserves multiple inherited harnesses when changing search and allows choosing one harness', async ({
  page,
}) => {
  const search = new URLSearchParams({ harness: JSON.stringify(['Codex', 'Claude']) });
  await page.goto(`/campaigns?${search.toString()}`);
  await waitForHydratedNavigation(page);
  const harness = page.getByRole('combobox', { name: 'Harness', exact: true });
  await expect(harness.locator('option:checked')).toHaveText('Multiple harnesses (Codex, Claude)');
  await expect(page.locator('[data-campaign-card]')).toHaveCount(3);

  await page.getByRole('searchbox', { name: 'Find a campaign', exact: true }).fill('release');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('release');
  await expect
    .poll(() => JSON.parse(new URL(page.url()).searchParams.get('harness') ?? '[]'))
    .toEqual(['Codex', 'Claude']);
  await expect(page.locator('[data-campaign-card]')).toHaveCount(1);
  await expect(agentMap(page)).toContainText(STANDALONE_TITLE);

  await harness.selectOption('Claude');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => JSON.parse(new URL(page.url()).searchParams.get('harness') ?? '[]')).toEqual(['Claude']);
  await expect(harness).toHaveValue('Claude');
  await expect(page.locator('[data-campaign-card]')).toHaveCount(1);
});

test('keeps the hierarchy accessible and within the viewport on desktop and narrow screens', async ({
  page,
}, testInfo) => {
  await openCampaigns(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ height: 900, width });
    const showMap = page.getByRole('button', { name: 'View selected campaign', exact: true });
    if (width === 390 && (await showMap.isVisible())) {
      await showMap.click();
    }
    await expect(node(page, NESTED_TITLE)).toBeVisible();
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
    const screenshotPath = testInfo.outputPath(`campaign-map-${width}px.png`);
    await page.screenshot({ fullPage: true, path: screenshotPath });
    await testInfo.attach(`campaign-map-${width}px`, { contentType: 'image/png', path: screenshotPath });
  }
  await selectCampaign(page, ROOT_CARD_NAME, ROOT_TITLE);
});
