import { readFile, writeFile } from 'node:fs/promises';
import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import { parseWorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';
import { CODEX_NATIVE_RECORD_ENV } from './work-codex-native-fixture';

test('real installed Codex metadata refuses credit-enabled generation from Work', async ({
  page,
  request,
}, testInfo) => {
  const recordPath = process.env[CODEX_NATIVE_RECORD_ENV];
  if (!recordPath) {
    throw new Error('Native refusal profile requires its explicit record');
  }
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as { configPath: string; logPath: string };
  let fingerprint: string | null = null;
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/rpc/workRouting/context?data=${encodeURIComponent(encodeRpcResponseBody({}))}`,
        );
        const context = parseWorkRoutingContext(decodeRpcResponseBody(await response.text()));
        const native = context.executorObservations.find((entry) => entry.harness === 'codex');
        fingerprint = native?.accountFingerprint ?? null;
        return native?.authMethod === 'chatgpt' && fingerprint !== null;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const config = JSON.parse(await readFile(record.configPath, 'utf8'));
  config.routing.executors[0].accountFingerprint = fingerprint;
  config.routing.executors[0].accountScope = fingerprint;
  await writeFile(record.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await expect
    .poll(
      async () => {
        const response = await request.post('/rpc/work/attention', {
          data: encodeRpcResponseBody({ limit: 100 }),
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        });
        const output = parseWorkAttentionOutput(decodeRpcResponseBody(await response.text()));
        return (
          output.ok &&
          output.data.roots.some(
            (root) => root.desktopSessionId === 'local_fixture-blocked-root' && root.session !== null,
          )
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await page.goto('/work?root=local_fixture-blocked-root');
  await expect(page.locator('main[data-work-hydrated="true"]')).toBeVisible();
  const aside = page.locator('[data-work-aside]');
  await aside.getByRole('button', { name: 'Qualify now with the engine' }).click();
  await expect(aside.getByRole('button', { name: 'Start read-only review (Codex)' })).toBeVisible({ timeout: 45_000 });
  await aside.getByRole('button', { name: 'Start read-only review (Codex)' }).click();
  await expect(aside.locator('[data-work-attempt-state="failed"]')).toContainText(
    'Codex credits are enabled or unknown',
    { timeout: 45_000 },
  );
  await expect(aside.locator('[data-work-attempt-state="failed"]')).toContainText('review was not generated');
  await expect(aside.locator('[data-work-attempt-state="failed"]')).toContainText('not reported yet');
  await aside.locator('[data-work-attempt-state="failed"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('native-credit-refusal-desktop.png') });
  const methods = (await readFile(record.logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).method);
  expect(methods).toContain('account/read');
  expect(methods).toContain('account/rateLimits/read');
  expect(methods).not.toContain('thread/start');
  expect(methods).not.toContain('turn/start');
  await writeFile(
    testInfo.outputPath('native-refusal-methods.json'),
    JSON.stringify({ nativeMetadata: true, generationGuardTriggered: false, methods }, null, 2),
  );
  await page.reload();
  await expect(aside.locator('[data-work-attempt-state="failed"]')).toContainText('review was not generated');
});
