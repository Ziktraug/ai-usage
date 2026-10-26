import { readFile, writeFile } from 'node:fs/promises';
import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import { parseWorkAttemptsListOutput } from '@ai-usage/web-contract/work-attempts';
import { parseWorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';
import { CODEX_JOURNEY_ACCOUNT, CODEX_JOURNEY_RECORD_ENV } from './work-codex-fixture';

const projectThirty = /context-project=30/;
const rootId = 'local_fixture-blocked-root';
const target = { harness: 'claude', sourceSessionId: 'claude-fixture-025' };

test('fake Codex native process: choose model, review, retrieve context, interrupt and keep partial output', async ({
  page,
  request,
}, testInfo) => {
  const recordPath = process.env[CODEX_JOURNEY_RECORD_ENV];
  if (!recordPath) {
    throw new Error('Codex fake journey requires its disposable fixture record');
  }
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as { modePath: string; logPath: string };
  const post = async (route: string, input: unknown) =>
    await request.post(`/rpc/${route}`, {
      data: encodeRpcResponseBody(input),
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    });
  await expect
    .poll(
      async () => {
        const response = await post('work/attention', { limit: 100 });
        const output = parseWorkAttentionOutput(decodeRpcResponseBody(await response.text()));
        return output.ok && output.data.roots.some((root) => root.desktopSessionId === rootId && root.session !== null);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  let serverNow = '';
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/rpc/workRouting/context?data=${encodeURIComponent(encodeRpcResponseBody({}))}`,
        );
        const context = parseWorkRoutingContext(decodeRpcResponseBody(await response.text()));
        serverNow = context.generatedAt;
        return context.executorObservations.some(
          (entry) => entry.harness === 'codex' && entry.authState === 'logged-in' && entry.accountFingerprint,
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await page.clock.install({ time: serverNow });
  await page.goto(`/work/sessions?root=${rootId}`);
  await expect(page.locator('main[data-work-hydrated="true"]')).toBeVisible();
  const aside = page.locator('[data-work-aside]');
  const selection = aside.getByLabel('Review executor');
  await selection.selectOption({ label: `Codex · gpt-6-astra · high · ${CODEX_JOURNEY_ACCOUNT}` });
  await aside.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await expect(aside.getByRole('region', { name: 'Routing result' })).toContainText('Chosen: Codex');
  await aside.getByRole('button', { name: 'Start read-only review (Codex)' }).dblclick();
  const attempts = aside.locator('[data-work-attempt]');
  await expect(attempts).toHaveCount(1, { timeout: 45_000 });
  await expect(attempts.first()).toHaveAttribute('data-work-attempt-state', 'finished', { timeout: 45_000 });
  await expect(attempts.first()).toContainText('No findings in supplied patch. Coverage: supplied commit only.');
  await expect(attempts.first()).toContainText('model gpt-6-astra · effort high');
  await expect(attempts.first()).toContainText('native-thread-1');
  await expect(attempts.first()).toContainText('native-turn-1');
  await expect(attempts.first()).toContainText('Fixture: investigate checkout 3');
  const firstId = await attempts.first().getAttribute('data-work-attempt');
  await page.reload();
  await expect(attempts.first()).toHaveAttribute('data-work-attempt', firstId ?? '');
  await expect(attempts.first()).toContainText('No findings in supplied patch.');
  await attempts.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('codex-result-desktop.png') });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);

  await writeFile(record.modePath, 'hold');
  await selection.selectOption({ label: `Codex · gpt-6-sol · high · ${CODEX_JOURNEY_ACCOUNT}` });
  await aside.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await aside.getByRole('button', { name: 'Start read-only review (Codex)' }).click();
  await expect(attempts).toHaveCount(2, { timeout: 45_000 });
  const running = aside.locator('[data-work-attempt-state="running"]');
  await expect(running.getByRole('button', { name: 'Request stop (Codex)' })).toBeVisible({ timeout: 45_000 });
  await running.getByRole('button', { name: 'Request stop (Codex)' }).click();
  await expect(aside.locator('[data-work-stop-confirmed]')).toBeVisible({ timeout: 45_000 });
  await expect(attempts.first()).toContainText('Partial review');
  await expect(attempts.first()).toContainText('descendant processes are not confirmed stopped');
  const listed = parseWorkAttemptsListOutput(
    decodeRpcResponseBody(await (await post('workAttempts/list', { target })).text()),
  );
  expect(listed.ok && listed.data.attempts[0]?.stopRequestedAt).toBeTruthy();
  expect(listed.ok && listed.data.attempts[0]?.stopConfirmedAt).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const drawer = page.getByRole('dialog', { name: 'Selected root' });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-work-attempt]').first()).toContainText('Partial review');
  await drawer.locator('[data-work-attempt]').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('codex-stopped-390.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/work/sessions?context-project=hidden-context&context-days=180');
  await expect(page.locator('[data-work-root]').filter({ hasText: 'Old scoped exploration' })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-work-root]').filter({ hasText: 'Old scoped exploration' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('context-project')).toBe('hidden-context');
  await page.screenshot({ path: testInfo.outputPath('old-project-context-desktop.png') });
  const reads: string[] = [];
  page.on('request', (sent) => {
    if (sent.url().includes('/rpc/work/attention')) {
      reads.push(sent.url());
    }
  });
  await page.goto('/work/sessions?context-project=%2Fwork%2Fai-usage');
  await expect(page.locator('[data-work-context-invalid]')).toBeVisible();
  await expect(page.locator('[data-work-root]')).toHaveCount(0);
  expect(reads).toHaveLength(0);
  await page.getByText('Explore a project context', { exact: true }).click();
  await page.getByLabel('Exact project label').fill('30');
  const scopedRead = page.waitForResponse((response) => response.url().includes('/rpc/work/attention'));
  await page.getByRole('button', { name: 'Read project context', exact: true }).click();
  await scopedRead;
  await expect(page).toHaveURL(projectThirty);
  await expect(page.locator('[data-work-context-invalid]')).toHaveCount(0);
  await expect(page.locator('[data-work-root]')).toHaveCount(0);
  reads.length = 0;
  if ((await page.locator('[data-work-project-context]').getAttribute('open')) === null) {
    await page.getByText('Explore a project context', { exact: true }).click();
  }
  await page.getByLabel('Exact project label').fill('/work/ai-usage');
  await page.getByRole('button', { name: 'Read project context', exact: true }).click();
  await expect(page.locator('[data-work-context-invalid]')).toBeVisible();
  await expect(page.locator('[data-work-root]')).toHaveCount(0);
  expect(reads).toHaveLength(0);
  await page.goto('/work/sessions?context-project=checkout-3');
  const native = page
    .locator('[data-work-root]')
    .filter({ hasText: 'Keep the scoped context available across worktrees?' });
  await expect(native).toBeVisible();
  await native.click();
  await expect(page.locator('[data-work-aside] [data-work-native-requests]')).toContainText(
    'No attributable answer observed',
  );
  await page.screenshot({ path: testInfo.outputPath('native-question-desktop.png') });
  await writeFile(record.modePath, 'success');
  await selection.selectOption({ label: `Codex · gpt-6-astra · high · ${CODEX_JOURNEY_ACCOUNT}` });
  await aside.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await aside.getByRole('button', { name: 'Start read-only review (Codex)' }).click();
  await expect(attempts).toHaveCount(1, { timeout: 45_000 });
  await expect(attempts.first()).toHaveAttribute('data-work-attempt-state', 'finished', { timeout: 45_000 });
  await expect(attempts.first()).toContainText('No findings in supplied patch.');
  const nativeRoot = new URL(page.url()).searchParams.get('root');
  const nativeAttempt = await attempts.first().getAttribute('data-work-attempt');
  await page.reload();
  expect(new URL(page.url()).searchParams.get('root')).toBe(nativeRoot);
  expect(new URL(page.url()).searchParams.get('context-project')).toBe('checkout-3');
  await expect(attempts.first()).toHaveAttribute('data-work-attempt', nativeAttempt ?? '');
  await expect(aside.locator('[data-work-native-requests]')).toContainText(
    'Keep the scoped context available across worktrees?',
  );
  await attempts.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('native-context-result-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await drawer.locator('[data-work-attempt]').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('native-context-result-390.png') });

  const measureRouting = async (width: number) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const surface = width === 390 ? drawer : aside;
    await expect(surface).toBeVisible();
    const executor = surface.getByLabel('Review executor');
    await executor.selectOption({ label: `Codex · gpt-6-astra · high · ${CODEX_JOURNEY_ACCOUNT}` });
    // Stress only native control sizing after the real fixture journey; this disabled option is never routed.
    await executor.evaluate((element) => {
      const option = document.createElement('option');
      option.textContent =
        'Codex · gpt-6-astra · high · account-with-a-long-namespaced-identity-and-an-explicit-project-qualification';
      option.disabled = true;
      element.append(option);
    });
    const geometry = await surface.evaluate((element) => {
      const select = element.querySelector('select');
      const paragraph = Array.from(element.querySelectorAll('p')).find((candidate) =>
        candidate.textContent?.startsWith('Constraints first;'),
      );
      if (!(select?.form && paragraph)) {
        throw new Error('Routing controls and constraints paragraph must be present');
      }
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const bounds = (node: Element) => {
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          client: node.clientWidth,
          scroll: node.scrollWidth,
        };
      };
      const textMetrics = document.createElement('canvas').getContext('2d');
      if (!textMetrics) {
        throw new Error('Text measurement is unavailable');
      }
      textMetrics.font = getComputedStyle(select).font;
      return {
        viewport: window.innerWidth,
        surface: bounds(element),
        form: bounds(select.form),
        select: bounds(select),
        selectedLabel: select.selectedOptions[0]?.label,
        selectedModelWidth: textMetrics.measureText('Codex · gpt-6-astra · high').width,
        paragraph: bounds(paragraph),
        text: Array.from(range.getClientRects(), (rect) => ({ left: rect.left, right: rect.right })),
      };
    });
    await executor.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`routing-controls-${width}.png`) });
    return geometry;
  };
  const routingGeometry = [await measureRouting(1440), await measureRouting(390)];
  await writeFile(testInfo.outputPath('routing-geometry.json'), JSON.stringify(routingGeometry, null, 2));
  for (const geometry of routingGeometry) {
    expect(geometry.select.right, `executor control at ${geometry.viewport}px`).toBeLessThanOrEqual(
      geometry.form.right,
    );
    expect(geometry.paragraph.right, `constraints box at ${geometry.viewport}px`).toBeLessThanOrEqual(
      geometry.form.right,
    );
    expect(
      Math.max(...geometry.text.map((rect) => rect.right)),
      `constraints text at ${geometry.viewport}px`,
    ).toBeLessThanOrEqual(geometry.form.right);
    expect(geometry.form.scroll).toBe(geometry.form.client);
    expect(geometry.selectedLabel).toBe(`Codex · gpt-6-astra · high · ${CODEX_JOURNEY_ACCOUNT}`);
    // Leave space for the control's padding and native disclosure arrow before the account suffix truncates.
    expect(geometry.selectedModelWidth).toBeLessThan(geometry.select.client - 40);
  }

  const protocol = (await readFile(record.logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(protocol.filter((entry) => entry.method === 'turn/start')).toHaveLength(3);
  expect(protocol.filter((entry) => entry.method === 'turn/interrupt')).toHaveLength(1);
  expect(protocol.filter((entry) => entry.method === 'thread/start').map((entry) => entry.params.model)).toEqual([
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-astra',
  ]);
});

// Delay real qualification responses, without replacing their body or invoking the command outside the UI.
test('a delayed qualification cannot replace another selected root or a newer qualification', async ({
  page,
  request,
}) => {
  let serverNow = '';
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/rpc/workRouting/context?data=${encodeURIComponent(encodeRpcResponseBody({}))}`,
        );
        const context = parseWorkRoutingContext(decodeRpcResponseBody(await response.text()));
        serverNow = context.generatedAt;
        return context.executorObservations.some(
          (entry) => entry.harness === 'codex' && entry.authState === 'logged-in',
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await page.clock.install({ time: serverNow });
  await page.goto('/work/sessions?context-project=fixture-pagination');
  await expect(page.locator('main[data-work-hydrated="true"]')).toBeVisible();
  const roots = page.locator('[data-work-root]');
  await expect(roots).toHaveCount(10);
  const first = roots.nth(0);
  const second = roots.nth(1);
  const firstId = await first.getAttribute('data-work-root');
  const secondId = await second.getAttribute('data-work-root');
  const lookups: string[] = [];
  page.on('request', (sent) => {
    if (sent.url().includes('/rpc/session/lookup')) {
      lookups.push(sent.url());
    }
  });
  await first.click();
  await expect(page).toHaveURL((url) => url.searchParams.get('root') === firstId);
  const aside = page.locator('[data-work-aside]');
  const qualify = aside.getByRole('button', { name: 'Qualify now with the engine' });
  const simulated = aside.getByRole('region', { name: 'Routing result' });
  await expect(qualify).toBeVisible();
  // Both are among the served page's newest rows, so selection reuses the same WorkRouting component.
  await second.click();
  await expect(page).toHaveURL((url) => url.searchParams.get('root') === secondId);
  await expect(qualify).toBeVisible();
  await first.click();
  await expect(page).toHaveURL((url) => url.searchParams.get('root') === firstId);
  await expect(qualify).toBeVisible();
  expect(lookups).toHaveLength(0);

  const deferred: { release: () => void; finished: Promise<void> }[] = [];
  await page.route('**/rpc/workRouting/qualify', async (route) => {
    const response = await route.fetch();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
    deferred.push({ release, finished });
    await held;
    await route.fulfill({ response });
    finish();
  });
  const settleResponse = async (index: number) => {
    const pending = deferred[index];
    if (!pending) {
      throw new Error('Expected a real deferred qualification');
    }
    pending.release();
    await pending.finished;
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
  };
  try {
    await qualify.click();
    await expect.poll(() => deferred.length).toBe(1);
    await second.click();
    await expect(page).toHaveURL((url) => url.searchParams.get('root') === secondId);
    await aside
      .getByLabel('Review executor')
      .selectOption({ label: `Codex · gpt-6-sol · high · ${CODEX_JOURNEY_ACCOUNT}` });
    await aside.getByRole('button', { name: 'Run simulation', exact: true }).click();
    await expect(simulated).toContainText('Chosen: Codex');
    const selected = await aside.getByLabel('Review executor').inputValue();
    await settleResponse(0);
    await expect(simulated).toContainText('Chosen: Codex');
    await expect(aside.getByLabel('Review executor')).toHaveValue(selected);
    await expect(aside.getByRole('region', { name: 'Engine qualification', exact: true })).toHaveCount(0);

    // A -> B -> A must invalidate the first A even though its identity matches again.
    await first.click();
    await expect(page).toHaveURL((url) => url.searchParams.get('root') === firstId);
    await qualify.click();
    await expect.poll(() => deferred.length).toBe(2);
    await second.click();
    await expect(page).toHaveURL((url) => url.searchParams.get('root') === secondId);
    await first.click();
    await expect(page).toHaveURL((url) => url.searchParams.get('root') === firstId);
    await qualify.click();
    await expect.poll(() => deferred.length).toBe(3);
    await settleResponse(1);
    await expect(qualify).toBeDisabled();
    await expect(aside.getByRole('region', { name: 'Engine qualification', exact: true })).toHaveCount(0);
    await settleResponse(2);
    await expect(qualify).toBeEnabled();
    await expect(aside.getByRole('region', { name: 'Engine qualification', exact: true })).toBeVisible();
    expect(lookups).toHaveLength(0);
  } finally {
    for (const pending of deferred) {
      pending.release();
    }
  }
});
