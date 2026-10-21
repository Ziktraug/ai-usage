import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';

/**
 * The Work resume surface on the production path. The disposable HOME carries a native Claude
 * Desktop session registry (`seedHarnessHome` with `claudeDesktopSessions: 'representative'`: 24
 * roots, 17 children, one unsupported file); the supervised engine collects it through
 * `claude.desktop-sessions` into `claude_desktop_sessions`, then observes the pull requests the
 * registry declared through the fixture's `gh` (`github.pull-requests`) and the checkouts it named
 * through `git status` (`checkouts.status`); `report-data` reads it all back for the
 * `work.attention` procedure; the browser renders what the procedure answered. Every business
 * assertion below rests on a value that crossed that chain. The server runs in live mode, so the
 * synthetic datasets of the demo and e2e runtimes are never consulted.
 *
 * Titles, questions and ids are the generator's
 * (`packages/report-core/src/claude-desktop-sessions.test-fixture.ts`); ages read against the pinned
 * production clock (2026-07-03T12:00Z), which the registry epoch is aligned with, in Europe/Paris.
 * The fixture `gh` answers OPEN / REVIEW_REQUIRED / no checks for every number, so each declared
 * pull request (#117, #118, #90) is observed awaiting review; the seeded repository is a clean
 * checkout and the worktree the blocked root named does not exist on disk.
 */

const CAPTURES_DIRECTORY_ENV = 'AI_USAGE_WORK_CAPTURES_DIR';
const DEFAULT_ORIGIN = 'http://127.0.0.1:4175';
const DESKTOP_COLLECTION_TIMEOUT_MS = 60_000;
const SOURCE_CONTROL_COMMAND_PATH = '/api/source-control/command';
const FACT_SOURCE_IDS = ['github.pull-requests', 'checkouts.status'] as const;
/** The registry seeds 24 roots; the three whose family had no activity in the 30-day window stay out. */
const ROOTS_IN_WINDOW = 21;
const MINIMUM_ROOTS = 20;
const NEEDS_YOU_ROOTS = 4;
const WAITING_ROOTS = 3;
const LEAD_ROOTS = 1;
const FOLDED_ROOTS = 10;
const RESTING_ROOTS = ROOTS_IN_WINDOW - NEEDS_YOU_ROOTS - WAITING_ROOTS - LEAD_ROOTS;
/** The registry declares three distinct pull requests (#117, #118, #90); the fixture gh answers each. */
const DECLARED_PULL_REQUESTS = 3;
const REGISTRY_FILES = 41;
const PARSED_FILES = 40;
const BLOCKED_ROOT_ID = 'local_fixture-blocked-root';
const BLOCKED_TITLE = 'Fixture: investigate checkout 3';
const BLOCKED_QUESTION = 'Confirm whether the fixture should keep checkout 3 or delete it.';
const BLOCKED_CHILD_TITLES = ['Fixture: child two', 'Fixture: grandchild of checkout 3'];
const BLOCKED_DECLARED_AT = 'Jul 03, 2026, 13:00 GMT+2';
const MISSING_WORKTREE_PATTERN = /Checkout checkout-3 could not be read at \S+ \(missing\)\./;
const SATISFIED_ROOT_ID = 'local_fixture-satisfied-root';
const SATISFIED_TITLE = 'Fixture: collector branch awaiting a pull request';
const SATISFIED_CHILD_TITLE = 'Fixture: open the collector pull request';
const SATISFIED_INTERPRETATION =
  'Asked to act on a pull request; the same family of sessions later declared fixture/ai-usage#117 (OPEN) and GitHub showed fixture/ai-usage#117 (OPEN) at ';
const MERGED_BEFORE_TITLE = 'Fixture: push the merged fix';
const MERGED_BEFORE_INTERPRETATION = 'Asked to act on a pull request; GitHub showed fixture/ai-usage#90 (OPEN) at ';
const COMPLETED_ROOT_ID = 'local_fixture-completed-root';
const COMPLETED_TITLE = 'Fixture: ship the collector';
const COMPLETED_INTERPRETATION =
  'fixture/ai-usage#118 is open and awaiting review (REVIEW_REQUIRED; checks unknown) as of ';
const PROPOSAL_ROOT_ID = 'local_fixture-proposal-root';
const PROPOSAL_TITLE = 'Fixture: proposals pending';
const UNSUPPORTED_ROOT_ID = 'local_fixture-unsupported';
const UNSUPPORTED_TITLE = 'Fixture: unknown shape';
const UNSUPPORTED_INTERPRETATION =
  'The Desktop registry file has a shape this reader does not support: Unsupported field shape: postTurnSummary.status_category.';
