import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import { parseWorkAttemptsListOutput, parseWorkAttemptsStartOutput } from '@ai-usage/web-contract/work-attempts';
import { parseWorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';
import {
  WORK_ATTEMPT_FIXTURE_ENVIRONMENT_KEY,
  WORK_ATTEMPT_FIXTURE_NATIVE_SESSION_ID,
  workAttemptFixtureCandidateId,
} from './work-attempt-fixture';

/**
 * Scenario 7 of the campaign acceptance (ADR 0053) on the production path: the supervised engine,
 * the disposable HOME seeded by `production-server.ts` with `AI_USAGE_WORK_ATTEMPT_E2E=1`, and a
 * fake `claude` first on the engine's PATH. The browser clicks once; the engine decides, records
 * and launches; the page follows the attempt to `finished` and still shows it after a reload. A
 * second request while the attempt is live returns the same attempt instead of a twin.
 *
 * Run it with: `AI_USAGE_WORK_ATTEMPT_E2E=1 bun --bun playwright test --config
 * playwright.production.config.ts e2e/work-attempt-production.spec.ts`.
 */
const MACHINE_ID = 'production-e2e-machine';
const BLOCKED_ROOT_ID = 'local_fixture-blocked-root';
/** The transcript the seeded Claude home carries (`seedHarnessHome` FIXTURE_IDS.claude); the blocked root joins to it. */
const SEEDED_TRANSCRIPT_ID = 'claude-fixture-025';
const WORK_ATTENTION_PATH = '/rpc/work/attention';
const ROUTING_CONTEXT_PATH = '/rpc/workRouting/context';
const ATTEMPTS_LIST_PATH = '/rpc/workAttempts/list';
const ATTEMPTS_START_PATH = '/rpc/workAttempts/start';
const COLLECTION_TIMEOUT_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 45_000;
const START_LABEL = 'Start read-only review (Claude Code)';
const STARTED_STATUS = /Review attempt [0-9a-f]{8} started/u;
const ATTEMPT_ID = /^[0-9a-f-]{36}$/u;

const waitForHydratedWork = async (page: Page): Promise<void> => {
  await expect(page.locator('main[data-route-shell="work"][data-work-hydrated="true"]')).toBeVisible({
    timeout: 15_000,
  });
};
const expectAxeClean = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
};

const postRpc = async (request: APIRequestContext, pathname: string, input: unknown) =>
  await request.post(pathname, {
    data: encodeRpcResponseBody(input),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  });

/** The engine must have collected the Desktop registry, published a revision, and observed the fake Claude Code. */
const waitForEngineFacts = async (request: APIRequestContext): Promise<string> => {
  await expect
    .poll(
      async () => {
        const response = await postRpc(request, WORK_ATTENTION_PATH, { limit: 100, machineId: null });
        if (!response.ok()) {
          return { status: response.status() };
        }
        const output = parseWorkAttentionOutput(decodeRpcResponseBody(await response.text()));
        return output.ok
          ? {
              collected: output.data.coverage.desktopSessions.collectedAt !== null,
              joined: output.data.coverage.sessions.revision !== null,
            }
          : { error: output.error.tag };
      },
      {
        message: 'The engine must collect the Desktop registry and publish a served revision',
        timeout: COLLECTION_TIMEOUT_MS,
      },
    )
    .toEqual({ collected: true, joined: true });
  let generatedAt = '';
  await expect
    .poll(
      async () => {
        // A GET procedure carries its (empty) input the way the oRPC client sends it: `?data=<serialized>`.
        const response = await request.get(
          `${ROUTING_CONTEXT_PATH}?data=${encodeURIComponent(encodeRpcResponseBody({}))}`,
        );
        if (!response.ok()) {
          return { status: response.status() };
        }
        const context = parseWorkRoutingContext(decodeRpcResponseBody(await response.text()));
        generatedAt = context.generatedAt;
        return {
          declared: context.declarations.length,
          loggedIn: context.executorObservations.some(
            (observation) => observation.harness === 'claude-code' && observation.authState === 'logged-in',
          ),
          targets: context.reviewTargets?.length ?? 0,
        };
      },
      {
        message: 'The engine must observe the fake Claude Code signed in and read the declared route',
        timeout: COLLECTION_TIMEOUT_MS,
      },
    )
    .toEqual({ declared: 1, loggedIn: true, targets: 1 });
  return generatedAt;
};

