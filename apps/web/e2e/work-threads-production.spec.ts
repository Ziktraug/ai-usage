import { readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSourceControlCommandResponse } from '@ai-usage/report-core/source-control';
import {
  parseWorkThreadsCommandOutput,
  parseWorkThreadsDetailOutput,
  parseWorkThreadsListOutput,
  type WorkThreadsDetailOutput,
  type WorkThreadsListOutput,
} from '@ai-usage/web-contract/work-threads';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './browser-test';
import { decodeRpcResponseBody, encodeRpcResponseBody } from './rpc-test-transport';
import { P1_PR_KEY, P1_QUESTION, P1_SESSION_LABEL, P1_TASK_TITLE, p1FixtureFiles } from './work-threads-p1-fixture';

type WorkThreadDetailDataset = Extract<WorkThreadsDetailOutput, { ok: true }>['data'];
type WorkThreadListDataset = Extract<WorkThreadsListOutput, { ok: true }>['data'];
type WorkThreadRow = WorkThreadListDataset['rows'][number];

/**
 * Live production composition only: native histories -> engine -> disposable SQLite -> read-only
 * Work thread RPC -> browser. All writes below are browser gestures through the public UI.
 * The P1 journey evolves only native fixture files and the fake gh response in its validated HOME.
 * User task commands remain browser gestures; provider calls terminate in fake executables.
 */
const DISCOVERED_KEY = 'github.com/fixture/discovered#77';
const DISCOVERED_TITLE = 'Discovered fixture pull request';
const DISCOVERED_URL = 'https://github.com/fixture/discovered/pull/77';
const ANALYSIS_TITLE = 'Production analysis from a collected session';
const ROOT_SESSION_TITLE = 'Implement fixture root';
const ROOT_SESSION_KEY = 'session:production-e2e-machine/codex/codex-root-025';
const COMMAND_PATH = '/rpc/workThreads/command';
const SOURCE_COMMAND_PATH = '/api/source-control/command';
const SOURCE_ID = 'github.pull-requests';
const COLLECTION_TIMEOUT_MS = 60_000;
const MAX_SERVED_PAGES = 12;
const DONE_TAB = /^Done /;
const API_PULL_REQUEST_READ = /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/\d+$/;
// A query (never a mutation) reading only review-thread resolution of one pull request.
const REVIEW_THREADS_READ =
  /^query=query\(\$owner: String!, \$name: String!, \$number: Int!\) \{ repository\(owner: \$owner, name: \$name\) \{ pullRequest\(number: \$number\) \{ reviewThreads\(first: 100\) \{ totalCount nodes \{ isResolved \} \} \} \} \}$/;
const OWNER_VARIABLE = /^owner=[\w.-]+$/;
const NAME_VARIABLE = /^name=[\w.-]+$/;
const NUMBER_VARIABLE = /^number=\d+$/;

const listOutput = async (request: APIRequestContext, tab: 'open' | 'done' = 'open', cursor: string | null = null) => {
  const response = await request.post('/rpc/workThreads/list', {
    data: encodeRpcResponseBody({ cursor, limit: 100, project: null, search: DISCOVERED_KEY, tab }),
    headers: { 'content-type': 'application/json' },
  });
  expect(response.status()).toBe(200);
  return parseWorkThreadsListOutput(decodeRpcResponseBody(await response.text()));
};
const readList = async (
  request: APIRequestContext,
  tab: 'open' | 'done' = 'open',
  cursor: string | null = null,
): Promise<WorkThreadListDataset> => {
  const output = await listOutput(request, tab, cursor);
  if (!output.ok) {
    throw new Error(`${output.error.tag}: ${output.error.message}`);
  }
  return output.data;
};
const readDetail = async (request: APIRequestContext, threadId: string): Promise<WorkThreadDetailDataset> => {
  const response = await request.post('/rpc/workThreads/detail', {
    data: encodeRpcResponseBody({ threadId }),
    headers: { 'content-type': 'application/json' },
  });
  expect(response.status()).toBe(200);
  const output = parseWorkThreadsDetailOutput(decodeRpcResponseBody(await response.text()));
  if (!output.ok) {
    throw new Error(`${output.error.tag}: ${output.error.message}`);
  }
  return output.data;
};
const discoveredRows = (data: WorkThreadListDataset): readonly WorkThreadRow[] =>
  data.rows.filter((row) =>
    row.links.some((link) => link.kind === 'pull-request' && link.key === DISCOVERED_KEY && link.detachedAt === null),
  );
