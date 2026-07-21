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
