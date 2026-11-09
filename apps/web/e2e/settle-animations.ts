import type { Page } from '@playwright/test';

/** Ambient drift and indeterminate progress never settle; await only finite transitions. */
export const settleAnimations = async (page: Page): Promise<void> => {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((animation) => animation.finished),
    ),
  );
};
