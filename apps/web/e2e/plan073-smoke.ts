import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

export const capturePlan073Smoke = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  const smokeDirectory = process.env.AI_USAGE_PLAN073_SMOKE_DIR;
  if (smokeDirectory) {
    await mkdir(smokeDirectory, { recursive: true });
  }
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    ...(smokeDirectory ? { path: join(smokeDirectory, `${name}.png`) } : {}),
  });
  await testInfo.attach(name, { body: screenshot, contentType: 'image/png' });
};
