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
