import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { type CanonicalInstant, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { CheckoutStatusObservation, PullRequestObservation } from '@ai-usage/report-core/work-attention';
import { branchLinkKey } from '@ai-usage/report-core/work-thread';
import type {
  WorkThreadLocalMarker,
  WorkThreadPullRequestMarker,
  WorkThreadRow,
  WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';

const GROUP_HEADING_PATTERN = /<h2 id="wd-group-[a-z-]+">(.*?)<\/h2>/g;
const COLUMN_HEADER_PATTERN = /<th scope="col">(.*?)<\/th>/g;
const TAGS_PATTERN = /<[^>]+>/g;

const server = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: { conditions: ['svelte'], dedupe: ['svelte'] },
  root: fileURLToPath(new URL('../../../../../../../', import.meta.url)),
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
afterAll(() => server.close());

const module: unknown = await server.ssrLoadModule('/apps/web/src/lib/features/work/disk/work-disk-table.svelte');
if (!(typeof module === 'object' && module !== null && 'default' in module && typeof module.default === 'function')) {
  throw new Error('Missing work-disk-table component');
}
const Table = module.default as Component;
const renderer: unknown = await server.ssrLoadModule('svelte/server');
if (
  !(typeof renderer === 'object' && renderer !== null && 'render' in renderer && typeof renderer.render === 'function')
) {
  throw new Error('Svelte server renderer unavailable');
}
const render = renderer.render as (
  component: Component,
  options: { props: Record<string, unknown> },
) => { body: string };

const MACHINE = 'machine-a';
const REPOSITORY = 'acme/shop';
const ROOT = '/home/dev/Projects/shop';
const at = (value: string): CanonicalInstant => parseCanonicalInstant(value);
const NOW = at('2026-11-11T12:00:00.000Z');
const HOUR_AGO = at('2026-11-11T11:00:00.000Z');
const LONG_AGO = at('2026-09-01T09:00:00.000Z');

const status = (
  checkoutPath: string,
  overrides: Partial<CheckoutStatusObservation> = {},
): CheckoutStatusObservation => ({
  ahead: 0,
  behind: 0,
  branch: 'fix/retry',
  checkoutPath,
  dirty: false,
  headSha: 'a'.repeat(40),
  lastCommitAt: LONG_AGO,
  machineId: MACHINE,
  modifiedCount: 0,
  observedAt: HOUR_AGO,
  outcome: 'observed',
  stagedCount: 0,
  untrackedCount: 0,
  upstream: 'origin/fix/retry',
  ...overrides,
});
const unread = (
  checkoutPath: string,
  outcome: Exclude<CheckoutStatusObservation['outcome'], 'observed'>,
): CheckoutStatusObservation =>
  status(checkoutPath, {
    ahead: null,
    behind: null,
    branch: null,
    dirty: null,
    headSha: null,
    lastCommitAt: null,
    modifiedCount: null,
    outcome,
    stagedCount: null,
    untrackedCount: null,
    upstream: null,
  });
const marker = (
  checkoutPath: string,
  latest: CheckoutStatusObservation | null,
  overrides: Partial<WorkThreadLocalMarker> = {},
): WorkThreadLocalMarker => ({
  checkoutPath,
  key: branchLinkKey({ host: 'github.com', ref: latest?.branch ?? 'fix/retry', repository: REPOSITORY }),
  lastSessionActivityAt: null,
  latest,
  latestSuccessful: latest?.outcome === 'observed' ? latest : null,
  via: 'branch-link',
  ...overrides,
});
const pullRequest = (number: number, overrides: Partial<PullRequestObservation>): WorkThreadPullRequestMarker => {
  const observation: PullRequestObservation = {
    accountLabel: null,
    baseRef: 'main',
    checksRollup: null,
    crossRepository: false,
    draft: false,
    headRef: 'fix/retry',
    host: 'github.com',
    machineId: MACHINE,
    mergedAt: null,
    number,
    observedAt: HOUR_AGO,
    outcome: 'observed',
    outcomeMessage: null,
    repository: REPOSITORY,
    reviewDecision: null,
    state: 'OPEN',
    title: `Pull request ${number}`,
    updatedAt: null,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    ...overrides,
  };
  return {
    key: `github.com/${REPOSITORY}#${number}`,
    latest: observation,
    latestSuccessful: observation,
    mergeable: null,
    mergeStateStatus: null,
    role: null,
  };
};
const task = (
  threadId: string,
  local: readonly WorkThreadLocalMarker[],
  pullRequests: readonly WorkThreadPullRequestMarker[] = [],
  done = false,
): WorkThreadRow => ({
  afterDone: null,
  combinedThreads: [],
  delegatedSessionCount: 0,
  firstActivityAt: LONG_AGO,
  lastActivityAt: HOUR_AGO,
  links: [],
  markers: { jiraIssues: [], local, pullRequests },
  marks: [],
  nativeRequestCoverage: 'complete',
  nativeRequests: [],
  runningSessions: 0,
  sessionCount: 0,
  thread: {
    createdAt: LONG_AGO,
    doneAt: done ? HOUR_AGO : null,
    doneReason: null,
    followRevision: 1,
    followState: done ? 'done' : 'following',
    intent: null,
    machineId: MACHINE,
    note: null,
    objective: null,
    origin: 'user',
    originKey: null,
    projectLabel: REPOSITORY,
    threadId,
    title: `Task ${threadId}`,
    updatedAt: HOUR_AGO,
    waitingFor: null,
    waitingOn: null,
  },
});

const SAFE = `${ROOT}/.claude/worktrees/retry`;
const DIRTY = `${ROOT}/.claude/worktrees/dirty`;
const GONE = `${ROOT}/.claude/worktrees/gone`;
const NEVER = `${ROOT}/.claude/worktrees/never`;
const STALE = `${ROOT}/.claude/worktrees/stale`;
const branchKey = (ref: string): string => branchLinkKey({ host: 'github.com', ref, repository: REPOSITORY });
const safeTask = task(
  'safe',
  [marker(SAFE, status(SAFE))],
  [pullRequest(9, { mergedAt: HOUR_AGO, state: 'MERGED' })],
  true,
);
/** A worktree read clean with a merged pull request, but ten weeks ago. */
const staleTask = task(
  'stale',
  [marker(STALE, status(STALE, { branch: 'fix/stale', observedAt: LONG_AGO }))],
  [pullRequest(8, { headRef: 'fix/stale', mergedAt: LONG_AGO, state: 'MERGED' })],
);
// The main checkout is listed and present, so the `.claude/worktrees/*` paths read as its worktrees.
const rows: readonly WorkThreadRow[] = [
  task('main', [
    marker(ROOT, status(ROOT, { branch: 'feat/open', upstream: 'origin/feat/open' })),
    marker(ROOT, status(ROOT, { branch: 'feat/open', upstream: 'origin/feat/open' })),
  ]),
  task(
    'open',
    [marker(ROOT, status(ROOT, { branch: 'feat/open', upstream: 'origin/feat/open' }))],
    [pullRequest(12, { draft: true, headRef: 'feat/open' })],
  ),
  task('second', [marker(ROOT, status(ROOT, { branch: 'feat/open', upstream: 'origin/feat/open' }))]),
  task('third', [marker(ROOT, status(ROOT, { branch: 'feat/open', upstream: 'origin/feat/open' }))]),
  task('dirty', [
    marker(
      DIRTY,
      status(DIRTY, { ahead: null, branch: 'feat/dirty', dirty: true, untrackedCount: 1, upstream: null }),
      { lastSessionActivityAt: LONG_AGO },
    ),
  ]),
  task(
    'gone',
    [
      marker(GONE, unread(GONE, 'missing'), {
        key: branchKey('fix/gone'),
        latestSuccessful: status(GONE, { branch: 'fix/gone', observedAt: LONG_AGO }),
      }),
    ],
    [pullRequest(66, { headRef: 'fix/gone', state: 'CLOSED' })],
  ),
  task(
    'never',
    [marker(NEVER, null, { key: branchKey('fix/never') })],
    [pullRequest(7, { headRef: 'fix/never', mergedAt: HOUR_AGO, state: 'MERGED' })],
  ),
];
const localSource: WorkThreadSourceStatus = {
  lastRunAt: HOUR_AGO,
  message: 'Checkout reads were bounded at 40 paths.',
  source: 'checkouts',
  state: 'truncated',
};
const sessionsSource: WorkThreadSourceStatus = {
  lastRunAt: HOUR_AGO,
  message: null,
  source: 'sessions',
  state: 'ok',
};
const html = (props: Record<string, unknown>): string =>
  render(Table, {
    props: {
      coverage: { complete: true, loaded: 7, total: 63 },
      href: (threadId: string) => `/work?view=disk&task=${threadId}`,
      now: NOW,
      rows,
      sources: [],
      timeZone: 'UTC',
      ...props,
    },
  })
    .body.replaceAll(/<!--[^>]*-->/g, '')
    .replaceAll(/\s+/g, ' ');
const text = (markup: string): string => markup.replaceAll(TAGS_PATTERN, ' ').replaceAll(/\s+/g, ' ').trim();
/** The markup of one group, from its heading to the next group's. */
const section = (body: string, group: string): string => {
  const start = body.indexOf(`<h2 id="wd-group-${group}"`);
  if (start === -1) {
    throw new Error(`Missing group ${group}`);
  }
  const next = body.indexOf('<h2 id="wd-group-', start + 1);
  return body.slice(start, next === -1 ? undefined : next);
};
/** The markup of one checkout's table row. */
const rowOf = (body: string, path: string): string => {
  const start = body.indexOf(`<tr data-disk-checkout="${path}"`);
  if (start === -1) {
    throw new Error(`Missing checkout row ${path}`);
  }
  return body.slice(start, body.indexOf('</tr>', start));
};

describe('work disk lens SSR presentation', () => {
  test('lists the five groups in order with their counts, in the headings and the summary', () => {
    const body = html({});
    expect([...body.matchAll(GROUP_HEADING_PATTERN)].map((match) => text(match[1] ?? ''))).toEqual([
      'Safe to remove · 0',
      'Needs a look · 1',
      'In use · 1',
      'Gone from disk · 1',
      'Not read · 1',
    ]);
    const summary = text(body.slice(0, body.indexOf('<p class="wd-scope"')));
    expect(summary).toBe(
      '4 checkouts · 1 repository Safe to remove 0 Needs a look 1 In use 1 Gone from disk 1 Not read 1',
    );
    for (const group of ['safe-to-remove', 'needs-a-look', 'in-use', 'gone', 'not-read']) {
      expect(body).toContain(`href="#wd-group-${group}"`);
    }
  });

  test('each non-empty group is a real table with column, row-group and row headers', () => {
    const inUse = section(html({}), 'in-use');
    expect(inUse).toContain('<caption class="wd-sr-only">In use</caption>');
    expect([...inUse.matchAll(COLUMN_HEADER_PATTERN)].map((match) => match[1])).toEqual([
      'Checkout',
      'Branch',
      'Task',
      'Pull request',
      'Disk state',
      'Last session',
      'Observed',
    ]);
    expect(inUse).toContain('<th colspan="7" scope="rowgroup" title="acme/shop">shop <span>· 1 checkout</span></th>');
    expect(inUse).toContain('<th scope="row">');
    expect(inUse).toContain('<section aria-label="In use checkouts" class="wd-scroll" tabindex="0">');
    expect(inUse).not.toContain('Copy');
  });

  test('a checkout several tasks name is one row naming its pull request, branch and tasks', () => {
    const body = html({});
    const row = rowOf(body, ROOT);
    expect(body.split(`data-disk-checkout="${ROOT}"`)).toHaveLength(2);
    expect(row).toContain(`<code class="wd-path" title="${ROOT}">shop</code>`);
    expect(row).toContain(`<span class="wd-sr-only">Full path ${ROOT}</span>`);
    expect(row).toContain('<code class="wd-branch">feat/open</code>');
    expect(row).toContain('main checkout');
    expect(row).toContain('href="https://github.com/acme/shop/pull/12"');
    expect(row).toContain('rel="noreferrer"');
    expect(row).toContain('target="_blank"');
    const words = text(row);
    expect(words).toContain('PR #12 on GitHub, opens in a new tab Draft');
    expect(words).toContain('✓ Clean PR #12 open (draft)');
    expect(words).toContain('No linked session here');
    // The task whose pull request is on this branch leads; the others unfold, so the cell stays two lines.
    expect(row.indexOf('href="/work?view=disk&amp;task=open"')).toBeLessThan(row.indexOf('<summary>+3 more</summary>'));
    expect(row.indexOf('<summary>+3 more</summary>')).toBeLessThan(row.indexOf('href="/work?view=disk&amp;task=main"'));
    expect(words).toContain('Task third');
    // The role sits beside the branch, in the same cell.
    expect(row).toContain('<code class="wd-branch">feat/open</code> <span class="wd-tag">main checkout</span>');
  });

  test('a checkout with leftovers says what is there and why it needs a look, in words', () => {
    const row = rowOf(html({}), DIRTY);
    expect(section(html({}), 'needs-a-look')).toContain(`data-disk-checkout="${DIRTY}"`);
    const words = text(row);
    expect(words).toContain('● 1 untracked · no upstream');
    // The reason says why the row is listed and does not repeat the disk state above it.
    expect(words).toContain('● 1 untracked · no upstream No pull request · quiet for 71 days 71 d ago Sep 1');
    expect(words).not.toContain('unpushed commits not ruled out');
    expect(words).toContain('No pull request for this branch');
    expect(row).toContain('<time datetime="2026-09-01T09:00:00.000Z"');
    expect(words).toContain('71 d ago Sep 1');
    expect(words).toContain('worktree');
  });

  test('a checkout that was not read is under "Not read" and never worded as clean', () => {
    const body = html({});
    expect(section(body, 'not-read')).toContain(`data-disk-checkout="${NEVER}"`);
    const row = rowOf(body, NEVER);
    const words = text(row);
    expect(words).not.toContain('Clean');
    expect(words).toContain('? Never observed');
    expect(words).toContain('fix/never (from the task link)');
    expect(words).toContain('Never');
    // The pull request of the linked branch is named; it does not move the row out of "Not read".
    expect(words).toContain('PR #7 on GitHub, opens in a new tab Merged');
    expect(body.split('worktree remove --')).toHaveLength(1);
  });

  test('a checkout read clean too long ago is under "Not read", dated, and not worded as clean', () => {
    const body = html({ rows: [...rows, staleTask] });
    expect(section(body, 'not-read')).toContain(`data-disk-checkout="${STALE}"`);
    expect(section(body, 'safe-to-remove')).not.toContain(`data-disk-checkout="${STALE}"`);
    const row = rowOf(body, STALE);
    const words = text(row);
    expect(row).toContain('<span class="wd-state" data-state="not-read">');
    expect(words).toContain('? Last read 71 days ago Current state unknown');
    expect(words).not.toContain('Clean');
    expect(words).toContain('PR #8 on GitHub, opens in a new tab Merged');
    expect(body.split('worktree remove --')).toHaveLength(1);
  });

  test('an absent checkout is under "Gone from disk" with the branch and date it was last seen', () => {
    const body = html({});
    expect(section(body, 'gone')).toContain(`data-disk-checkout="${GONE}"`);
    const words = text(rowOf(body, GONE));
    expect(words).toContain('✕ Absent No longer on disk');
    expect(words).toContain('fix/gone (last seen)');
    expect(words).toContain('PR #66 on GitHub, opens in a new tab Closed');
    expect(words).toContain('1 h ago last present Sep 1');
    expect(words).not.toContain('Clean');
  });

  test('the scope note states what was read, what is not listed and how the sources answered', () => {
    const note = (props: Record<string, unknown>): string => {
      const body = html(props);
      const start = body.indexOf('<p class="wd-scope"');
      return text(body.slice(start, body.indexOf('</p>', start)));
    };
    const plain =
      'Lists the checkouts that followed and done tasks name. 7 of 63 tasks read. Worktrees no task names are not listed.';
    expect(note({})).toBe(plain);
    // A source that answered ok with nothing to say is not mentioned.
    expect(note({ sources: [{ ...localSource, message: null, state: 'ok' }, sessionsSource] })).toBe(plain);
    const partial = note({
      coverage: { complete: false, loaded: 7, total: 63 },
      rows: [
        ...rows,
        {
          ...task('linked', []),
          links: [
            {
              createdAt: LONG_AGO,
              detachedAt: null,
              key: branchKey('feat/nowhere'),
              kind: 'branch',
              linkId: 'link-1',
              provenance: 'declared',
              threadId: 'linked',
            },
          ],
        },
      ],
      sources: [
        localSource,
        { ...sessionsSource, message: 'Partial linked-session evidence', state: 'truncated' },
        { lastRunAt: HOUR_AGO, message: 'Private GitHub diagnostic', source: 'github', state: 'failed' },
      ],
    });
    expect(partial).toContain('7 of 63 tasks read. The list is partial: the remaining tasks were not read.');
    expect(partial).toContain('1 linked branch has no known checkout on this machine.');
    expect(partial).toContain('Local read truncated: Checkout reads were bounded at 40 paths. Last run 1 h ago');
    expect(partial).toContain('Sessions truncated: Partial linked-session evidence Last run 1 h ago');
    expect(partial).not.toContain('GitHub');
    expect(note({ sources: [{ ...localSource, message: 'Read from a cached pass.', state: 'ok' }] })).toContain(
      'Local read ok: Read from a cached pass. Last run 1 h ago',
    );
    expect(note({ sources: [{ ...localSource, lastRunAt: null, message: null, state: 'never-run' }] })).toEndWith(
      'Local read never-run. No run recorded.',
    );
  });

  test('with no safe checkout, the group says what is required and offers no command', () => {
    const safe = section(html({}), 'safe-to-remove');
    expect(text(safe)).toContain(
      'Pull request merged, tracked and untracked files clean, nothing unpushed. Ignored files are not read.',
    );
    expect(text(safe)).toContain(
      'No checkout meets the conditions: a merged pull request, a clean tree, a known upstream with nothing ahead, and a linked worktree.',
    );
    expect(html({})).not.toContain('provably');
    expect(safe).not.toContain('<table');
    expect(html({})).not.toContain('Copy all commands');
    expect(html({})).not.toContain('worktree remove --');
  });

  test('a safe checkout shows its one-line command, a copy button per row and one for all', () => {
    const body = html({ rows: [...rows, safeTask] });
    const safe = section(body, 'safe-to-remove');
    expect(text(safe)).toStartWith('Safe to remove · 1');
    expect([...safe.matchAll(COLUMN_HEADER_PATTERN)].map((match) => match[1])).toEqual([
      'Checkout',
      'Branch',
      'Task',
      'Pull request',
      'Disk state',
      'Last session',
      'Observed',
      'Command',
    ]);
    expect(safe).toContain('<th colspan="8" scope="rowgroup"');
    expect(safe).toContain(
      `<code class="wt-code">git -C ${ROOT} worktree remove -- ${SAFE} &amp;&amp; git -C ${ROOT} branch -d -- fix/retry</code>`,
    );
    expect(safe).toContain('<button class="wt-button" type="button">Copy all commands</button>');
    expect(safe).toContain('aria-label="Copy the command for shop/.claude/worktrees/retry"');
    expect(safe).toContain('role="status"');
    expect(text(safe)).toContain(
      'Nothing here runs git. git worktree remove refuses a worktree with modified or untracked files, but deletes ignored files (.env, local stores) with it. git branch -d refuses an unmerged branch.',
    );
    expect(safe).not.toContain('Commands are withheld');
    const words = text(rowOf(body, SAFE));
    expect(words).toContain('Task safe · done');
    expect(words).toContain('PR #9 on GitHub, opens in a new tab Merged');
    expect(words).toContain('✓ Clean PR #9 merged · clean · nothing unpushed');
    // Only the safe row offers a command: no other row or group repeats one.
    expect(body.split(' worktree remove -- ')).toHaveLength(2);
  });

  test('while tasks remain unread, the safe rows are listed without any command or copy button', () => {
    const body = html({ coverage: { complete: false, loaded: 7, total: 63 }, rows: [...rows, safeTask] });
    const safe = section(body, 'safe-to-remove');
    expect(text(safe)).toStartWith('Safe to remove · 1');
    expect(safe).toContain(`data-disk-checkout="${SAFE}"`);
    expect(text(safe)).toContain('Commands are withheld until every task is read.');
    expect([...safe.matchAll(COLUMN_HEADER_PATTERN)].map((match) => match[1])).toEqual([
      'Checkout',
      'Branch',
      'Task',
      'Pull request',
      'Disk state',
      'Last session',
      'Observed',
    ]);
    expect(safe).toContain('<th colspan="7" scope="rowgroup"');
    expect(body).not.toContain('worktree remove --');
    expect(body).not.toContain('Copy');
    expect(body).not.toContain('<button');
  });

  test('an observed link that is not a web address is shown as text, not as a link', () => {
    const body = html({
      rows: [task('open', [marker(ROOT, status(ROOT))], [pullRequest(12, { url: 'javascript:alert(1)' })])],
    });
    const row = rowOf(body, ROOT);
    expect(row).toContain('<span>PR #12</span>');
    expect(row).not.toContain('javascript:');
  });
});
