import type { Locator, Page } from '@playwright/test';

export type SessionSurfaceMode = 'desktop' | 'mobile';

export const sessionSurface = (page: Page, mode: SessionSurfaceMode): Locator =>
  page.locator(`[data-session-surface="${mode}"]`);

export const afterAnimationFrame = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );

export const moveSessionSurface = (surface: Locator, target: 'end' | 'start' | number): Promise<boolean> =>
  surface.evaluate((element, destination) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('The Session surface must be an HTML scroll container');
    }
    const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    let requestedScrollTop = typeof destination === 'number' ? destination : maximumScrollTop;
    if (destination === 'start') {
      requestedScrollTop = 0;
    }
    const nextScrollTop = Math.min(maximumScrollTop, Math.max(0, requestedScrollTop));
    if (nextScrollTop === element.scrollTop) {
      return false;
    }
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const handleScroll = (): void => {
        settled = true;
        resolve(true);
      };
      element.addEventListener('scroll', handleScroll, { once: true });
      element.scrollTop = nextScrollTop;
      requestAnimationFrame(() => {
        element.removeEventListener('scroll', handleScroll);
        if (!settled) {
          reject(new Error(`The Session surface moved to ${nextScrollTop} without a native scroll event`));
        }
      });
    });
  }, target);

export const readExpandedCampaignChildIdentity = async (
  page: Page,
  mode: SessionSurfaceMode,
  campaignLabel: string,
  childLabel: string,
  expectedChildIndex: number,
): Promise<string> => {
  const surface = sessionSurface(page, mode);
  const campaignRow = surface
    .locator('[data-depth="0"][data-index][data-session-row-id]')
    .filter({ hasText: campaignLabel });
  const expand =
    mode === 'desktop'
      ? page.getByRole('button', { name: `Expand campaign ${campaignLabel}` })
      : campaignRow.getByRole('button', { name: 'Show children' });
  await expand.waitFor({ state: 'visible' });
  await expand.click();

  const child = surface.locator('[data-depth="1"][data-index][data-session-row-id]').filter({ hasText: childLabel });
  await child.waitFor({ state: 'visible' });
  if ((await child.count()) !== 1) {
    throw new Error(`Expected exactly one expanded child for campaign ${campaignLabel}`);
  }
  const childIndex = Number(await child.getAttribute('data-index'));
  if (childIndex !== expectedChildIndex) {
    throw new Error(`Expected expanded child index ${expectedChildIndex}, received ${childIndex}`);
  }
  const childIdentity = await child.getAttribute('data-session-row-id');
  if (!childIdentity) {
    throw new Error(`Expanded child for campaign ${campaignLabel} did not expose an identity`);
  }

  const collapse =
    mode === 'desktop'
      ? page.getByRole('button', { name: `Collapse campaign ${campaignLabel}` })
      : campaignRow.getByRole('button', { name: 'Hide children' });
  await collapse.click();
  await child.waitFor({ state: 'detached' });
  return childIdentity;
};
