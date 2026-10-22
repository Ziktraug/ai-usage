import { readFile, writeFile } from 'node:fs/promises';
import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import { parseWorkAttemptsListOutput } from '@ai-usage/web-contract/work-attempts';
import { parseWorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';
import { CODEX_JOURNEY_ACCOUNT, CODEX_JOURNEY_RECORD_ENV } from './work-codex-fixture';

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
  await page.goto(`/work?root=${rootId}`);
  await expect(page.locator('main[data-work-hydrated="true"]')).toBeVisible();
  const aside = page.locator('[data-work-aside]');
  const selection = aside.getByLabel('Review executor');
  await selection.selectOption({ label: `Codex · ${CODEX_JOURNEY_ACCOUNT} · gpt-6-astra · high` });
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
  await page.screenshot({ path: testInfo.outputPath('codex-result-desktop.png'), fullPage: true });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);

  await writeFile(record.modePath, 'hold');
  await selection.selectOption({ label: `Codex · ${CODEX_JOURNEY_ACCOUNT} · gpt-6-sol · high` });
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
  const protocol = (await readFile(record.logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(protocol.filter((entry) => entry.method === 'turn/start')).toHaveLength(2);
  expect(protocol.filter((entry) => entry.method === 'turn/interrupt')).toHaveLength(1);
  expect(protocol.filter((entry) => entry.method === 'thread/start').map((entry) => entry.params.model)).toEqual([
    'gpt-6-astra',
    'gpt-6-sol',
  ]);
});