const readDiscoveredRows = async (
  request: APIRequestContext,
  tab: 'open' | 'done',
): Promise<readonly WorkThreadRow[]> => {
  const rows: WorkThreadRow[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_SERVED_PAGES; pageNumber += 1) {
    const data = await readList(request, tab, cursor);
    rows.push(...discoveredRows(data));
    cursor = data.nextCursor;
    if (cursor === null) {
      return rows;
    }
    if (cursors.has(cursor)) {
      throw new Error('The Work thread reader repeated its pagination cursor.');
    }
    cursors.add(cursor);
  }
  throw new Error('The bounded duplicate audit could not exhaust all Work thread pages.');
};
const githubRunAt = (data: WorkThreadListDataset): string | null =>
  data.sources.find((source) => source.source === 'github')?.lastRunAt ?? null;
const githubObservationAt = (data: WorkThreadListDataset): string | null =>
  discoveredRows(data)[0]?.markers.pullRequests.find((marker) => marker.key === DISCOVERED_KEY)?.latest?.observedAt ??
  null;
const hydrated = async (page: Page): Promise<void> => {
  await expect(page.locator('main[data-work-hydrated="true"]')).toBeVisible({ timeout: 15_000 });
};
const taskRow = (page: Page, threadId: string) => page.locator(`[data-work-thread="${threadId}"]`);
const clickEnd = async (page: Page): Promise<void> =>
  page.getByRole('button', { name: 'End follow-up', exact: true }).first().click();
const expectDone = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-follow-state="done"]')).toBeVisible();
  await expect(
    page.getByText('No GitHub, Jira or session state was changed by ending it.', { exact: true }),
  ).toBeVisible();
};
// The analysis has no PR and its session recorded no branch matching its checkout, so that checkout
// is not a remainder of this task: the follow-up ends without an acknowledgement step.
const endAnalysis = async (page: Page): Promise<void> => {
  await clickEnd(page);
  await expectDone(page);
};

const collectedDiscoveredTask = async (request: APIRequestContext): Promise<WorkThreadRow> => {
  await expect
    .poll(
      async () => {
        const output = await listOutput(request);
        if (!output.ok) {
          return false;
        }
        const [row] = discoveredRows(output.data);
        return (
          row?.markers.pullRequests.some(
            (marker) => marker.key === DISCOVERED_KEY && marker.latest?.outcome === 'observed',
          ) ?? false
        );
      },
      {
        message: 'The engine must discover and observe the personal PR without a session',
        timeout: COLLECTION_TIMEOUT_MS,
      },
    )
    .toBe(true);
  const data = await readList(request);
  const rows = await readDiscoveredRows(request, 'open');
  expect(data.machineId).toBe('production-e2e-machine');
  expect(await readDiscoveredRows(request, 'done')).toHaveLength(0);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) {
    throw new Error('The discovered task is absent after collection completed.');
  }
  expect(row.thread.origin).toBe('pull-request');
  expect(row.thread.originKey).toBe(DISCOVERED_KEY);
  expect(row.thread.title).toBe(DISCOVERED_TITLE);
  expect(row.sessionCount).toBe(0);
  expect(row.links.some((link) => link.kind === 'session')).toBe(false);
  return row;
};

