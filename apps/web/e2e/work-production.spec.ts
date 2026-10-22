import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WORK_ATTENTION_BOUNDS } from '@ai-usage/report-core/work-attention';
import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';

/**
 * The Work resume surface on the production path. The disposable HOME carries a native Claude
 * Desktop session registry (`seedHarnessHome` with `claudeDesktopSessions: 'representative'`: 30
 * roots, 20 children, one unsupported file); the supervised engine collects it through
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
 * checkout and none of the worktrees the registry names (`checkout-3`, the children's own) exists
 * on disk. No Jira tooling is on the fixture's PATH, so the Jira producer observes nothing. Every
 * root is labelled by the repository directory, joined or not; the one joined root shows the
 * report's own, machine-qualified label apart ("report project: …") and nowhere else.
 *
 * The same HOME seeds 205 Codex rollouts (the session-scroll fixture: a root with a delegated child
 * on 2026-07-02 and 203 sessions in `/work/fixture-pagination` the morning of the pinned day).
 * Codex declares no turn status (ADR 0059): the read takes the Codex budget of its most recent
 * served families (20), ranks them after every Desktop root, each with its wait unknown; the other
 * 184 are counted ("20 of 204 Codex campaigns shown"), never shown as nothing pending.
 */

const CAPTURES_DIRECTORY_ENV = 'AI_USAGE_WORK_CAPTURES_DIR';
const DEFAULT_ORIGIN = 'http://127.0.0.1:4175';
const DESKTOP_COLLECTION_TIMEOUT_MS = 60_000;
/**
 * The registry seeds 30 roots. The 30-day window hides the one older root whose family declared
 * nothing pending; the two older roots still blocked on a question stay visible.
 */
const DESKTOP_ROOTS_SHOWN = 29;
const HIDDEN_ROOTS = 1;
/** The page limit the Work view asks for; the Desktop roots and the Codex budget both fit in it. */
const PAGE_LIMIT = 100;
/** The Codex budget (ADR 0059): the most recent campaigns only, whatever the page leaves free. */
const CODEX_ROOTS_SHOWN = WORK_ATTENTION_BOUNDS.maxCodexRoots;
const ROOTS_SHOWN = DESKTOP_ROOTS_SHOWN + CODEX_ROOTS_SHOWN;
/** 203 standalone Codex sessions and the root family, all active in the window. */
const CODEX_FAMILIES = 204;
const DESKTOP_ROOTS = DESKTOP_ROOTS_SHOWN + HIDDEN_ROOTS;
/** Every campaign the Codex budget left out: the page limit itself cuts nothing here. */
const CODEX_BEYOND_BUDGET = CODEX_FAMILIES - CODEX_ROOTS_SHOWN;
const CODEX_TITLE = 'Codex · no declared wait read';
const CODEX_PROJECT_LABEL = 'fixture-pagination';
const CODEX_COVERAGE = `Codex · sessions only, no declared waits: ${CODEX_ROOTS_SHOWN} of ${CODEX_FAMILIES} Codex campaigns shown, active in the last 30 days (served report)`;
const CODEX_CHIP_PATTERN = new RegExp(`^Codex\\s*${CODEX_ROOTS_SHOWN}$`);
const MINIMUM_ROOTS = 20;
/**
 * Seven current blocks and five older declarations to reconsider: two something later may have
 * answered, three untouched for more than a week (ADR 0056 age tier). A single sweep sees only the
 * final registry files: the replied root, whose reply only an earlier sweep can date, stays a
 * current block here (ADR 0056); the e2e fixture and the history chain test replay the earlier sweep.
 */