test('launches one read-only review from the cockpit, follows it to its result and never starts a twin', async ({
  page,
  request,
}) => {
  // The fixture is opt-in: without the flag the production server seeds no route, target or fake harness.
  expect(
    process.env[WORK_ATTEMPT_FIXTURE_ENVIRONMENT_KEY],
    `set ${WORK_ATTEMPT_FIXTURE_ENVIRONMENT_KEY}=1 so production-server.ts seeds the review fixture`,
  ).toBe('1');
  await page.setViewportSize({ width: 1440, height: 900 });
  const serverNow = await waitForEngineFacts(request);
  // The production fixture pins the server clock; the browser judges freshness against its own
  // clock, so it is aligned with the server's before the page loads (it keeps flowing from there).
  await page.clock.install({ time: serverNow });
  await page.goto(`/work?root=${BLOCKED_ROOT_ID}`);
  await waitForHydratedWork(page);
  const aside = page.getByRole('main').locator('[data-work-aside]');
  await expect(aside.locator('[data-work-detail]')).toHaveAttribute('data-work-detail', BLOCKED_ROOT_ID);
  await expect(aside.getByRole('heading', { level: 3, name: 'Review assignment simulation' })).toBeVisible();

  // Before any click: the attempts list exists and is empty; no button exists before a simulation.
  const attempts = aside.locator('[data-work-attempts]');
  await expect(attempts).toContainText('No review attempt for this session yet.');
  await expect(aside.getByRole('button', { name: START_LABEL })).toHaveCount(0);

  // The simulation is real: declared route, fake Claude Code observed signed in, fresh stored quota.
  await aside.getByRole('button', { name: 'Run simulation', exact: true }).click();
  const result = aside.getByRole('region', { name: 'Routing result' });
  await expect(result).toContainText('Chosen: Claude Code');
  await expect(result).toContainText('Real recommendation');
  const start = aside.getByRole('button', { name: START_LABEL });
  await expect(start).toBeVisible();
  await expect(aside.locator('[data-work-launch="open"]')).toContainText('.claude/worktrees/checkout-3');

  // Double click: the second click lands on a disabled button; the engine would reuse anyway.
  await start.dblclick();
  await expect(aside.getByRole('status').filter({ hasText: STARTED_STATUS })).toBeVisible({
    timeout: ATTEMPT_TIMEOUT_MS,
  });
  const item = attempts.locator('[data-work-attempt]');
  await expect(item).toHaveCount(1, { timeout: ATTEMPT_TIMEOUT_MS });
  const attemptId = await item.getAttribute('data-work-attempt');
  expect(attemptId).toMatch(ATTEMPT_ID);

  // A second request on the same target while it is live returns the same attempt, launching nothing.
  const twin = await postRpc(request, ATTEMPTS_START_PATH, {
    action: 'read-only-review',
    candidateId: workAttemptFixtureCandidateId(MACHINE_ID),
    target: { harness: 'claude', sourceSessionId: SEEDED_TRANSCRIPT_ID },
  });
  expect(twin.ok()).toBe(true);
  const twinOutput = parseWorkAttemptsStartOutput(decodeRpcResponseBody(await twin.text()));
  expect(twinOutput).toMatchObject({ data: { attemptId, reused: true }, ok: true });

  // The fake harness answers after its pause; the list polls while the attempt is live and stops after.
  await expect(item).toHaveAttribute('data-work-attempt-state', 'finished', { timeout: ATTEMPT_TIMEOUT_MS });
  await expect(item).toContainText('finished · attempt');
  await expect(item).toContainText('Finding 1: packages/fixture/a.ts:1 (low) The fixture change has no test.');
  await expect(item).toContainText('Result (review) · 2 turns · 2.5 s · exit 0:');
  await expect(item).toContainText(`Native session: ${WORK_ATTEMPT_FIXTURE_NATIVE_SESSION_ID}`);
  await expect(item).toContainText('not collected yet');
  await expect(item).toContainText('Launched with account fixture · model unknown · effort unknown.');
  await expect(item).toContainText('Checkout: ');
  await expect(item).toContainText('(Desktop session worktree)');
  await expect(item).toContainText('Validations executed: none (read-only review).');
  await expect(item).toContainText('Acceptance: pending — not reviewed by you.');
  await expect(item.getByRole('link', { name: 'Open session detail' })).toHaveCount(0);
  await expectAxeClean(page);

  // The store is the memory: a reload shows the same single attempt, finished, with the same id.
  await page.reload();
  await waitForHydratedWork(page);
  const reloaded = page.getByRole('main').locator('[data-work-aside] [data-work-attempt]');
  await expect(reloaded).toHaveCount(1);
  await expect(reloaded).toHaveAttribute('data-work-attempt', attemptId ?? '');
  await expect(reloaded).toHaveAttribute('data-work-attempt-state', 'finished');

  // And the read procedure agrees: exactly one attempt for the target, with the native session id.
  const listed = await postRpc(request, ATTEMPTS_LIST_PATH, {
    limit: 20,
    target: { harness: 'claude', sourceSessionId: SEEDED_TRANSCRIPT_ID },
  });
  const listOutput = parseWorkAttemptsListOutput(decodeRpcResponseBody(await listed.text()));
  expect(listOutput.ok && listOutput.data.attempts.map((attempt) => [attempt.attemptId, attempt.state])).toEqual([
    [attemptId, 'finished'],
  ]);
  expect(listOutput.ok && listOutput.data.attempts[0]?.nativeSessionId).toBe(WORK_ATTEMPT_FIXTURE_NATIVE_SESSION_ID);
  expect(listOutput.ok && listOutput.data.target).toMatchObject({ admitted: true, checkoutOrigin: 'desktop-worktree' });
});