const runGitHubSourceFromUi = async (page: Page, request: APIRequestContext): Promise<void> => {
  const before = await readList(request);
  const beforeRun = githubRunAt(before);
  const beforeObservation = githubObservationAt(before);
  if (beforeRun === null || beforeObservation === null) {
    throw new Error('Initial GitHub source observations are missing.');
  }
  await page.goto('/sources');
  await expect(page.locator('main[data-route-shell="sources"][data-hydrated="true"]')).toBeVisible();
  const healthy = page.locator('[data-healthy-source-summary]');
  const source = page
    .locator('[data-source-card], [data-healthy-source-row]')
    .filter({ has: page.getByText(SOURCE_ID, { exact: true }) });
  // A healthy GitHub source sits in the collapsed "Healthy sources" disclosure; a refresh of the
  // page data can re-render it closed, so open it until the row is visible.
  await expect(async () => {
    if ((await healthy.count()) && (await healthy.getAttribute('open')) === null) {
      await healthy.locator('> summary').click();
    }
    await expect(source).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  const run = source.getByRole('button', { name: 'Run now', exact: true });
  await expect(run).toBeEnabled();
  const commandResponse = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === SOURCE_COMMAND_PATH && candidate.request().method() === 'POST',
  );
  await run.click();
  const response = await commandResponse;
  expect(response.status()).toBe(200);
  expect(JSON.parse(response.request().postData() ?? 'null')).toEqual({ command: 'run-now', sourceId: SOURCE_ID });
  const accepted = parseSourceControlCommandResponse(await response.json());
  expect(accepted.ok).toBe(true);
  // Acceptance only queues a run. A later successful persisted run AND PR observation prove
  // that collection, discovery reconciliation and fact writes actually completed.
  await expect
    .poll(
      async () => {
        const data = await readList(request);
        const sourceState = data.sources.find((entry) => entry.source === 'github');
        const observed = githubObservationAt(data);
        return (
          sourceState?.state === 'ok' &&
          sourceState.lastRunAt !== null &&
          sourceState.lastRunAt > beforeRun &&
          observed !== null &&
          observed > beforeObservation
        );
      },
      {
        message: 'The user-requested GitHub run must finish and publish a newer PR observation',
        timeout: COLLECTION_TIMEOUT_MS,
      },
    )
    .toBe(true);
};

const createAnalysisFromServedSession = async (
  page: Page,
  request: APIRequestContext,
): Promise<WorkThreadDetailDataset> => {
  await page.goto('/work/sessions');
  await hydrated(page);
  const served = page.locator('details[data-work-served-roots]');
  await served.locator('> summary').click();
  const session = served
    .locator('[data-work-session]')
    .filter({ has: page.getByRole('heading', { name: ROOT_SESSION_TITLE, exact: true }) });
  // The 203 newer pagination sessions precede the clean repository's real root. Traverse the
  // same served pages the operator can load, rather than constructing a session identity.
  for (let pageNumber = 0; pageNumber < MAX_SERVED_PAGES && (await session.count()) === 0; pageNumber += 1) {
    const more = served.getByRole('button', { name: 'Load more observed sessions', exact: true });
    await expect(more).toBeEnabled();
    const previousCount = await served.locator('[data-work-session]').count();
    await more.click();
    await expect.poll(() => served.locator('[data-work-session]').count()).toBeGreaterThan(previousCount);
  }
  await expect(session).toBeVisible();
  await session.getByRole('button', { name: 'Follow as a task', exact: true }).click();
  await session.getByRole('textbox', { name: 'Task title', exact: true }).fill(ANALYSIS_TITLE);
  await session.getByRole('combobox', { name: 'Intent', exact: true }).selectOption('analysis');
  const commandResponse = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === COMMAND_PATH);
  await session.getByRole('button', { name: 'Create task', exact: true }).click();
  const response = await commandResponse;
  expect(response.status()).toBe(200);
  const created = parseWorkThreadsCommandOutput(decodeRpcResponseBody(await response.text()));
  if (!created.ok || created.threadId === null) {
    throw new Error(created.ok ? 'Task creation answered without its task.' : created.message);
  }
  await session.getByRole('link', { name: 'Open task', exact: true }).click();
  await hydrated(page);
  await expect(page.getByRole('heading', { name: ANALYSIS_TITLE, exact: true })).toBeVisible();
  const data = await readDetail(request, created.threadId);
  expect(data.row.thread.intent).toBe('analysis');
  expect(data.row.links).toHaveLength(1);
  expect(data.row.links[0]).toMatchObject({ kind: 'session', key: ROOT_SESSION_KEY, detachedAt: null });
  // One linked session is one episode; sessions it delegated nest under it and are counted apart,
  // never as separate episodes, sessions to follow or tasks.
  expect(data.episodes).toHaveLength(1);
  expect(data.row.sessionCount).toBe(1);
  expect(data.row.delegatedSessionCount).toBe(data.episodes[0]?.children.length ?? 0);
  expect(data.episodes[0]?.endedAt).not.toBeNull();
  expect(data.row.markers.pullRequests).toEqual([]);
  expect(data.row.markers.jiraIssues).toEqual([]);
  // A session's checkout is a Local marker only on the PR head branch, or, without a PR, on the
  // branch the session recorded; this collected session recorded none that matches, so the analysis
  // carries no local remainder once the checkout source has run.
  await expect
    .poll(
      async () => {
        const current = await readDetail(request, created.threadId);
        return current.sources.find((source) => source.source === 'checkouts')?.lastRunAt != null;
      },
      { message: 'The checkout source must run before the analysis ends', timeout: COLLECTION_TIMEOUT_MS },
    )
    .toBe(true);
  await page.reload();
  await hydrated(page);
  const observed = await readDetail(request, created.threadId);
  expect(observed.row.markers.local).toEqual([]);
  await expect(page.getByText('Analysis only · no branch, PR or ticket needed')).toBeVisible();
  return observed;
};