const NO_TRANSCRIPT_ROOT_ID = 'local_fixture-no-transcript-root';
const NO_TRANSCRIPT_TITLE = 'Fixture: no transcript';
const TRANSCRIPT_GAP = 'No collected Session matches this transcript id in the current report.';
const TRANSCRIPT_MISSING = 'Transcript not collected yet; there is no session detail to open.';
const NO_REVIEW_TARGET = 'No collected transcript identifies a review target for this root.';
const NO_DECLARATION_TEXT =
  'No executor is declared. Add a routing.executors[] entry to the home config to authorize a harness; quota and executor observations alone never qualify a candidate.';
const DECLARE_ACTION_PATTERN = /Add routing\.executors\[\] for claude:<accountScope> with authorization 'allowed'/;
const EVIDENCE_COUNT_PATTERN = /Candidate evidence \((\d+)\)/;
const SESSION_DETAIL_PATTERN = /^\/sessions\//;
const PULL_REQUESTS_OBSERVED_PATTERN = /Pull requests: [1-9]\d*\s+observed/;
const CHECKOUTS_OBSERVED_PATTERN = /Checkouts: [1-9]\d*\s+observed/;
const RPC_PATH_PREFIX = '/rpc/';
const WORK_ATTENTION_PATH = '/rpc/work/attention';

const waitForHydratedWork = async (page: Page): Promise<void> => {
  await expect(page.locator('main[data-route-shell="work"][data-work-hydrated="true"]')).toBeVisible({
    timeout: 15_000,
  });
};
const rowNamed = (page: Page, title: string): Locator =>
  page.locator('[data-work-root]').filter({ has: page.getByText(title, { exact: true }) });
const sectionRows = (page: Page, kind: string): Locator =>
  page.getByRole('main').locator(`[data-work-section="${kind}"] [data-work-root]`);
const expectNoOverflow = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
};
const expectAxeClean = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
};
/** Overlay animations blend colours while they run; axe reads the settled frame. */
const settleAnimations = async (page: Page): Promise<void> => {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
};
const searchParam = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);

/** Screenshots are a review artefact, written only where the operator asks; the assertions never read them. */
const capture = async (page: Page, name: string, options: { readonly fullPage: boolean }): Promise<void> => {
  const directory = process.env[CAPTURES_DIRECTORY_ENV];
  if (!directory) {
    return;
  }
  await mkdir(directory, { recursive: true });
  await page.screenshot({ fullPage: options.fullPage, path: path.join(directory, name) });
};

interface TrackedRequests {
  /** Request origins other than the fixture's own; the Work view must never leave the machine. */
  readonly offsite: string[];
  readonly posts: string[];
}

const trackRequests = (page: Page, origin: string): TrackedRequests => {
  const tracked: TrackedRequests = { offsite: [], posts: [] };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) {
      tracked.offsite.push(url.href);
    }
    if (request.method() === 'POST') {
      tracked.posts.push(url.pathname);
    }
  });
  return tracked;
};

/**
 * The operator's "Run now" for the two fact producers. They learn which pull requests and
 * checkouts to observe from the Desktop registry in the store, but at engine start they run a few
 * milliseconds before `claude.desktop-sessions` has imported anything (catalogue order), observe
 * nothing, and nothing wakes them before their 10- and 5-minute cadence. Sending the command once
 * the registry is stored is what an operator would do from /sources; the facts still come from the
 * fixture `gh` and from `git status` through the engine and the store.
 */
const runFactSourcesNow = async (request: APIRequestContext, origin: string): Promise<void> => {
  for (const sourceId of FACT_SOURCE_IDS) {
    const response = await request.post(SOURCE_CONTROL_COMMAND_PATH, {
      data: { command: 'run-now', sourceId },
      headers: { origin },
    });
    if (!response.ok()) {
      throw new Error(`run-now ${sourceId} answered ${response.status()}`);
    }
  }
};

/**
 * The engine runs `claude.desktop-sessions` at startup and publishes the first served revision
 * right after its first collection cycle; the join of the blocked root to its transcript needs
 * both, and the external facts need the producers to have run after the registry landed. Polling
 * the production procedure itself keeps the gate on the same path the page reads.
 */