const NEEDS_YOU_ROOTS = 13;
const RECONSIDER_ROOTS = 6;
const WAITING_ROOTS = 1;
const LEAD_ROOTS = 2;
const FOLDED_ROOTS = 10;
const RESTING_ROOTS = DESKTOP_ROOTS_SHOWN - NEEDS_YOU_ROOTS - WAITING_ROOTS - LEAD_ROOTS;
const RESTING_TITLE = 'Recent · no pending declaration read';
/** The registry declares four distinct pull requests (#117, #118, #90, #131); the fixture gh answers each. */
const DECLARED_PULL_REQUESTS = 4;
const REGISTRY_FILES = 50;
const PARSED_FILES = 49;
const BLOCKED_ROOT_ID = 'local_fixture-blocked-root';
/** Every registry session sits in the seeded repository (`…/work/fixture`) or a worktree under it. */
const PROJECT_LABEL = 'fixture';
/** The served report's own label for the seeded transcript the blocked root joins to. */
const SERVED_PROJECT_LABEL = 'fixture — Production fixture machine';
/** The project chip a worktree directory used to produce; no root is labelled by its worktree any more. */
const WORKTREE_PROJECT_CHIP_PATTERN = /^checkout-3 \d+$/;
const BLOCKED_TITLE = 'Fixture: investigate checkout 3';
const BLOCKED_QUESTION = 'Confirm whether the fixture should keep checkout 3 or delete it.';
const BLOCKED_CHILD_TITLES = ['Fixture: child two', 'Fixture: grandchild of checkout 3'];
const BLOCKED_DECLARED_AT = 'Jul 03, 2026, 13:00 GMT+2';
// A worktree removed since its session is a fact about that session, stated in words, never a failed read.
const MISSING_WORKTREE = '/.claude/worktrees/checkout-3: no longer on disk (removed since the session)';
const CHECKOUTS_FAILED_PATTERN = /Checkouts: .* failed/;
const CHECKOUTS_UNREAD_PATTERN =
  /Checkouts: [1-9]\d*\s+observed, [1-9]\d* not read\s[^·]*· of the checkouts the roots shown name: [1-9]\d* no longer on disk \(removed since the session\)/;
const SATISFIED_ROOT_ID = 'local_fixture-satisfied-root';
const SATISFIED_TITLE = 'Fixture: collector branch awaiting a pull request';
const SATISFIED_CHILD_TITLE = 'Fixture: open the collector pull request';
const SATISFIED_INTERPRETATION =
  'Possibly answered elsewhere: fixture/ai-usage#117 (OPEN) listed by a child session (last active at 2026-07-03T09:00:00.000Z); fixture/ai-usage#117 (OPEN) observed on GitHub at ';
const RECONSIDERED_UNCERTAINTY = 'This does not prove it is the same work; the question stays yours until you confirm.';
const MERGED_BEFORE_TITLE = 'Fixture: push the merged fix';
const MERGED_BEFORE_INTERPRETATION =
  'fixture/ai-usage#90 is open and awaiting review (REVIEW_REQUIRED; checks unknown) as of ';
const STALE_TITLE = 'Fixture: stale declaration';
const COMPLETED_ROOT_ID = 'local_fixture-completed-root';
const COMPLETED_TITLE = 'Fixture: ship the collector';
const COMPLETED_INTERPRETATION =
  'fixture/ai-usage#118 is open and awaiting review (REVIEW_REQUIRED; checks unknown) as of ';
const PROPOSAL_ROOT_ID = 'local_fixture-proposal-root';
const PROPOSAL_TITLE = 'Fixture: proposals pending';
const CONTINUED_TITLE = 'Fixture: toolbar refresh';
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
const SESSION_DETAIL_PATTERN_URL = /\/sessions\//;
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
 * The engine's first cycle collects `claude.desktop-sessions` ahead of the fact producers and
 * wakes them when the registry lands, so one startup cycle observes the declared pull requests
 * (fixture gh) and the named checkouts (git); the first served revision follows the same cycle
 * and joins the blocked root to its transcript. The gate sends no command: polling the production
 * procedure itself keeps it on the same path the page reads, and a timeout here would mean the
 * startup ordering regressed.
 */
