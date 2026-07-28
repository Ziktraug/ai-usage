import { expect, test } from './browser-test';

const resolvedThemeCases = [
  {
    colorScheme: 'light',
    expectedButtonName: 'Switch to dark theme',
    expectedCircleCount: 1,
    expectedIconFill: 'none',
    expectedPressed: 'false',
  },
  {
    colorScheme: 'dark',
    expectedButtonName: 'Switch to light theme',
    expectedCircleCount: 0,
    expectedIconFill: 'currentColor',
    expectedPressed: 'true',
  },
] as const;

for (const scenario of resolvedThemeCases) {
  test(`resolves the initial ${scenario.colorScheme} theme before naming the toggle`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scenario.colorScheme });
    await page.addInitScript(() => {
      localStorage.clear();
    });
    await page.goto('/');

    const toggle = page.getByRole('button', { name: scenario.expectedButtonName });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', scenario.expectedPressed);

    const icon = toggle.locator('svg');
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAttribute('fill', scenario.expectedIconFill);
    await expect(icon.locator('circle')).toHaveCount(scenario.expectedCircleCount);
  });
}