const waitForCollectedWork = async (request: APIRequestContext, origin: string): Promise<void> => {
  let factRunRequested = false;
  await expect
    .poll(
      async () => {
        const response = await request.post(WORK_ATTENTION_PATH, {
          data: encodeRpcResponseBody({ limit: 100, machineId: null }),
          headers: { 'content-type': 'application/json' },
        });
        if (!response.ok()) {
          return { status: response.status() };
        }
        const output = parseWorkAttentionOutput(decodeRpcResponseBody(await response.text()));
        if (!output.ok) {
          return { error: output.error.tag };
        }
        const { coverage } = output.data;
        const collected = coverage.desktopSessions.collectedAt !== null;
        if (collected && !factRunRequested && coverage.pullRequests.observed < DECLARED_PULL_REQUESTS) {
          factRunRequested = true;
          await runFactSourcesNow(request, origin);
        }
        return {
          checkoutsObserved: coverage.checkouts.lastRunAt !== null && coverage.checkouts.observed >= 1,
          collected,
          joined: coverage.sessions.revision !== null,
          pullRequestsObserved: coverage.pullRequests.observed >= DECLARED_PULL_REQUESTS,
          roots: output.data.roots.length >= MINIMUM_ROOTS,
        };
      },
      {
        message: 'The engine must collect the seeded registry, publish a revision and observe the declared facts',
        timeout: DESKTOP_COLLECTION_TIMEOUT_MS,
      },
    )
    .toEqual({ checkoutsObserved: true, collected: true, joined: true, pullRequestsObserved: true, roots: true });
};

const openWorkRoot = async (page: Page, rootId: string): Promise<Locator> => {
  await page.goto(`/work?root=${rootId}`);
  await waitForHydratedWork(page);
  const aside = page.getByRole('main').locator('[data-work-aside]');
  await expect(aside.locator('[data-work-detail]')).toHaveAttribute('data-work-detail', rootId);
  return aside;
};