const fixtureGhLog = async (data: WorkThreadDetailDataset): Promise<string> => {
  const episode = data.episodes.find((entry) => entry.sourceSessionId === 'codex-root-025');
  const cwd = episode?.resume.kind === 'cli-resume' ? episode.resume.cwd : null;
  if (cwd === null) {
    throw new Error('The collected root did not expose its verified fixture checkout.');
  }
  const home = path.resolve(cwd, '../..');
  const temporaryRoot = await realpath(tmpdir());
  if (
    path.basename(cwd) !== 'fixture' ||
    path.basename(path.dirname(cwd)) !== 'work' ||
    path.dirname(home) !== temporaryRoot ||
    !path.basename(home).startsWith('plan052-production-browser-')
  ) {
    throw new Error('Refusing to read a gh journal outside the isolated production fixture HOME.');
  }
  const log = path.join(home, 'work-thread-gh-argv.jsonl');
  if ((await realpath(log)) !== log) {
    throw new Error('The fixture gh journal must not be a symlink.');
  }
  return log;
};

const assertReadOnlyGhCalls = async (log: string): Promise<void> => {
  const calls: string[][] = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!(Array.isArray(value) && value.every((argument): argument is string => typeof argument === 'string'))) {
        throw new Error('Malformed fake gh argv journal.');
      }
      return value;
    });
  expect(calls.some((args) => args[0] === 'search' && args[1] === 'prs' && args.includes('--author=@me'))).toBe(true);
  expect(
    calls.some((args) => args[0] === 'search' && args[1] === 'prs' && args.includes('--review-requested=@me')),
  ).toBe(true);
  expect(
    calls.filter(
      (args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '77' && args.includes('fixture/discovered'),
    ).length,
  ).toBeGreaterThanOrEqual(2);
  expect(calls.some((args) => args[0] === 'api' && args[1] === 'graphql')).toBe(true);
  for (const args of calls) {
    const [command, subcommand] = args;
    if (command === 'search') {
      expect(subcommand).toBe('prs');
      expect(
        args.includes('--author=@me') ||
          args.includes('user-review-requested:@me') ||
          args.includes('--review-requested=@me'),
      ).toBe(true);
      expect(args).toContain('--state=open');
    } else if (command === 'pr') {
      expect(subcommand).toBe('view'); // Also excludes the legacy resolver's pr list in this journey.
    } else if (command === 'api' && subcommand === 'graphql') {
      // The open PR's review-thread read: one query document and its three variables, nothing else.
      expect(args).toHaveLength(10);
      expect([args[2], args[4], args[6], args[8]]).toEqual(['-f', '-f', '-f', '-F']);
      expect(args[3]).toMatch(REVIEW_THREADS_READ);
      expect(args[5]).toMatch(OWNER_VARIABLE);
      expect(args[7]).toMatch(NAME_VARIABLE);
      expect(args[9]).toMatch(NUMBER_VARIABLE);
    } else if (command === 'api') {
      expect(args).toHaveLength(2); // No --method/-X, body, fields or other mutating API options.
      expect(subcommand).toMatch(API_PULL_REQUEST_READ);
    } else if (command === 'auth') {
      expect(subcommand).toBe('token'); // No login, logout, setup-git or token writes.
    } else {
      throw new Error(`The production journey invoked an unexpected gh command: ${command ?? '(empty)'}`);
    }
  }
};