const waitForCollectedWork = async (request: APIRequestContext): Promise<void> => {
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
        return {
          checkoutsObserved: coverage.checkouts.lastRunAt !== null && coverage.checkouts.observed >= 1,
          collected: coverage.desktopSessions.collectedAt !== null,
          joined: coverage.sessions.revision !== null,
          pullRequestsObserved: coverage.pullRequests.observed >= DECLARED_PULL_REQUESTS,
          roots: output.data.roots.length >= MINIMUM_ROOTS,
        };
      },
      {
        message:
          'One engine startup cycle must collect the registry, publish a revision and observe the declared facts',
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
  const tracked = trackRequests(page, new URL(baseURL ?? DEFAULT_ORIGIN).origin);
  await waitForCollectedWork(request);
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Work', exact: true })).toBeVisible();

  // Coverage is the producers' own completeness: 41 registry files seen, 40 parsed, 1 unsupported;
  // the declared pull requests observed through gh; the named checkouts read with git; no Jira
  // tooling; one older root without a pending declaration behind the window.
  const coverage = main.locator('[data-work-coverage]');
  await expect(coverage).toContainText('Claude Desktop registry · declared waits: collected');
  await expect(coverage).toContainText(`${PARSED_FILES} of ${REGISTRY_FILES} files parsed · 1 unsupported`);
  await expect(coverage.locator('[data-work-harness-coverage="codex"]')).toHaveText(CODEX_COVERAGE);
  await expect(coverage.locator('[data-work-harness-coverage="other"]')).toHaveText('Other harnesses: not read here');
  await expect(coverage).toContainText(PULL_REQUESTS_OBSERVED_PATTERN);
  await expect(coverage).toContainText(CHECKOUTS_OBSERVED_PATTERN);
  await expect(coverage).toContainText(CHECKOUTS_UNREAD_PATTERN);
  await expect(coverage).not.toContainText(CHECKOUTS_FAILED_PATTERN);
  await expect(coverage.locator('[data-work-jira-coverage]')).toContainText('Jira: not observed');
  await expect(coverage.locator('[data-work-window]')).toContainText(
    `${HIDDEN_ROOTS} older root without pending declarations hidden (30-day window)`,
  );
  await expect(coverage).not.toContainText('observation disabled');
  await expect(coverage).not.toContainText('Synthetic dataset');
  await expect(main.getByText('Declared outcomes are unavailable')).toHaveCount(0);

  // The five sections: questions and review requests (a later pull request never demotes one),
  // pull requests GitHub showed awaiting review, open proposals, the rest, and Codex apart.
  for (const name of ['Needs you', 'Waiting on others', 'Leads', RESTING_TITLE, CODEX_TITLE]) {
    await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  await expect(main.locator('[data-work-section="human-request"] header')).toContainText(
    'Older declarations to reconsider follow: something later may have answered them, without proof, or nothing happened in their session for over 7 days.',
  );
  await expect(main.locator('[data-work-section="none"] header')).toContainText(
    'Nothing pending was read here; that is not proof that nothing is pending.',
  );
  await expect(main.locator('[data-work-search-coverage]')).toHaveText(
    `${ROOTS_SHOWN} roots shown · ${HIDDEN_ROOTS} older root hidden (30-day window) · ${CODEX_BEYOND_BUDGET} Codex campaigns beyond the ${CODEX_ROOTS_SHOWN}-campaign Codex budget.`,
  );
  await expect(sectionRows(page, 'human-request')).toHaveCount(NEEDS_YOU_ROOTS);
  await expect(sectionRows(page, 'external-wait')).toHaveCount(WAITING_ROOTS);
  await expect(sectionRows(page, 'optional-lead')).toHaveCount(LEAD_ROOTS);
  await expect(sectionRows(page, 'none')).toHaveCount(FOLDED_ROOTS);
  await expect(sectionRows(page, 'not-observable')).toHaveCount(FOLDED_ROOTS);
  await capture(page, 'work-prod-1440-arrival.png', { fullPage: true });
  await main
    .locator('[data-work-section="none"] button', { hasText: `Show all ${RESTING_ROOTS} in ${RESTING_TITLE}` })
    .click();
  const rows = main.locator('[data-work-root]');
  // Every Desktop root, and the Codex section still folded at ten.
  await expect(rows).toHaveCount(DESKTOP_ROOTS_SHOWN + FOLDED_ROOTS);
  expect(await rows.count()).toBeGreaterThanOrEqual(MINIMUM_ROOTS);

  // Children fold under their attested parent; none of them is a row.
  for (const title of [...BLOCKED_CHILD_TITLES, SATISFIED_CHILD_TITLE]) {
    await expect(rowNamed(page, title)).toHaveCount(0);
  }

  // The blocked root carries its own question in the row, dated by the pinned clock. It ran in a
  // worktree and is the one root joined to a transcript, yet its project is the repository like
  // every other Desktop root's: the project filter offers the repository and the directory the
  // Codex sessions recorded, never the worktree.
  const blocked = rowNamed(page, BLOCKED_TITLE);
  await expect(blocked).toHaveCount(1);
  await expect(main.locator('[data-work-section="human-request"]').locator(blocked)).toHaveCount(1);
  await expect(blocked).toContainText(BLOCKED_QUESTION);
  await expect(blocked).toContainText(`${PROJECT_LABEL} · fixture/checkout-3 (checkout-3)`);
  await expect(blocked).toContainText('blocked · 1 h ago');
  await expect(blocked).toContainText('children 3');
  await expect(blocked).toContainText('checkout no longer on disk (removed since the session)');
  await expect(blocked).not.toContainText('auto title');
  const filters = main.locator('[data-work-filters]');
  await expect(
    filters.getByRole('button', { name: new RegExp(`^${PROJECT_LABEL}\\s*${DESKTOP_ROOTS_SHOWN}$`) }),
  ).toBeVisible();
  await expect(
    filters.getByRole('button', { name: new RegExp(`^${CODEX_PROJECT_LABEL}\\s*${CODEX_ROOTS_SHOWN}$`) }),
  ).toBeVisible();
  await expect(main.getByRole('button', { name: WORKTREE_PROJECT_CHIP_PATTERN })).toHaveCount(0);

  // Every pull request the registry declared was observed on GitHub awaiting review, dated by the
  // observation. The completed root's pull request waits on others; the two blocked roots keep
  // their question in "Needs you": the one whose child declared #117 after the question ranks
  // last, marked "possibly answered"; the one whose child declared #90 before the question is not.
  const completed = rowNamed(page, COMPLETED_TITLE);
  await expect(main.locator('[data-work-section="external-wait"]').locator(completed)).toHaveCount(1);
  await expect(completed).toContainText('PR #118 review required · observed');
  const needsYou = sectionRows(page, 'human-request');
  const toReconsider = main.locator('[data-work-reconsider] [data-work-root]');
  await expect(toReconsider).toHaveCount(RECONSIDER_ROOTS);
  await expect(toReconsider.first()).toContainText(SATISFIED_TITLE);
  await expect(toReconsider.first()).toContainText('possibly answered · PR #117');
  await expect(toReconsider.first()).toContainText('PR #117 review required · observed');
  await expect(toReconsider.nth(1)).toContainText(CONTINUED_TITLE);
  // Untouched for more than a week: dated, last, still a question.
  await expect(needsYou.last()).toContainText(STALE_TITLE);
  const mergedBefore = rowNamed(page, MERGED_BEFORE_TITLE);
  await expect(main.locator('[data-work-section="human-request"]').locator(mergedBefore)).toHaveCount(1);
  await expect(mergedBefore).toContainText('PR #90 review required · observed');
  await expect(mergedBefore).not.toContainText('possibly answered');
  await expect(
    main.locator('[data-work-section="external-wait"]').locator(rowNamed(page, SATISFIED_TITLE)),
  ).toHaveCount(0);
  // A 40-day-old question stays visible past the window, set apart and dated; the older completed
  // root is hidden.
  const stale = rowNamed(page, STALE_TITLE);
  await expect(main.locator('[data-work-section="human-request"]').locator(stale)).toHaveCount(1);
  await expect(main.locator('[data-work-reconsider]').locator(stale)).toHaveCount(1);
  await expect(stale).toContainText('blocked · 40 d ago, no activity since');
  await expect(main.locator('[data-work-section="optional-lead"]').locator(rowNamed(page, PROPOSAL_TITLE))).toHaveCount(
    1,
  );
  await expect(rowNamed(page, PROPOSAL_TITLE)).toContainText('proposals 2 open / 2 resolved');
  await expectAxeClean(page);

  // Search narrows the sections and lands in the address.
  await page.getByRole('searchbox').fill('investigate');
  await expect(main.getByRole('status').filter({ hasText: `1 of ${ROOTS_SHOWN} roots match,` })).toBeVisible();
  await expect.poll(() => searchParam(page, 'q')).toBe('investigate');
  await expect(blocked).toHaveCount(1);

  // The detail: the declaration with its exact local date, facts grouped by source (the Desktop
  // metadata and what git found on the paths the family named), the folded children, the joined
  // transcript and the routing simulation bound to that transcript.
  await blocked.click();
  await expect.poll(() => searchParam(page, 'root')).toBe(BLOCKED_ROOT_ID);
  const aside = main.locator('[data-work-aside]');
  await expect(aside.locator('[data-work-detail]')).toHaveAttribute('data-work-detail', BLOCKED_ROOT_ID);
  await expect(aside.getByText('title: automatic', { exact: true })).toBeVisible();
  // The report has its own label for the joined transcript (the project as the production
  // fixture publishes it, machine-qualified); the detail shows it apart from the project, and
  // only there: the row, the filter and the search never read it.
  await expect(aside).toContainText(`${PROJECT_LABEL} · fixture/checkout-3 (worktree checkout-3)`);
  await expect(aside.locator('[data-work-served-label]')).toHaveText(`report project: ${SERVED_PROJECT_LABEL}`);
  await expect(aside.locator('[data-work-question]')).toHaveText(BLOCKED_QUESTION);
  await expect(aside).toContainText(
    `Declared by the session at ${BLOCKED_DECLARED_AT}; its current state is unobserved.`,
  );
  await expect(aside).toContainText(`The session stopped on a question: ${BLOCKED_QUESTION}`);
  await expect(aside).not.toContainText('Checkout checkout-3 could not be read');
  await expect(aside.getByRole('heading', { level: 3, name: 'Facts by source' })).toBeVisible();
  await expect(aside.getByRole('heading', { level: 4, name: 'Claude Desktop metadata' })).toBeVisible();
  await expect(aside.getByRole('heading', { level: 4, name: 'Local checkout' })).toBeVisible();
  await expect(aside).toContainText('Declared blocked: Stopped at a question the fixture cannot answer alone.');
  await expect(aside).toContainText('Wrote branch fixture/checkout-3');
  await expect(aside).toContainText('/work/fixture on fixture-main: clean');
  await expect(aside).toContainText(MISSING_WORKTREE);
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
  await expect(aside.getByRole('heading', { level: 3, name: 'Review this work' })).toBeVisible();
  await expect(aside).toContainText(
    `Choose an executor for a read-only review of “${BLOCKED_TITLE}”. The engine checks the target before launch.`,
  );
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
  await expect(aside.getByRole('button', { name: 'Start read-only review (Codex)', exact: true })).toHaveCount(0);
  await expect(aside.getByRole('button', { name: 'Start read-only review (Claude Code)', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectAxeClean(page);
  await capture(page, 'work-prod-1440-detail-blocked.png', { fullPage: true });

  // Closing travels back: the search survives and focus returns to the row.
  await page.goBack();
  await expect.poll(() => searchParam(page, 'root')).toBeNull();
  expect(searchParam(page, 'q')).toBe('investigate');
  await expect(aside.locator('[data-work-detail]')).toHaveCount(0);
  await expect(blocked).toBeFocused();

  // Nothing left the machine. The page load's read of the dataset is the server-rendered one; the
  // browser revalidates it at most once, and only because the fixture server's pinned clock makes
  // the hydrated answer look stale to a browser on the real clock (collection-facts policy).
  expect(tracked.offsite).toEqual([]);
  expect(tracked.posts.filter((pathname) => pathname === WORK_ATTENTION_PATH).length).toBeLessThanOrEqual(1);
  expect(tracked.posts.filter((pathname) => !pathname.startsWith(RPC_PATH_PREFIX))).toEqual([]);
});

test('shows the collected Codex sessions apart, wait unknown, each opening its own served Session (ADR 0059)', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForCollectedWork(request);
  const response = await request.post(WORK_ATTENTION_PATH, {
    data: encodeRpcResponseBody({ limit: PAGE_LIMIT, machineId: null }),
    headers: { 'content-type': 'application/json' },
  });
  const output = parseWorkAttentionOutput(decodeRpcResponseBody(await response.text()));
  if (!output.ok) {
    throw new Error(`work.attention answered ${output.error.tag}: ${output.error.message}`);
  }
  // From the native rollouts through the collector, the store and the served revision: one root per
  // Codex family, after every Desktop root, with nothing declared and its served Session attached.
  const codex = output.data.roots.filter((root) => root.key.harness === 'codex');
  expect(codex).toHaveLength(CODEX_ROOTS_SHOWN);
  expect(output.data.roots.slice(DESKTOP_ROOTS_SHOWN)).toEqual(codex);
  expect(
    codex.every(
      (root) =>
        root.attention === 'not-observable' &&
        root.declared === null &&
        root.desktopSessionId === null &&
        root.session !== null &&
        root.project.label === CODEX_PROJECT_LABEL,
    ),
  ).toBe(true);
  expect(output.data.totalRoots).toBe(DESKTOP_ROOTS + CODEX_FAMILIES);
  expect(output.data.truncated).toBe(true);

  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');
  const section = main.locator('[data-work-section="not-observable"]');
  await expect(section.getByRole('heading', { level: 2, name: CODEX_TITLE, exact: true })).toBeVisible();
  await expect(section.locator('header')).toContainText(
    'Whether one waits on you is unknown — not declared by this harness, which is not the same as nothing pending.',
  );
  await expect(sectionRows(page, 'not-observable')).toHaveCount(FOLDED_ROOTS);
  await expect(
    section.getByRole('button', { name: `Show all ${CODEX_ROOTS_SHOWN} in ${CODEX_TITLE}`, exact: true }),
  ).toBeVisible();
  const first = sectionRows(page, 'not-observable').first();
  await expect(first).toHaveAttribute('data-work-standing', 'not-declared');
  await expect(first.locator('[data-work-not-declared]')).toHaveText('wait not declared');
  await expect(first).toContainText(CODEX_PROJECT_LABEL);
  await expect(first).toContainText('wait unknown · not declared by Codex');
  await capture(page, 'work-prod-1440-codex-section.png', { fullPage: false });
  await expectAxeClean(page);

  await first.click();
  const aside = main.locator('[data-work-aside]');
  await expect(aside.locator('[data-work-request]')).toHaveAttribute('data-work-request', 'not-declared');
  await expect(aside.locator('[data-work-not-declared-detail]')).toContainText(
    'Codex records no turn declaration for its sessions: whether this one waits on you is unknown — not declared by this harness.',
  );
  await expect(aside.locator('[data-work-next]')).toHaveText(
    'Next: Check the session in Codex; this view cannot tell whether it waits on you.',
  );
  await expect(aside.getByRole('link', { name: 'Open session detail' })).toHaveAttribute(
    'href',
    SESSION_DETAIL_PATTERN,
  );
  await capture(page, 'work-prod-1440-codex-detail.png', { fullPage: true });
  await expectAxeClean(page);

  // The harness filter narrows to the Codex rows and counts them against the ranking.
  await page.goBack();
  await main.locator('[data-work-filters]').getByRole('button', { name: CODEX_CHIP_PATTERN }).click();
  await expect.poll(() => searchParam(page, 'harness')).toBe('codex');
  await expect(main.locator('[data-work-search-coverage]')).toContainText(
    `${CODEX_ROOTS_SHOWN} of ${ROOTS_SHOWN} roots match,`,
  );

  // The served Session it opens is the Codex session the report collected.
  await sectionRows(page, 'not-observable').first().click();
  await aside.getByRole('link', { name: 'Open session detail' }).click();
  await expect(page).toHaveURL(SESSION_DETAIL_PATTERN_URL);
});

test('confronts each seeded declaration with the facts and coverage the chain collected', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForCollectedWork(request);
  const main = page.getByRole('main');

  // Asked for a pull request; its child declared one after the question and GitHub showed it
  // open: a possible answer the operator must confirm, so the question stays theirs.
  const satisfied = await openWorkRoot(page, SATISFIED_ROOT_ID);
  await expect(satisfied.getByRole('heading', { level: 2, name: SATISFIED_TITLE })).toBeVisible();
  await expect(satisfied).toContainText(
    'This is the session’s own last declaration; a later pull request may be the answer, but nothing confirms it.',
  );
  await expect(satisfied).toContainText(SATISFIED_INTERPRETATION);
  await expect(satisfied).toContainText(RECONSIDERED_UNCERTAINTY);
  await expect(satisfied).toContainText(
    'fixture/ai-usage#117 is open and awaiting review (REVIEW_REQUIRED; checks unknown) as of ',
  );
  await expect(satisfied).toContainText('Declared PR #117 open on fixture/ai-usage (fixture/pr-117)');
  await expect(satisfied.getByRole('heading', { level: 4, name: 'GitHub' })).toBeVisible();
  await expect(satisfied).toContainText('PR #117 open, checks unknown, review required');
  await expect(satisfied.getByText(SATISFIED_CHILD_TITLE, { exact: true })).toBeVisible();
  // Not joined to a transcript: the project is the repository and no report label is shown.
  await expect(satisfied).toContainText(`${PROJECT_LABEL} · `);
  await expect(satisfied.locator('[data-work-served-label]')).toHaveCount(0);
  await expect(satisfied).toContainText(TRANSCRIPT_GAP);
  await expect(main.locator('[data-work-section="human-request"] [data-work-root][aria-current="true"]')).toHaveCount(
    1,
  );

  // A completed root whose declared pull request GitHub shows awaiting review.
  const completed = await openWorkRoot(page, COMPLETED_ROOT_ID);
  await expect(completed.getByRole('heading', { level: 2, name: COMPLETED_TITLE })).toBeVisible();
  await expect(completed).toContainText(COMPLETED_INTERPRETATION);
  await expect(completed).toContainText('Declared PR #118 open on fixture/ai-usage (fixture/pr-118)');
  await expect(completed).toContainText('PR #118 open, checks unknown, review required');
  await expect(completed).toContainText(TRANSCRIPT_GAP);

  // The child declared #90 merged a day before the root asked to merge: that cannot be the
  // answer, and the fixture gh showing #90 open only adds an observed wait beside the question.
  const mergedBefore = rowNamed(page, MERGED_BEFORE_TITLE);
  await expect(main.locator('[data-work-section="human-request"]').locator(mergedBefore)).toHaveCount(1);
  await mergedBefore.click();
  const aside = main.locator('[data-work-aside]');
  await expect(aside).toContainText('The session stopped on a question: Push the fix and merge it.');
  await expect(aside).toContainText(MERGED_BEFORE_INTERPRETATION);
  await expect(aside).not.toContainText('Possibly answered');
  await expect(aside).toContainText('Declared PR #90 merged on fixture/ai-usage (fixture/pr-90)');

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

test('lists the Desktop registry as a detected source whose last run succeeded', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForCollectedWork(request);
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

test('opens the collected root as a drawer at 390px without overflow', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForCollectedWork(request);
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
  await expect(dialog.getByRole('heading', { level: 3, name: 'Review this work' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close detail', exact: true })).toBeFocused();
  await settleAnimations(page);
  await expectNoOverflow(page);
  await expectAxeClean(page);
  await capture(page, 'work-prod-390-drawer.png', { fullPage: false });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(() => searchParam(page, 'root')).toBeNull();
});

const ANSWERED_TITLE = 'Fixture: settle the layout';
const REPLIED_TITLE = 'Fixture: export column wording';
const UNRELATED_TITLE = 'Fixture: settings panel naming';
const OFFERS_TITLE = 'Fixture: follow-ups after the import';
const HANDLED_ROOT_ID = 'local_fixture-handled-root';
const HANDLED_TITLE = 'Fixture: release checklist';
const CONTINUED_ROOT_ID = 'local_fixture-continued-root';

test('reads on the production path what the native registry says about requests, offers and linked work (ADR 0056)', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForCollectedWork(request);
  await page.goto('/work');
  await waitForHydratedWork(page);
  const main = page.getByRole('main');

  // The latest question is the current request; one sweep cannot know the earlier one.
  const answered = rowNamed(page, ANSWERED_TITLE);
  await expect(answered).toHaveAttribute('data-work-standing', 'current');
  await expect(answered).toContainText('Delete the superseded layout branch now?');
  await expect(answered.locator('[data-work-decision]')).toHaveCount(0);
  // A reply a single sweep cannot date leaves the question a current block, never a guessed answer.
  await expect(rowNamed(page, REPLIED_TITLE)).toHaveAttribute('data-work-standing', 'current');

  // An unrelated pull request, observed through gh, resolves nothing.
  const unrelated = rowNamed(page, UNRELATED_TITLE);
  await expect(main.locator('[data-work-section="human-request"]').locator(unrelated)).toHaveCount(1);
  await expect(unrelated).toHaveAttribute('data-work-standing', 'current');
  await expect(unrelated).toContainText('PR #131 review required · observed');

  // Work continued in a session started from the root after its question: to reconsider, marked in words.
  const continued = main.locator('[data-work-reconsider]').locator(rowNamed(page, CONTINUED_TITLE));
  await expect(continued).toHaveCount(1);
  await expect(continued.locator('[data-work-standing-marker]')).toHaveText('Older declaration to reconsider');

  // Offers made before a later message, or expired, are no longer a lead.
  const offers = rowNamed(page, OFFERS_TITLE);
  await expect(main.locator('[data-work-section="optional-lead"]').locator(offers)).toHaveCount(1);
  await expect(offers).toContainText('proposals 2 open / 0 resolved / 1 no longer pending');

  // A completed linked session does not identify an answer to the root’s question.
  const handled = rowNamed(page, HANDLED_TITLE);
  await expect(main.locator('[data-work-reconsider]').locator(handled)).toHaveCount(1);
  await expect(handled.locator('[data-work-standing-marker]')).toHaveText('Older declaration to reconsider');
  await expect(handled.locator('[data-work-decision]')).toHaveCount(0);
  await capture(page, 'work-prod-1440-standings.png', { fullPage: true });
  await expectAxeClean(page);

  const handledDetail = await openWorkRoot(page, HANDLED_ROOT_ID);
  await expect(handledDetail.locator('[data-work-request]')).toHaveAttribute('data-work-request', 'reconsider');
  await expect(handledDetail).toContainText(
    'Older declaration to reconsider: work continued after the question in “Fixture: fix the flaky export test”',
  );
  await expect(handledDetail.locator('[data-work-next]')).toHaveText(
    'Next: Check what followed; answer or archive the session in Claude Desktop to settle it.',
  );
  const continuedDetail = await openWorkRoot(page, CONTINUED_ROOT_ID);
  await expect(continuedDetail.locator('[data-work-request]')).toHaveAttribute('data-work-request', 'reconsider');
  await expect(continuedDetail).toContainText(
    'Older declaration to reconsider: work continued after the question in “Fixture: toolbar icon study”',
  );
  await capture(page, 'work-prod-1440-detail-reconsider.png', { fullPage: true });
  await expectAxeClean(page);
});