test('renders the collected registry and its observed facts as a resume surface, searchable, with history-safe detail and routing', async ({
  baseURL,
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const origin = new URL(baseURL ?? DEFAULT_ORIGIN).origin;
  const tracked = trackRequests(page, origin);
  await waitForCollectedWork(request, origin);
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work', exact: true })).toBeVisible();

  // Coverage is the producers' own completeness: 41 registry files seen, 40 parsed, 1 unsupported;
  // the declared pull requests observed through gh; the named checkouts read with git.
  const coverage = main.locator('[data-work-coverage]');
  await expect(coverage).toContainText('Desktop sessions: collected');
  await expect(coverage).toContainText(`${PARSED_FILES} of ${REGISTRY_FILES} files parsed · 1 unsupported`);
  await expect(coverage).toContainText(PULL_REQUESTS_OBSERVED_PATTERN);
  await expect(coverage).toContainText(CHECKOUTS_OBSERVED_PATTERN);
  await expect(coverage).not.toContainText('observation disabled');
  await expect(coverage).not.toContainText('Synthetic dataset');
  await expect(main.getByText('Declared outcomes are unavailable')).toHaveCount(0);

  // The four sections: requests nobody answered, pull requests GitHub showed awaiting review,
  // open proposals, and the rest.
  for (const name of ['Needs you', 'Waiting on others', 'Leads', 'Recent, nothing pending']) {
    await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  await expect(
    main.getByRole('status').filter({ hasText: `${ROOTS_IN_WINDOW} of ${ROOTS_IN_WINDOW} roots shown` }),
  ).toBeVisible();
  await expect(sectionRows(page, 'human-request')).toHaveCount(NEEDS_YOU_ROOTS);
  await expect(sectionRows(page, 'external-wait')).toHaveCount(WAITING_ROOTS);
  await expect(sectionRows(page, 'optional-lead')).toHaveCount(LEAD_ROOTS);
  await expect(sectionRows(page, 'none')).toHaveCount(FOLDED_ROOTS);
  await capture(page, 'work-prod-1440-arrival.png', { fullPage: true });
  await main.locator('[data-work-section="none"] button', { hasText: `Show all ${RESTING_ROOTS}` }).click();
  const rows = main.locator('[data-work-root]');
  await expect(rows).toHaveCount(ROOTS_IN_WINDOW);
  expect(await rows.count()).toBeGreaterThanOrEqual(MINIMUM_ROOTS);

  // Children fold under their attested parent; none of them is a row.
  for (const title of [...BLOCKED_CHILD_TITLES, SATISFIED_CHILD_TITLE]) {
    await expect(rowNamed(page, title)).toHaveCount(0);
  }

  // The blocked root carries its own question in the row, dated by the pinned clock.
  const blocked = rowNamed(page, BLOCKED_TITLE);
  await expect(blocked).toHaveCount(1);
  await expect(main.locator('[data-work-section="human-request"]').locator(blocked)).toHaveCount(1);
  await expect(blocked).toContainText(BLOCKED_QUESTION);
  await expect(blocked).toContainText('blocked · 1 h ago');
  await expect(blocked).toContainText('children 3');

  // Every pull request the registry declared was observed on GitHub awaiting review: the roots
  // whose family declared one wait on others, with the observed state as their chip. The request
  // a declared pull request answered therefore leaves "Needs you".
  for (const [title, number] of [
    [COMPLETED_TITLE, 118],
    [SATISFIED_TITLE, 117],
    [MERGED_BEFORE_TITLE, 90],
  ] as const) {
    const row = rowNamed(page, title);
    await expect(main.locator('[data-work-section="external-wait"]').locator(row)).toHaveCount(1);
    await expect(row).toContainText(`PR #${number} review required`);
  }
  await expect(
    main.locator('[data-work-section="human-request"]').locator(rowNamed(page, SATISFIED_TITLE)),
  ).toHaveCount(0);
  await expect(main.locator('[data-work-section="optional-lead"]').locator(rowNamed(page, PROPOSAL_TITLE))).toHaveCount(
    1,
  );
  await expect(rowNamed(page, PROPOSAL_TITLE)).toContainText('proposals 2 open / 2 resolved');
  await expectAxeClean(page);

  // Search narrows the sections and lands in the address.
  await page.getByRole('searchbox').fill('investigate');
  await expect(main.getByRole('status').filter({ hasText: `1 of ${ROOTS_IN_WINDOW} roots shown` })).toBeVisible();
  await expect.poll(() => searchParam(page, 'q')).toBe('investigate');
  await expect(blocked).toHaveCount(1);

  // The detail: the declaration with its exact local date, facts grouped by source (the Desktop
  // metadata and what git found on the paths the family named), the folded children, the joined
  // transcript and the routing simulation bound to that transcript.
  await blocked.click();
  await expect.poll(() => searchParam(page, 'root')).toBe(BLOCKED_ROOT_ID);
  const aside = main.locator('[data-work-aside]');
  await expect(aside.locator('[data-work-detail]')).toHaveAttribute('data-work-detail', BLOCKED_ROOT_ID);
  await expect(aside.locator('[data-work-question]')).toHaveText(BLOCKED_QUESTION);
  await expect(aside).toContainText(
    `Declared by the session at ${BLOCKED_DECLARED_AT}; its current state is unobserved.`,
  );
  await expect(aside).toContainText(`The session stopped on a question: ${BLOCKED_QUESTION}`);
  await expect(aside).toContainText(MISSING_WORKTREE_PATTERN);
  await expect(aside.getByRole('heading', { level: 3, name: 'Facts by source' })).toBeVisible();
  await expect(aside.getByRole('heading', { level: 4, name: 'Claude Desktop metadata' })).toBeVisible();
  await expect(aside.getByRole('heading', { level: 4, name: 'Local checkout' })).toBeVisible();
  await expect(aside).toContainText('Declared blocked: Stopped at a question the fixture cannot answer alone.');
  await expect(aside).toContainText('Wrote branch fixture/checkout-3');
  await expect(aside).toContainText('/work/fixture on fixture-main: clean');
  await expect(aside).toContainText('/.claude/worktrees/checkout-3: missing');
  await expect(aside).toContainText('3 child sessions · 0 blocked · 1 review ready · 2 completed');
  for (const title of BLOCKED_CHILD_TITLES) {
    await expect(aside.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(aside.getByRole('link', { name: 'Open session detail' })).toHaveAttribute(
    'href',
    SESSION_DETAIL_PATTERN,
  );

  // Routing: the disposable HOME declares no executor, so the panel can only name what would
  // qualify one; the simulation chooses nobody and starts nothing.
  await expect(aside.getByRole('heading', { level: 3, name: 'Review assignment simulation' })).toBeVisible();
  await expect(aside).toContainText(`Simulates a read-only review of “${BLOCKED_TITLE}” on its collected Session.`);
  await expect(aside).toContainText(NO_DECLARATION_TEXT);
  const evidence = aside.locator('summary').filter({ hasText: EVIDENCE_COUNT_PATTERN });
  await expect(evidence).toBeVisible();
  const evidenceCount = Number(EVIDENCE_COUNT_PATTERN.exec((await evidence.innerText()) ?? '')?.[1] ?? Number.NaN);
  expect(Number.isSafeInteger(evidenceCount)).toBe(true);
  // A candidate exists only when a quota stream was stored for this machine, which depends on the
  // host's Claude CLI; either way nothing is authorized, and a stored candidate names the declaration to add.
  testInfo.annotations.push({ description: String(evidenceCount), type: 'routing-candidates' });
  if (evidenceCount > 0) {
    await evidence.click();
    await expect(aside).toContainText(DECLARE_ACTION_PATTERN);
    await expect(aside).toContainText('Authorization: unknown · unknown');
  }
  await aside.getByRole('button', { name: 'Run simulation', exact: true }).click();
  const result = aside.getByRole('region', { name: 'Routing result' });
  await expect(result.getByRole('heading', { level: 3, name: 'No eligible candidate' })).toBeVisible();
  await expect(result).toContainText('No execution was started');
  await expect(result).not.toContainText('Real recommendation');
  await expect(result).not.toContainText('Conditional (missing');
  await expect(result).not.toContainText('Chosen:');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectAxeClean(page);
  await capture(page, 'work-prod-1440-detail-blocked.png', { fullPage: true });

  // Closing travels back: the search survives and focus returns to the row.
  await page.goBack();
  await expect.poll(() => searchParam(page, 'root')).toBeNull();
  expect(searchParam(page, 'q')).toBe('investigate');
  await expect(aside.locator('[data-work-detail]')).toHaveCount(0);
  await expect(blocked).toBeFocused();

  // Nothing left the machine, and the dataset came through the contract procedure.
  expect(tracked.offsite).toEqual([]);
  expect(tracked.posts).toContain(WORK_ATTENTION_PATH);
  expect(tracked.posts.filter((pathname) => !pathname.startsWith(RPC_PATH_PREFIX))).toEqual([]);
});

test('confronts each seeded declaration with the facts and coverage the chain collected', async ({
  baseURL,
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForCollectedWork(request, new URL(baseURL ?? DEFAULT_ORIGIN).origin);
  const main = page.getByRole('main');

  // Asked for a pull request; its child declared one and GitHub showed it open: the request is
  // answered, and the open pull request now waits on others.
  const satisfied = await openWorkRoot(page, SATISFIED_ROOT_ID);
  await expect(satisfied.getByRole('heading', { level: 2, name: SATISFIED_TITLE })).toBeVisible();
  await expect(satisfied).toContainText(SATISFIED_INTERPRETATION);
  await expect(satisfied).toContainText(
    'The link rests on a pull request observed on GitHub for the PR this session family declared',
  );
  await expect(satisfied).toContainText(
    'fixture/ai-usage#117 is open and awaiting review (REVIEW_REQUIRED; checks unknown) as of ',
  );
  await expect(satisfied).toContainText('Declared PR #117 open on fixture/ai-usage (fixture/pr-117)');
  await expect(satisfied.getByRole('heading', { level: 4, name: 'GitHub' })).toBeVisible();
  await expect(satisfied).toContainText('PR #117 open, checks unknown, review required');
  await expect(satisfied.getByText(SATISFIED_CHILD_TITLE, { exact: true })).toBeVisible();
  await expect(main.locator('[data-work-section="external-wait"] [data-work-root][aria-current="true"]')).toHaveCount(
    1,
  );

  // A completed root whose declared pull request GitHub shows awaiting review.
  const completed = await openWorkRoot(page, COMPLETED_ROOT_ID);
  await expect(completed.getByRole('heading', { level: 2, name: COMPLETED_TITLE })).toBeVisible();
  await expect(completed).toContainText(COMPLETED_INTERPRETATION);
  await expect(completed).toContainText('Declared PR #118 open on fixture/ai-usage (fixture/pr-118)');
  await expect(completed).toContainText('PR #118 open, checks unknown, review required');
  await expect(completed).toContainText(TRANSCRIPT_GAP);

  // The fixture gh shows the pull request a child declared merged as still open, after the
  // request that asked to merge it: GitHub's word answers the request and the root waits on others.
  const mergedBefore = rowNamed(page, MERGED_BEFORE_TITLE);
  await expect(main.locator('[data-work-section="external-wait"]').locator(mergedBefore)).toHaveCount(1);
  await mergedBefore.click();
  await expect(main.locator('[data-work-aside]')).toContainText(MERGED_BEFORE_INTERPRETATION);
  await expect(main.locator('[data-work-aside]')).toContainText(
    'Declared PR #90 merged on fixture/ai-usage (fixture/pr-90)',
  );

  // A registry file this reader does not support keeps its identity and says what was not read.
  const unsupported = await openWorkRoot(page, UNSUPPORTED_ROOT_ID);
  await expect(unsupported.getByRole('heading', { level: 2, name: UNSUPPORTED_TITLE })).toBeVisible();
  await expect(unsupported).toContainText('No turn declaration was collected for this root.');
  await expect(unsupported).toContainText(UNSUPPORTED_INTERPRETATION);

  // A transcript the report never collected: the gap is named, nothing is opened or simulated.
  const noTranscript = await openWorkRoot(page, NO_TRANSCRIPT_ROOT_ID);
  await expect(noTranscript.getByRole('heading', { level: 2, name: NO_TRANSCRIPT_TITLE })).toBeVisible();
  await expect(noTranscript).toContainText(TRANSCRIPT_GAP);
  await expect(noTranscript).toContainText(TRANSCRIPT_MISSING);
  await expect(noTranscript).toContainText(NO_REVIEW_TARGET);
  await expect(noTranscript.getByRole('link', { name: 'Open session detail' })).toHaveCount(0);
  await expect(noTranscript.getByRole('button', { name: 'Run simulation' })).toHaveCount(0);

  // Open proposals are a lead, resolved ones are counted apart.
  const proposal = await openWorkRoot(page, PROPOSAL_ROOT_ID);
  await expect(proposal).toContainText('2 proposals are open and unanswered.');
  await expect(proposal).toContainText('1 proposal started, 1 proposal dismissed');
  await expect(main.locator('[data-work-section="optional-lead"] [data-work-root][aria-current="true"]')).toHaveCount(
    1,
  );
  await expectAxeClean(page);
});

test('lists the Desktop registry as a detected source whose last run succeeded', async ({ baseURL, page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForCollectedWork(request, new URL(baseURL ?? DEFAULT_ORIGIN).origin);
  await page.goto('/sources');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const healthy = page.locator('[data-healthy-source-summary]');
  await healthy.locator('> summary').click();
  const row = page
    .locator('[data-source-card], [data-healthy-source-row]')
    .filter({ has: page.getByRole('heading', { level: 3, name: 'Claude Desktop sessions' }) });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('claude.desktop-sessions', { exact: true })).toBeVisible();
  await expect(row.locator('[data-source-health]')).toHaveText('Ready');
  await expect(row.getByRole('checkbox', { name: 'Enabled' })).toBeChecked();
  await capture(page, 'sources-prod-1440.png', { fullPage: true });

  // The Work view repeats the same source state beside its dataset.
  await page.goto('/work');
  await waitForHydratedWork(page);
  const sources = page.getByRole('main').locator('details[data-work-sources]');
  await sources.locator('> summary').click();
  await expect(sources.locator('li').filter({ hasText: 'Claude Desktop sessions: Ready' })).toContainText(
    'The last run completed successfully.',
  );
});

test('opens the collected root as a drawer at 390px without overflow', async ({ baseURL, page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForCollectedWork(request, new URL(baseURL ?? DEFAULT_ORIGIN).origin);
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work', exact: true })).toBeVisible();
  await expect(main.locator('[data-work-aside]')).toBeHidden();
  await expectNoOverflow(page);
  await expectAxeClean(page);
  await rowNamed(page, BLOCKED_TITLE).click();
  const dialog = page.getByRole('dialog', { name: 'Selected root', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-work-question]')).toHaveText(BLOCKED_QUESTION);
  await expect(dialog).toContainText(`Declared by the session at ${BLOCKED_DECLARED_AT}`);
  await expect(dialog.getByRole('heading', { level: 3, name: 'Review assignment simulation' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close detail', exact: true })).toBeFocused();
  await settleAnimations(page);
  await expectNoOverflow(page);
  await expectAxeClean(page);
  await capture(page, 'work-prod-390-drawer.png', { fullPage: false });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(() => searchParam(page, 'root')).toBeNull();
});