test('production Work threads survive source refresh, follow-up transitions and conflicting tabs', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000);
  const discovered = await collectedDiscoveredTask(request);
  const threadId = discovered.thread.threadId;
  let analysis: WorkThreadDetailDataset | undefined;

  await test.step('A: discover a PR without sessions, end, reload Done and reopen', async () => {
    await page.goto(`/work?q=${encodeURIComponent(DISCOVERED_TITLE)}`);
    await hydrated(page);
    await expect(taskRow(page, threadId)).toContainText('0 linked sessions');
    await expect(taskRow(page, threadId)).toContainText('PR #77');
    await taskRow(page, threadId).getByRole('link', { name: DISCOVERED_TITLE }).first().click();
    await expect(page.getByRole('heading', { name: DISCOVERED_TITLE, exact: true })).toBeVisible();
    await page.locator('summary').filter({ hasText: 'GITHUB' }).click();
    await expect(page.getByRole('link', { name: 'Open PR #77 on GitHub ↗', exact: true })).toHaveAttribute(
      'href',
      DISCOVERED_URL,
    );
    const before = await readDetail(request, threadId);
    expect(before.row.markers.pullRequests[0]).toMatchObject({ mergeable: 'mergeable', mergeStateStatus: 'CLEAN' });
    await clickEnd(page);
    await expect(page.getByRole('heading', { name: 'These remainders will stay', exact: true })).toBeVisible();
    const shownRemainders = await page
      .getByRole('region', { name: "What's left", exact: true })
      .locator('.wt-inline-panel li')
      .evaluateAll((items) =>
        items.map((item) =>
          Array.from(item.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent)
            .join('')
            .trim(),
        ),
      );
    expect(shownRemainders.length).toBeGreaterThan(0);
    expect(shownRemainders.every(Boolean)).toBe(true);
    await page.getByRole('button', { name: 'End anyway', exact: true }).click();
    await expectDone(page);
    const ended = await readDetail(request, threadId);
    expect(ended.row.thread).toMatchObject({
      followState: 'done',
      followRevision: before.row.thread.followRevision + 1,
    });
    expect(ended.events.at(-1)).toMatchObject({ kind: 'follow-state', fromState: 'following', toState: 'done' });
    for (const label of shownRemainders) {
      expect(ended.events.at(-1)?.acknowledgedRemainders.some((item) => item.startsWith(label))).toBe(true);
    }
    expect(ended.row.markers.pullRequests[0]?.latest?.state).toBe('OPEN');
    await page.reload();
    await hydrated(page);
    await expectDone(page);
    await page.getByRole('link', { name: '← My work', exact: true }).click();
    await page.getByRole('tab', { name: DONE_TAB }).click();
    await expect(page.getByRole('tab', { name: DONE_TAB })).toHaveAttribute('aria-selected', 'true');
    await expect(taskRow(page, threadId)).toBeVisible();
    expect(await readDiscoveredRows(request, 'done')).toHaveLength(1);
    await taskRow(page, threadId).getByRole('link', { name: DISCOVERED_TITLE }).first().click();
    await page.getByRole('button', { name: 'Reopen', exact: true }).first().click();
    await expect(page.locator('[data-follow-state="following"]')).toBeVisible();
    const reopened = await readDetail(request, threadId);
    expect(reopened.row.thread.followRevision).toBe(before.row.thread.followRevision + 2);
    expect(reopened.events.at(-1)).toMatchObject({ kind: 'follow-state', fromState: 'done', toState: 'following' });
    expect(reopened.row.markers.pullRequests[0]?.latest?.state).toBe('OPEN');
  });

  await test.step('B: run the GitHub source again through Sources without duplicating the task', async () => {
    const before = await readDetail(request, threadId);
    await runGitHubSourceFromUi(page, request);
    const open = await readDiscoveredRows(request, 'open');
    expect(open).toHaveLength(1);
    expect(open[0]?.thread.threadId).toBe(threadId);
    expect(await readDiscoveredRows(request, 'done')).toHaveLength(0);
    const after = await readDetail(request, threadId);
    expect(after.row.thread.followRevision).toBe(before.row.thread.followRevision);
    expect(after.row.thread.followState).toBe(before.row.thread.followState);
    expect(after.events).toEqual(before.events);
    await page.goto(`/work?q=${encodeURIComponent(DISCOVERED_TITLE)}`);
    await hydrated(page);
    await expect(page.locator('[data-work-thread]')).toHaveCount(1);
    await expect(taskRow(page, threadId)).toContainText('0 linked sessions');
  });

  await test.step('C: a collected session starts an analysis with no artifact links, then ends and reopens', async () => {
    analysis = await createAnalysisFromServedSession(page, request);
    const analysisId = analysis.row.thread.threadId;
    await endAnalysis(page);
    const ended = await readDetail(request, analysisId);
    expect(ended.row.thread.followRevision).toBe(analysis.row.thread.followRevision + 1);
    expect(ended.events.at(-1)?.acknowledgedRemainders).toEqual([]);
    await page.getByRole('link', { name: '← My work', exact: true }).click();
    await page.getByRole('tab', { name: DONE_TAB }).click();
    await expect(page.getByRole('tab', { name: DONE_TAB })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('searchbox', { name: 'Search tasks', exact: true }).fill(ANALYSIS_TITLE);
    await expect(taskRow(page, analysisId)).toBeVisible();
    await taskRow(page, analysisId).getByRole('link', { name: ANALYSIS_TITLE }).first().click();
    await page.getByRole('button', { name: 'Reopen', exact: true }).first().click();
    await expect(page.locator('[data-follow-state="following"]')).toBeVisible();
    const reopened = await readDetail(request, analysisId);
    expect(reopened.row.thread.followRevision).toBe(analysis.row.thread.followRevision + 2);
    expect(reopened.row.links).toEqual(analysis.row.links);
  });

  await test.step('a stale second tab cannot replace a newer decision', async () => {
    if (!analysis) {
      throw new Error('The analysis journey did not create a task.');
    }
    const analysisId = analysis.row.thread.threadId;
    const before = await readDetail(request, analysisId);
    const second = await context.newPage();
    let releaseReads: (() => void) | undefined;
    const heldReads = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    try {
      // The document carries the real server snapshot. Hold browser reads before navigation,
      // including the hydration refetch, so the first tab's later decision cannot refresh it.
      // No response or command is replaced with fixture data.
      await second.route('**/rpc/workThreads/**', async (route) => {
        if (['/rpc/workThreads/list', '/rpc/workThreads/detail'].includes(new URL(route.request().url()).pathname)) {
          await heldReads;
        }
        await route.continue();
      });
      await second.goto(`/work?task=${analysisId}`);
      await hydrated(second);
      await second.getByRole('button', { name: 'Mark as waiting', exact: true }).click();
      await second.getByRole('textbox', { name: 'Waiting for', exact: true }).fill('A product answer');
      await endAnalysis(page);
      const commandResponse = second.waitForResponse((candidate) => new URL(candidate.url()).pathname === COMMAND_PATH);
      await second.getByRole('button', { name: 'Wait', exact: true }).click();
      const response = await commandResponse;
      expect(decodeRpcResponseBody(response.request().postData() ?? '')).toMatchObject({
        expectedRevision: before.row.thread.followRevision,
        threadId: analysisId,
        to: 'waiting',
      });
      expect(parseWorkThreadsCommandOutput(decodeRpcResponseBody(await response.text()))).toMatchObject({
        ok: false,
        failure: 'revision-conflict',
        currentRevision: before.row.thread.followRevision + 1,
      });
      releaseReads?.();
      await expect(second.getByRole('alert')).toContainText('This task changed in another tab — reloaded');
      await expect(second.locator('[data-follow-state="done"]')).toBeVisible();
      const after = await readDetail(request, analysisId);
      expect(after.row.thread).toMatchObject({
        followRevision: before.row.thread.followRevision + 1,
        followState: 'done',
        waitingFor: null,
      });
      expect(after.events.filter((event) => event.toState === 'waiting')).toHaveLength(0);
    } finally {
      releaseReads?.();
      await second.close();
    }
  });
  if (!analysis) {
    throw new Error('The analysis task is needed to locate the isolated fixture journal.');
  }
  await assertReadOnlyGhCalls(await fixtureGhLog(analysis));
});

