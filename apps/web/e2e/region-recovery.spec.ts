import type { Page } from '@playwright/test';
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

interface RecoveryFixtureOptions {
  readonly holdRetry?: boolean;
  readonly initialFailure: boolean;
}

/** Mounts the isolated RecoverableRegion fixture; its controls live at `globalThis.__regionFixture`. */
const installRecoveryFixture = async (page: Page, options: RecoveryFixtureOptions): Promise<void> => {
  await page.goto('/');
  await waitForHydratedReport(page);
  await page.evaluate(async ({ holdRetry, initialFailure }) => {
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
    Reflect.set(globalThis, '__regionFixture', loaded.installFixture(target, initialFailure, { holdRetry }));
  }, options);
};

const fixtureControl = async (
  page: Page,
  control: 'breakRegion' | 'releaseRetry' | 'releaseRetryFailing',
): Promise<void> => {
  await page.evaluate((name) => {
    const controls: unknown = Reflect.get(globalThis, '__regionFixture');
    if (!(controls && typeof controls === 'object' && name in controls)) {
      throw new Error(`Recovery fixture control ${name} is missing`);
    }
    const invoke = Reflect.get(controls, name);
    if (typeof invoke !== 'function') {
      throw new Error(`Recovery fixture control ${name} is not callable`);
    }
    invoke();
  }, control);
};

const activeElementIsBody = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.activeElement === document.body);

test('a throwing region reports its defect, preserves siblings, and resets after its own refetch', async ({ page }) => {
  await installRecoveryFixture(page, { initialFailure: false });
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

test('a recovered region does not steal focus the reader moved elsewhere while the retry was pending', async ({
  page,
}) => {
  await installRecoveryFixture(page, { holdRetry: true, initialFailure: true });
  const fixture = page.locator('[data-recovery-fixture]');
  const retry = fixture.getByRole('button', { name: 'Retry', exact: true });
  const filter = fixture.locator('[data-sibling-filter]');
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(fixture.getByRole('button', { name: 'Retrying…', exact: true })).toBeDisabled();
  await filter.focus();
  await expect(filter).toBeFocused();
  await fixtureControl(page, 'releaseRetry');
  await expect(fixture.getByText('Region recovered')).toBeVisible();
  await expect(fixture.locator('[data-region-container] > [role="status"]')).toHaveText('Fixture panel recovered.');
  await expect(fixture.locator('[data-region-refetches]')).toHaveText('1');
  await expect(filter).toBeFocused();
  await expect(fixture.locator('[data-region-container]')).not.toBeFocused();
});

test('a retry whose re-render fails again keeps focus on the new Retry', async ({ page }) => {
  await installRecoveryFixture(page, { holdRetry: true, initialFailure: true });
  const fixture = page.locator('[data-recovery-fixture]');
  const status = fixture.locator('[data-region-container] > [role="status"]');
  const retry = fixture.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  const pending = fixture.getByRole('button', { name: 'Retrying…', exact: true });
  await expect(pending).toBeDisabled();
  // Pending must not drop keyboard focus: a native `disabled` button hands focus to the body.
  await expect(pending).toBeFocused();
  await fixtureControl(page, 'releaseRetryFailing');
  await expect(retry).toBeVisible();
  await expect(fixture.locator('[data-region-refetches]')).toHaveText('1');
  await expect(retry).toBeFocused();
  await expect(status).toHaveText('Fixture panel is temporarily unavailable.');
  expect(await page.evaluate(() => Reflect.get(globalThis, '__regionErrors'))).toEqual([
    'Expected region render failure',
    'Expected region render failure',
  ]);
});

test('a region whose focus left to nothing does not pull focus onto Retry when it later fails', async ({ page }) => {
  await installRecoveryFixture(page, { initialFailure: false });
  const fixture = page.locator('[data-recovery-fixture]');
  const inside = fixture.getByRole('button', { name: 'Break region', exact: true });
  await inside.focus();
  await expect(inside).toBeFocused();
  // Clicking non-focusable text moves focus to the body: focusout fires with no relatedTarget.
  await fixture.getByText('Independent sibling remains usable').click();
  await expect.poll(() => activeElementIsBody(page)).toBe(true);
  await fixtureControl(page, 'breakRegion');
  const retry = fixture.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  await expect(fixture.getByText('Fixture panel is temporarily unavailable.').first()).toBeVisible();
  await expect(retry).not.toBeFocused();
  expect(await activeElementIsBody(page)).toBe(true);
  expect(await page.evaluate(() => Reflect.get(globalThis, '__regionErrors'))).toEqual([
    'Expected region render failure',
  ]);
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
