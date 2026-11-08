import { expect, test, waitForHydratedNavigation, waitForHydratedReport } from './browser-test';
import { settleAnimations } from './settle-animations';

test('the Work threads route has neither report header drift nor report progress', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/work');
  await expect(page.locator('main[data-work-hydrated="true"]')).toBeVisible();
  const motion = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY)
      .map((animation) => (animation instanceof CSSAnimation ? animation.animationName : 'not-css')),
  );
  expect(motion).toEqual([]);
  await expect(page.locator('[data-workspace-header]')).toHaveCount(0);
  await expect(page.locator('[data-report-progress]')).toHaveCount(0);
  await settleAnimations(page);
});

test('a throwing region reports its defect, preserves siblings, and resets after its own refetch', async ({ page }) => {
  await page.goto('/');
  await waitForHydratedReport(page);
  await page.evaluate(async () => {
    const errors: string[] = [];
    Reflect.set(globalThis, '__regionErrors', errors);
    globalThis.reportError = (cause: unknown) => {
      errors.push(cause instanceof Error ? cause.message : String(cause));
    };
    const url = '/src/lib/features/shell/region-recovery.browser-fixture.ts';
    const loaded: unknown = await import(url);
    if (
      !(
        loaded &&
        typeof loaded === 'object' &&
        'installFixture' in loaded &&
        typeof loaded.installFixture === 'function'
      )
    ) {
      throw new Error('Recovery fixture did not load');
    }
    const target = document.createElement('div');
    const shell = document.querySelector('[data-app-shell-content]');
    if (!shell) {
      throw new Error('Application shell is missing');
    }
    shell.append(target);
    loaded.installFixture(target, false);
  });
  const fixture = page.locator('[data-recovery-fixture]');
  const status = fixture.locator('[data-region-container] > [role="status"]');
  await expect(status).toHaveText('');
  await fixture.getByRole('button', { name: 'Break region', exact: true }).click();
  await expect(
    fixture.locator('[data-region-unavailable]').getByText('Fixture panel is temporarily unavailable.'),
  ).toBeVisible();
  await expect(fixture.getByText('Independent sibling remains usable')).toBeVisible();
  await expect(fixture.getByRole('button', { name: 'Retry', exact: true })).toBeFocused();
  await expect(status).toHaveText('Fixture panel is temporarily unavailable.');
  await fixture.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(fixture.getByText('Region recovered')).toBeVisible();
  await expect(fixture.locator('[data-region-refetches]')).toHaveText('1');
  await expect(fixture.locator('[data-region-container]')).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(globalThis, '__regionErrors'))).toEqual([
    'Expected region render failure',
  ]);
  await expect(page.locator('[data-report-overview]')).toBeVisible();
});

test('a repeat route failure is reported without reloading or leaving Retry stuck', async ({ context, page }) => {
  await context.setExtraHTTPHeaders({ 'x-ai-usage-sveltekit-error': 'always' });
  await page.goto('/');
  await waitForHydratedNavigation(page);
  await expect(page.locator('[data-error-route][data-hydrated="true"]')).toBeVisible();
  await page.evaluate(() => Reflect.set(globalThis, '__repeatRetryDocument', 'retained'));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Retry failed. Try again.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => Reflect.get(globalThis, '__repeatRetryDocument'))).toBe('retained');
});

test('optional quota failure preserves a 200 document and exposes a local client retry', async ({ context, page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await context.setExtraHTTPHeaders({ 'x-ai-usage-sveltekit-quota-error': 'once' });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await waitForHydratedReport(page);
  const unavailable = page.getByRole('region', { name: 'Provider quota', exact: true });
  await expect(unavailable.getByText('Provider quota is temporarily unavailable.')).toBeVisible();
  await page.evaluate(() => Reflect.set(globalThis, '__quotaRetryDocument', 'retained'));
  await unavailable.getByRole('button', { name: 'Provider quota unavailable. Retry', exact: true }).click();
  await expect(unavailable).toHaveCount(0);
  await expect(page.locator('[data-report-overview]')).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(globalThis, '__quotaRetryDocument'))).toBe('retained');
});