const runNativeSourceFromUi = async (page: Page, sourceId: string): Promise<void> => {
  await page.goto('/sources');
  await expect(page.locator('main[data-route-shell="sources"][data-hydrated="true"]')).toBeVisible();
  const healthy = page.locator('[data-healthy-source-summary]');
  const source = page
    .locator('[data-source-card], [data-healthy-source-row]')
    .filter({ has: page.getByText(sourceId, { exact: true }) });
  await expect(async () => {
    if ((await healthy.count()) && (await healthy.getAttribute('open')) === null) {
      await healthy.locator('> summary').click();
    }
    await expect(source).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  const run = source.getByRole('button', { name: 'Run now', exact: true });
  await expect(run).toBeEnabled();
  const responsePromise = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === SOURCE_COMMAND_PATH && candidate.request().method() === 'POST',
  );
  await run.click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(JSON.parse(response.request().postData() ?? 'null')).toEqual({ command: 'run-now', sourceId });
  expect(parseSourceControlCommandResponse(await response.json()).ok).toBe(true);
};

const openTask = async (page: Page, threadId: string): Promise<void> => {
  await page.goto(`/work?task=${threadId}`);
  await hydrated(page);
};

const followP1Session = async (page: Page, request: APIRequestContext): Promise<WorkThreadDetailDataset> => {
  await expect(async () => {
    await page.goto('/work/sessions');
    await hydrated(page);
    const served = page.locator('details[data-work-served-roots]');
    await served.locator('> summary').click();
    await expect(served.getByRole('heading', { name: P1_SESSION_LABEL, exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: COLLECTION_TIMEOUT_MS });
  const session = page
    .locator('[data-work-session]')
    .filter({ has: page.getByRole('heading', { name: P1_SESSION_LABEL, exact: true }) });
  await session.getByRole('button', { name: 'Follow as a task', exact: true }).click();
  await session.getByRole('textbox', { name: 'Task title', exact: true }).fill(P1_TASK_TITLE);
  const responsePromise = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === COMMAND_PATH);
  await session.getByRole('button', { name: 'Create task', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const result = parseWorkThreadsCommandOutput(decodeRpcResponseBody(await response.text()));
  if (!result.ok || result.threadId === null) {
    throw new Error(result.ok ? 'Task creation answered without its task.' : result.message);
  }
  await session.getByRole('link', { name: 'Open task', exact: true }).click();
  await hydrated(page);
  return readDetail(request, result.threadId);
};

test('production P1 continuity and native decisions survive collection, closure and reload', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  await collectedDiscoveredTask(request);
  const analysis = await createAnalysisFromServedSession(page, request);
  const analysisId = analysis.row.thread.threadId;
  const home = path.dirname(await fixtureGhLog(analysis));
  const files = await p1FixtureFiles(home);

  await test.step('a followed session keeps its task identity when its first proven PR appears', async () => {
    await files.seedSession();
    await runNativeSourceFromUi(page, 'claude.sessions');
    const before = await followP1Session(page, request);
    const threadId = before.row.thread.threadId;
    expect(before.row.links).toHaveLength(1);
    expect(before.row.markers.pullRequests).toHaveLength(0);
    await files.discoverPullRequest();
    await runNativeSourceFromUi(page, 'claude.sessions');
    await expect
      .poll(async () => (await readDetail(request, threadId)).episodes[0]?.endedAt, { timeout: COLLECTION_TIMEOUT_MS })
      .toBe('2026-07-03T11:33:00.000Z');
    await runGitHubSourceFromUi(page, request);
    await expect
      .poll(
        async () =>
          (await readDetail(request, threadId)).row.links.some(
            (link) => link.key === P1_PR_KEY && link.detachedAt === null,
          ),
        { timeout: COLLECTION_TIMEOUT_MS },
      )
      .toBe(true);
    const after = await readDetail(request, threadId);
    expect(after.row.thread).toMatchObject({
      threadId,
      title: P1_TASK_TITLE,
      followState: before.row.thread.followState,
      followRevision: before.row.thread.followRevision,
      note: before.row.thread.note,
    });
    expect(after.row.links.filter((link) => link.kind === 'session')).toEqual(before.row.links);
    const response = await request.post('/rpc/workThreads/list', {
      data: encodeRpcResponseBody({ cursor: null, limit: 100, project: null, search: P1_PR_KEY, tab: 'open' }),
      headers: { 'content-type': 'application/json' },
    });
    const listed = parseWorkThreadsListOutput(decodeRpcResponseBody(await response.text()));
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error(listed.error.message);
    }
    expect(listed.data.rows.map((row) => row.thread.threadId)).toEqual([threadId]);
    await openTask(page, threadId);
    await expect(page.getByRole('heading', { name: P1_TASK_TITLE, exact: true })).toBeVisible();
    await expect(page.getByText('PR #78', { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('p1-session-first-pr.png'), fullPage: true });
  });

  await test.step('native question participates in the warning and its acknowledgement without changing the source', async () => {
    await files.ask();
    await runNativeSourceFromUi(page, 'codex.sessions');
    await expect(async () => {
      await openTask(page, analysisId);
      await expect(page.getByRole('region', { name: "What's left", exact: true })).toContainText(P1_QUESTION, {
        timeout: 1000,
      });
    }).toPass({ timeout: COLLECTION_TIMEOUT_MS });
    await expect(page.getByText('Ready to close', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: "What's left", exact: true })).not.toContainText(
      'No known remainder',
    );
    const episode = page.locator(`[data-session-key="${ROOT_SESSION_KEY}"]`);
    const toggle = episode.locator('> .wt-session-button');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    await expect(episode).toContainText(P1_QUESTION);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual(
      [],
    );
    const nativeBefore = await readFile(files.codex, 'utf8');
    await page.screenshot({ path: testInfo.outputPath('p1-native-request.png'), fullPage: true });
    await clickEnd(page);
    await expect(page.getByRole('heading', { name: 'These remainders will stay', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: "What's left", exact: true })).toContainText(P1_QUESTION);
    await page.screenshot({ path: testInfo.outputPath('p1-request-warning.png'), fullPage: true });
    await page.getByRole('button', { name: 'End anyway', exact: true }).click();
    await expectDone(page);
    await page.reload();
    await hydrated(page);
    await expectDone(page);
    const ended = await readDetail(request, analysisId);
    expect(ended.row.thread.followState).toBe('done');
    expect(ended.events.at(-1)?.acknowledgedRemainders.some((entry) => entry.includes(P1_QUESTION))).toBe(true);
    expect(await readFile(files.codex, 'utf8')).toBe(nativeBefore);
    await page.screenshot({ path: testInfo.outputPath('p1-request-done.png'), fullPage: true });
    await page.getByRole('button', { name: 'Reopen', exact: true }).first().click();
    await expect(page.locator('[data-follow-state="following"]')).toBeVisible();
    await expect(page.getByRole('region', { name: "What's left", exact: true })).toContainText(P1_QUESTION);
  });

  await test.step('attributed native answer clears only the wait without a confirmation or ending follow-up', async () => {
    const before = await readDetail(request, analysisId);
    await files.answer();
    await runNativeSourceFromUi(page, 'codex.sessions');
    await expect(async () => {
      await openTask(page, analysisId);
      await expect(page.getByRole('region', { name: "What's left", exact: true })).not.toContainText(P1_QUESTION, {
        timeout: 1000,
      });
    }).toPass({ timeout: COLLECTION_TIMEOUT_MS });
    const after = await readDetail(request, analysisId);
    expect(after.row.thread.followState).toBe('following');
    expect(after.row.thread.followRevision).toBe(before.row.thread.followRevision);
    expect(after.events).toEqual(before.events);
    await page.screenshot({ path: testInfo.outputPath('p1-native-answered.png'), fullPage: true });
  });
});
