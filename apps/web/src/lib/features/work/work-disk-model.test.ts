import { describe, expect, test } from 'bun:test';
import {
  type CanonicalInstant,
  canonicalInstantFromDate,
  parseCanonicalInstant,
} from '@ai-usage/report-core/canonical-instant';
import type { CheckoutStatusObservation, PullRequestObservation } from '@ai-usage/report-core/work-attention';
import { branchLinkKey, sessionLinkKey, type WorkThreadLink } from '@ai-usage/report-core/work-thread';
import type {
  WorkThreadLocalMarker,
  WorkThreadPullRequestMarker,
  WorkThreadRow,
  WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import {
  aggregateDiskSources,
  classifyDiskCheckout,
  DISK_GROUPS,
  DISK_MAX_PAGES_PER_TAB,
  DISK_RECENT_ACTIVITY_MS,
  DISK_STALE_READ_MS,
  type DiskCheckout,
  type DiskGroupItem,
  describeDiskPullRequest,
  describeDiskSource,
  describeDiskState,
  diskCheckoutsOf,
  diskLensOf,
  diskPageChain,
  diskRemovalCommands,
  groupDiskCheckouts,
  shortDiskPaths,
} from './work-disk-model';

const MACHINE = 'machine-a';
const HOST = 'github.com';
const REPOSITORY = 'acme/shop';
const DAY_MS = 86_400_000;
const NOW = parseCanonicalInstant('2026-11-11T12:00:00.000Z');
const daysAgo = (days: number): CanonicalInstant => canonicalInstantFromDate(new Date(Date.parse(NOW) - days * DAY_MS));

const ROOT = '/home/dev/Projects/shop';
const WORKTREE = `${ROOT}/.claude/worktrees/retry`;
const branchKey = (ref: string): string => branchLinkKey({ host: HOST, ref, repository: REPOSITORY });

/** A clean, pushed checkout read an hour ago; each test states only what differs. */
const observed = (
  checkoutPath: string,
  overrides: Partial<CheckoutStatusObservation> = {},
): CheckoutStatusObservation => ({
  ahead: 0,
  behind: 0,
  branch: 'fix/retry',
  checkoutPath,
  dirty: false,
  headSha: 'a'.repeat(40),
  lastCommitAt: daysAgo(40),
  machineId: MACHINE,
  modifiedCount: 0,
  observedAt: daysAgo(0),
  outcome: 'observed',
  stagedCount: 0,
  untrackedCount: 0,
  upstream: 'origin/fix/retry',
  ...overrides,
});

/** A read that did not reach git: every git-reported field stays null. */
const failed = (
  checkoutPath: string,
  outcome: Exclude<CheckoutStatusObservation['outcome'], 'observed'>,
  observedAt: CanonicalInstant = daysAgo(0),
): CheckoutStatusObservation => ({
  ahead: null,
  behind: null,
  branch: null,
  checkoutPath,
  dirty: null,
  headSha: null,
  lastCommitAt: null,
  machineId: MACHINE,
  modifiedCount: null,
  observedAt,
  outcome,
  stagedCount: null,
  untrackedCount: null,
  upstream: null,
});

const marker = (
  checkoutPath: string | null,
  latest: CheckoutStatusObservation | null,
  overrides: Partial<WorkThreadLocalMarker> = {},
): WorkThreadLocalMarker => ({
  checkoutPath,
  key: branchKey('fix/retry'),
  lastSessionActivityAt: null,
  latest,
  latestSuccessful: latest?.outcome === 'observed' ? latest : null,
  via: 'branch-link',
  ...overrides,
});

const pullRequest = (number: number, overrides: Partial<PullRequestObservation> = {}): WorkThreadPullRequestMarker => {
  const observation: PullRequestObservation = {
    accountLabel: null,
    baseRef: 'main',
    checksRollup: null,
    crossRepository: false,
    draft: false,
    headRef: 'fix/retry',
    host: HOST,
    machineId: MACHINE,
    mergedAt: null,
    number,
    observedAt: daysAgo(0),
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
    key: `${HOST}/${REPOSITORY}#${number}`,
    latest: observation,
    latestSuccessful: observation,
    mergeable: null,
    mergeStateStatus: null,
    role: null,
  };
};
const merged = (number: number, overrides: Partial<PullRequestObservation> = {}): WorkThreadPullRequestMarker =>
  pullRequest(number, { mergedAt: daysAgo(3), state: 'MERGED', ...overrides });

const branchLink = (threadId: string, ref: string, detachedAt: CanonicalInstant | null = null): WorkThreadLink => ({
  createdAt: daysAgo(50),
  detachedAt,
  key: branchKey(ref),
  kind: 'branch',
  linkId: `${threadId}-${ref}`,
  provenance: 'declared',
  threadId,
});

const task = (
  threadId: string,
  input: {
    readonly done?: boolean;
    readonly links?: readonly WorkThreadLink[];
    readonly local?: readonly WorkThreadLocalMarker[];
    readonly project?: string | null;
    readonly pullRequests?: readonly WorkThreadPullRequestMarker[];
  } = {},
): WorkThreadRow => ({
  afterDone: null,
  combinedThreads: [],
  delegatedSessionCount: 0,
  firstActivityAt: daysAgo(50),
  lastActivityAt: daysAgo(1),
  links: input.links ?? [],
  markers: { jiraIssues: [], local: input.local ?? [], pullRequests: input.pullRequests ?? [] },
  marks: [],
  nativeRequestCoverage: 'complete',
  nativeRequests: [],
  runningSessions: 0,
  sessionCount: 0,
  thread: {
    createdAt: daysAgo(50),
    doneAt: input.done ? daysAgo(2) : null,
    doneReason: null,
    followRevision: 1,
    followState: input.done ? 'done' : 'following',
    intent: null,
    machineId: MACHINE,
    note: null,
    objective: null,
    origin: 'user',
    originKey: null,
    projectLabel: input.project === undefined ? REPOSITORY : input.project,
    threadId,
    title: `Task ${threadId}`,
    updatedAt: daysAgo(1),
    waitingFor: null,
    waitingOn: null,
  },
});

const checkoutAt = (rows: readonly WorkThreadRow[], path: string): DiskCheckout => {
  const checkout = diskCheckoutsOf(rows).checkouts.find((candidate) => candidate.path === path);
  if (!checkout) {
    throw new Error(`No checkout at ${path}`);
  }
  return checkout;
};
const classified = (rows: readonly WorkThreadRow[], path: string) => classifyDiskCheckout(checkoutAt(rows, path), NOW);

const itemsOf = (rows: readonly WorkThreadRow[]): readonly (DiskGroupItem & { readonly group: string })[] =>
  groupDiskCheckouts(diskCheckoutsOf(rows).checkouts, NOW).flatMap((group) =>
    group.repositories.flatMap((repository) => repository.items.map((item) => ({ ...item, group: group.group }))),
  );
const itemAt = (rows: readonly WorkThreadRow[], path: string) => {
  const item = itemsOf(rows).find((candidate) => candidate.checkout.path === path);
  if (!item) {
    throw new Error(`No row at ${path}`);
  }
  return item;
};

/** The one line offered for a safe worktree: the branch is deleted only when the removal succeeded. */
const removal = (root: string, path: string, branch: string): string =>
  `git -C ${root} worktree remove -- ${path} && git -C ${root} branch -d -- ${branch}`;

/** An older pull request observation: it does not say whether the head branch is a fork's. */
const withoutForkStatus = (pullRequestMarker: WorkThreadPullRequestMarker): WorkThreadPullRequestMarker => {
  const strip = (observation: PullRequestObservation | null): PullRequestObservation | null => {
    if (observation === null) {
      return null;
    }
    const { crossRepository: _unread, ...rest } = observation;
    return rest;
  };
  return {
    ...pullRequestMarker,
    latest: strip(pullRequestMarker.latest),
    latestSuccessful: strip(pullRequestMarker.latestSuccessful),
  };
};

/**
 * The repository's main checkout, present and in use: a `.claude/worktrees/<name>` path under it
 * reads as its linked worktree.
 */
const mainCheckout = (): WorkThreadRow =>
  task('main-task', {
    local: [
      marker(ROOT, observed(ROOT, { branch: 'feat/other', upstream: 'origin/feat/other' }), {
        key: branchKey('feat/other'),
        lastSessionActivityAt: daysAgo(1),
      }),
    ],
  });

describe('disk lens: safe to remove', () => {
  test('a merged pull request on a clean, pushed worktree is safe to remove', () => {
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [merged(9)] }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout.role).toBe('worktree');
    expect(checkout.repositoryRoot).toBe(ROOT);
    expect(checkout.repository).toBe('github.com/acme/shop');
    expect(checkout.pullRequest).toMatchObject({
      draft: false,
      headInRepository: true,
      mergedAt: daysAgo(3),
      number: 9,
      state: 'merged',
    });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'safe-to-remove',
      reason: 'PR #9 merged · clean · nothing unpushed',
    });
    expect(diskRemovalCommands(checkout)).toEqual([removal(ROOT, WORKTREE, 'fix/retry')]);
    expect(checkoutAt(rows, ROOT)).toMatchObject({ repositoryRoot: null, role: 'primary' });
  });

  test.each([
    ['is not listed', []],
    ['was never observed', [task('root', { local: [marker(ROOT, null, { key: branchKey('feat/other') })] })]],
    ['is absent', [task('root', { local: [marker(ROOT, failed(ROOT, 'missing'), { key: branchKey('feat/other') })] })]],
    [
      'is not a git repository',
      [task('root', { local: [marker(ROOT, failed(ROOT, 'not-a-repository'), { key: branchKey('feat/other') })] })],
    ],
    [
      'could not be read',
      [task('root', { local: [marker(ROOT, failed(ROOT, 'timeout'), { key: branchKey('feat/other') })] })],
    ],
    [
      'is on another machine',
      [
        task('root', {
          local: [
            marker(ROOT, observed(ROOT, { branch: 'feat/other', machineId: 'machine-b' }), {
              key: branchKey('feat/other'),
            }),
          ],
        }),
      ],
    ],
  ] as const)('a worktree-shaped path whose root %s is not taken for a worktree', (_label, roots) => {
    const rows = [...roots, task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [merged(9)] })];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({ repositoryRoot: null, role: 'unknown' });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged and clean; the read does not say whether this is a linked worktree',
    });
    expect(diskRemovalCommands(checkout)).toEqual([]);
    for (const root of diskCheckoutsOf(rows).checkouts.filter((candidate) => candidate.path === ROOT)) {
      expect(root.role).toBe('unknown');
    }
  });

  test('a subdirectory of a worktree, or a path merely nested in a checkout, is not a worktree', () => {
    const subdirectory = `${WORKTREE}/apps/web`;
    const nested = `${ROOT}/trees/retry`;
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [merged(9)] }),
      // A session's working directory inside the worktree: `git status` answers there as it does at the top.
      task('b', { local: [marker(subdirectory, observed(subdirectory))], pullRequests: [merged(9)] }),
      task('c', { local: [marker(nested, observed(nested))], pullRequests: [merged(9)] }),
    ];
    for (const path of [subdirectory, nested]) {
      const checkout = checkoutAt(rows, path);
      expect(checkout).toMatchObject({ repositoryRoot: null, role: 'unknown' });
      expect(classifyDiskCheckout(checkout, NOW).group).toBe('needs-a-look');
      expect(diskRemovalCommands(checkout)).toEqual([]);
      expect(itemAt(rows, path).commands).toEqual([]);
    }
    // The subdirectory does not turn the worktree into a main checkout.
    expect(checkoutAt(rows, WORKTREE)).toMatchObject({ repositoryRoot: ROOT, role: 'worktree' });
    expect(itemAt(rows, WORKTREE).commands).toEqual([removal(ROOT, WORKTREE, 'fix/retry')]);
  });

  test('a worktree of a worktree-shaped root takes the nearest root', () => {
    const inner = `${WORKTREE}/.claude/worktrees/inner`;
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))] }),
      task('b', { local: [marker(inner, observed(inner))] }),
    ];
    expect(checkoutAt(rows, inner)).toMatchObject({ repositoryRoot: WORKTREE, role: 'worktree' });
    expect(checkoutAt(rows, WORKTREE)).toMatchObject({ repositoryRoot: ROOT, role: 'worktree' });
  });

  test('the removal command quotes what the shell would split or expand, and never forces', () => {
    const root = "/home/dev/My Projects/it's";
    const path = `${root}/.claude/worktrees/fix $HOME`;
    const rows = [
      task('root', {
        local: [marker(root, observed(root, { branch: 'feat/other' }), { key: branchKey('feat/other') })],
      }),
      task('a', {
        local: [marker(path, observed(path, { branch: 'fix/a&b' }), { key: branchKey('fix/a&b') })],
        pullRequests: [merged(9, { headRef: 'fix/a&b' })],
      }),
    ];
    const checkout = checkoutAt(rows, path);
    expect(classifyDiskCheckout(checkout, NOW).group).toBe('safe-to-remove');
    const quotedRoot = "'/home/dev/My Projects/it'\\''s'";
    const quotedPath = "'/home/dev/My Projects/it'\\''s/.claude/worktrees/fix $HOME'";
    expect(diskRemovalCommands(checkout)).toEqual([removal(quotedRoot, quotedPath, "'fix/a&b'")]);
    const [command] = diskRemovalCommands(checkout);
    expect(command).not.toContain('-D');
    expect(command).not.toContain('--force');
    expect(command?.split('\n')).toHaveLength(1);
  });

  test('an operand that starts with a dash is quoted and follows "--"', () => {
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [merged(9)] }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(diskRemovalCommands({ ...checkout, branch: '-D' })).toEqual([removal(ROOT, WORKTREE, "'-D'")]);
  });

  test.each([
    ['a backslash', 'fix\\retry'],
    ['a line break', 'fix\nretry'],
    ['a tab', 'fix\tretry'],
    ['a delete character', 'fix\u007fretry'],
  ])('a path with %s is not worded as a command and is left to the operator', (_label, name) => {
    const path = `${ROOT}/.claude/worktrees/${name}`;
    const rows = [mainCheckout(), task('a', { local: [marker(path, observed(path))], pullRequests: [merged(9)] })];
    const checkout = checkoutAt(rows, path);
    expect(checkout.role).toBe('worktree');
    expect(diskRemovalCommands(checkout)).toEqual([]);
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged and clean; the path needs quoting this view does not do, remove it by hand',
    });
    expect(itemAt(rows, path).commands).toEqual([]);
  });

  test('a safe row always has its command and no other row has one', () => {
    const at = (name: string) => `${ROOT}/.claude/worktrees/${name}`;
    const worktree = (
      name: string,
      overrides: Partial<CheckoutStatusObservation>,
      pullRequests: readonly WorkThreadPullRequestMarker[],
    ) =>
      task(name, {
        local: [
          marker(at(name), observed(at(name), { branch: `fix/${name}`, ...overrides }), {
            key: branchKey(`fix/${name}`),
          }),
        ],
        pullRequests,
      });
    const rows = [
      mainCheckout(),
      worktree('safe', {}, [merged(1, { headRef: 'fix/safe' })]),
      worktree('also-safe', {}, [merged(2, { headRef: 'fix/also-safe' })]),
      worktree('dirty', { dirty: true, untrackedCount: 1 }, [merged(3, { headRef: 'fix/dirty' })]),
      worktree('ahead', { ahead: 1 }, [merged(4, { headRef: 'fix/ahead' })]),
      worktree('no-upstream', { ahead: null, upstream: null }, [merged(5, { headRef: 'fix/no-upstream' })]),
      worktree('open', {}, [pullRequest(6, { headRef: 'fix/open' })]),
      worktree('closed', {}, [pullRequest(7, { headRef: 'fix/closed', state: 'CLOSED' })]),
      worktree('no-pr', {}, []),
      worktree('stale', { observedAt: daysAgo(70) }, [merged(8, { headRef: 'fix/stale' })]),
      worktree('moved-on', { lastCommitAt: daysAgo(1) }, [merged(9, { headRef: 'fix/moved-on' })]),
      worktree('fork-unread', {}, [withoutForkStatus(merged(10, { headRef: 'fix/fork-unread' }))]),
      worktree('other-repository', {}, [merged(11, { headRef: 'fix/other-repository', repository: 'acme/other' })]),
      worktree('back\\slash', { branch: 'fix/backslash' }, [merged(12, { headRef: 'fix/backslash' })]),
      task('gone', { local: [marker(at('gone'), failed(at('gone'), 'missing'))], pullRequests: [merged(13)] }),
      task('never', { local: [marker(at('never'), null)], pullRequests: [merged(13)] }),
      task('timeout', {
        local: [marker(at('timeout'), failed(at('timeout'), 'timeout'), { latestSuccessful: observed(at('timeout')) })],
        pullRequests: [merged(13)],
      }),
      task('standalone', {
        local: [marker('/home/dev/Projects/standalone', observed('/home/dev/Projects/standalone'))],
        pullRequests: [merged(13)],
      }),
    ];
    const items = itemsOf(rows);
    expect(items).toHaveLength(rows.length);
    for (const item of items) {
      expect([item.checkout.path, item.commands.length]).toEqual([
        item.checkout.path,
        item.group === 'safe-to-remove' ? 1 : 0,
      ]);
      if (item.group === 'safe-to-remove') {
        expect(item.commands).toEqual(diskRemovalCommands(item.checkout));
      }
    }
    expect(items.filter((item) => item.group === 'safe-to-remove').map((item) => item.checkout.path)).toEqual([
      at('also-safe'),
      at('safe'),
    ]);
  });
});

describe('disk lens: merged with leftovers', () => {
  test.each([
    ['an untracked file', { dirty: true, untrackedCount: 1 }, 'PR #9 merged, but 1 untracked'],
    [
      'staged and modified files',
      { dirty: true, modifiedCount: 2, stagedCount: 1 },
      'PR #9 merged, but 1 staged · 2 modified',
    ],
    ['changes git did not count', { dirty: true }, 'PR #9 merged, but uncommitted changes, counts not reported'],
    ['commits ahead', { ahead: 2 }, 'PR #9 merged, but 2 commits not pushed'],
    ['one commit ahead', { ahead: 1 }, 'PR #9 merged, but 1 commit not pushed'],
    [
      'no upstream',
      { ahead: null, behind: null, upstream: null },
      'PR #9 merged, but no upstream, unpushed commits not ruled out',
    ],
    [
      'an upstream whose ahead count is missing',
      { ahead: null },
      'PR #9 merged, but ahead count not reported, unpushed commits not ruled out',
    ],
  ] as const)('%s keeps a merged worktree out of safe to remove', (_label, overrides, reason) => {
    const rows = [task('a', { local: [marker(WORKTREE, observed(WORKTREE, overrides))], pullRequests: [merged(9)] })];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({ group: 'needs-a-look', reason });
    expect(itemsOf(rows)).toMatchObject([
      { checkout, commands: [], detail: reason, group: 'needs-a-look', reason, shortPath: 'worktrees/retry' },
    ]);
  });

  test('a commit dated after the merge keeps a merged worktree out of safe to remove', () => {
    const committed = (overrides: Partial<CheckoutStatusObservation>) => [
      mainCheckout(),
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE, { lastCommitAt: daysAgo(1), ...overrides }))],
        pullRequests: [merged(9, { mergedAt: daysAgo(3) })],
      }),
    ];
    expect(classified(committed({}), WORKTREE)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged, but a commit is dated after the merge',
    });
    expect(classified(committed({ dirty: true, untrackedCount: 1 }), WORKTREE)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged, but 1 untracked · a commit is dated after the merge',
    });
    // The merge commit's own instant is not "after" it.
    expect(classified(committed({ lastCommitAt: daysAgo(3) }), WORKTREE).group).toBe('safe-to-remove');
  });

  test('a merge or a last commit whose date was not read keeps a merged worktree out of safe to remove', () => {
    const rows = (commit: Partial<CheckoutStatusObservation>, pr: Partial<PullRequestObservation>) => [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE, commit))], pullRequests: [merged(9, pr)] }),
    ];
    const unread = { group: 'needs-a-look', reason: 'PR #9 merged, but commit chronology not read' } as const;
    expect(classified(rows({ lastCommitAt: null }, {}), WORKTREE)).toEqual(unread);
    expect(classified(rows({}, { mergedAt: null }), WORKTREE)).toEqual(unread);
    expect(classified(rows({ lastCommitAt: null }, { mergedAt: null }), WORKTREE)).toEqual(unread);
    expect(classified(rows({ lastCommitAt: null, dirty: true, untrackedCount: 1 }, {}), WORKTREE)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged, but 1 untracked · commit chronology not read',
    });
    expect(itemAt(rows({ lastCommitAt: null }, {}), WORKTREE).commands).toEqual([]);
  });

  test('a recent linked session keeps a merged, clean worktree out of safe to remove', () => {
    const rows = (days: number) => [
      mainCheckout(),
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE), { lastSessionActivityAt: daysAgo(days) })],
        pullRequests: [merged(9)],
      }),
    ];
    expect(classified(rows(2), WORKTREE)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged, but a linked session ran 2 days ago',
    });
    expect(classified(rows(0.25), WORKTREE)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged, but a linked session ran less than a day ago',
    });
    expect(itemAt(rows(2), WORKTREE).commands).toEqual([]);
    // The same seven-day window as a checkout without pull request.
    expect(classified(rows(7), WORKTREE).group).toBe('needs-a-look');
    expect(classified(rows(7.01), WORKTREE).group).toBe('safe-to-remove');
  });

  test('a merged checkout on a base branch is never offered a branch deletion', () => {
    const path = `${ROOT}/.claude/worktrees/develop`;
    const rows = [
      mainCheckout(),
      task('a', {
        local: [
          marker(path, observed(path, { branch: 'develop', upstream: 'origin/develop' }), {
            key: branchKey('develop'),
          }),
        ],
        pullRequests: [merged(9, { baseRef: 'main', headRef: 'develop' })],
      }),
      // Another pull request targets develop: it is a base branch of this project.
      task('b', { pullRequests: [pullRequest(12, { baseRef: 'develop', headRef: 'feat/next' })] }),
    ];
    const checkout = checkoutAt(rows, path);
    expect(checkout).toMatchObject({ branch: 'develop', onBaseBranch: true, role: 'worktree' });
    expect(checkout.pullRequest).toMatchObject({ number: 9, state: 'merged' });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged and clean; on base branch develop, which other pull requests target',
    });
    expect(itemAt(rows, path).commands).toEqual([]);
  });

  test('a merged pull request whose fork status was not read is not safe', () => {
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [withoutForkStatus(merged(9))] }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout.pullRequest).toMatchObject({ headInRepository: false, number: 9, state: 'merged' });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'needs-a-look',
      reason: "PR #9 merged and clean; whether its head branch is a fork's was not read",
    });
    expect(itemAt(rows, WORKTREE).commands).toEqual([]);
  });

  test('a merged, clean, pushed main checkout is not offered for removal', () => {
    const child = `${ROOT}/.claude/worktrees/other`;
    const rows = [
      task('a', { local: [marker(ROOT, observed(ROOT))], pullRequests: [merged(9)] }),
      task('b', { local: [marker(child, observed(child, { branch: 'feat/x' }), { key: branchKey('feat/x') })] }),
    ];
    const checkout = checkoutAt(rows, ROOT);
    expect(checkout.role).toBe('primary');
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged and clean; main checkout, switch branch instead of removing',
    });
    expect(diskRemovalCommands(checkout)).toEqual([]);
  });

  test('a merged, clean, pushed checkout of unknown role is not offered for removal', () => {
    const path = '/home/dev/Projects/standalone';
    const rows = [task('a', { local: [marker(path, observed(path))], pullRequests: [merged(9)] })];
    const checkout = checkoutAt(rows, path);
    expect(checkout).toMatchObject({ role: 'unknown', repositoryRoot: null });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #9 merged and clean; the read does not say whether this is a linked worktree',
    });
    expect(diskRemovalCommands(checkout)).toEqual([]);
  });

  test('removal commands are refused for a worktree that is not provably on its observed branch', () => {
    const rows = [mainCheckout(), task('a', { local: [marker(WORKTREE, failed(WORKTREE, 'missing'))] })];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({ role: 'worktree', branch: 'fix/retry', branchSource: 'link' });
    expect(diskRemovalCommands(checkout)).toEqual([]);
  });
});

describe('disk lens: pull request attribution', () => {
  test('a checkout now on another branch does not inherit the linked task merged pull request', () => {
    const rows = [
      task('a', {
        local: [
          marker(WORKTREE, observed(WORKTREE, { branch: 'feat/completion', lastCommitAt: daysAgo(30) }), {
            key: branchKey('feat/v1'),
          }),
        ],
        pullRequests: [merged(1, { headRef: 'feat/v1' })],
      }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({ branch: 'feat/completion', branchSource: 'observed', pullRequest: null });
    const { group, reason } = classifyDiskCheckout(checkout, NOW);
    expect(group).toBe('needs-a-look');
    expect(reason).toBe('No pull request · quiet for 30 days');
  });

  test('a detached clean checkout linked from a merged task is never safe', () => {
    const rows = [
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE, { ahead: null, behind: null, branch: null, upstream: null }))],
        pullRequests: [merged(9)],
      }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({ branch: null, branchSource: null, pullRequest: null });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'needs-a-look',
      reason: 'Detached HEAD · No pull request · quiet for 40 days',
    });
    expect(diskRemovalCommands(checkout)).toEqual([]);
  });

  test('a pull request from a fork with the same head name is not attributed', () => {
    const rows = [
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE))],
        pullRequests: [merged(9, { crossRepository: true })],
      }),
    ];
    expect(checkoutAt(rows, WORKTREE).pullRequest).toBeNull();
    expect(classified(rows, WORKTREE).group).toBe('needs-a-look');
  });

  test('a pull request of another repository with the same head branch name is not attributed', () => {
    const rows = [
      mainCheckout(),
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE))],
        pullRequests: [merged(9, { repository: 'acme/other' }), merged(10, { host: 'git.example.com' })],
      }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({ pullRequest: null, repository: 'github.com/acme/shop', role: 'worktree' });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'needs-a-look',
      reason: 'No pull request · quiet for 40 days',
    });
  });

  test('the repository is compared without regard to case', () => {
    const rows = [
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE))],
        pullRequests: [merged(9, { host: 'GitHub.com', repository: 'Acme/Shop' })],
      }),
    ];
    expect(checkoutAt(rows, WORKTREE).pullRequest).toMatchObject({ number: 9, state: 'merged' });
  });

  test('a checkout whose repository no branch link names gets no pull request', () => {
    const session = sessionLinkKey({ harness: 'claude', machineId: MACHINE, sessionId: 's1' });
    const rows = [
      mainCheckout(),
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE), { key: session, via: 'session-checkout' })],
        pullRequests: [merged(9)],
      }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({ branch: 'fix/retry', pullRequest: null, repository: null });
    expect(classifyDiskCheckout(checkout, NOW).group).toBe('needs-a-look');
  });

  test('a checkout whose branch links name two repositories gets no pull request', () => {
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [merged(9)] }),
      task('b', {
        local: [
          marker(WORKTREE, observed(WORKTREE), {
            key: branchLinkKey({ host: HOST, ref: 'fix/retry', repository: 'acme/other' }),
          }),
        ],
      }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({ pullRequest: null, repository: null });
    expect(classifyDiskCheckout(checkout, NOW).group).toBe('needs-a-look');
  });

  test('an open pull request another task holds on the same repository and branch keeps the checkout in use', () => {
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [merged(9)] }),
      task('elsewhere', { pullRequests: [pullRequest(12)] }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout.pullRequest).toMatchObject({ number: 12, state: 'open' });
    expect(checkout.tasks.map((named) => named.threadId)).toEqual(['a']);
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({ group: 'in-use', reason: 'PR #12 open' });
    expect(itemAt(rows, WORKTREE).commands).toEqual([]);
  });

  test('an open pull request wins over a merged one, and the most recently observed over an older one', () => {
    const open = task('a', {
      local: [marker(WORKTREE, observed(WORKTREE))],
      pullRequests: [merged(9), pullRequest(12, { draft: true })],
    });
    expect(checkoutAt([open], WORKTREE).pullRequest).toMatchObject({ number: 12, state: 'open', draft: true });
    const closedTwice = task('a', {
      local: [marker(WORKTREE, observed(WORKTREE))],
      pullRequests: [
        pullRequest(3, { observedAt: daysAgo(5), state: 'CLOSED' }),
        pullRequest(4, { observedAt: daysAgo(1), state: 'CLOSED' }),
      ],
    });
    expect(checkoutAt([closedTwice], WORKTREE).pullRequest).toMatchObject({ number: 4, state: 'closed' });
    const mergedAndClosed = task('a', {
      local: [marker(WORKTREE, observed(WORKTREE))],
      pullRequests: [pullRequest(4, { state: 'CLOSED' }), merged(9, { observedAt: daysAgo(6) })],
    });
    expect(checkoutAt([mergedAndClosed], WORKTREE).pullRequest).toMatchObject({ number: 9, state: 'merged' });
  });

  test('a failed pull request read keeps the last successful observation', () => {
    const base = merged(9);
    const rows = [
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE))],
        pullRequests: [
          {
            ...base,
            latest: base.latest && { ...base.latest, headRef: null, mergedAt: null, outcome: 'timeout', state: null },
          },
        ],
      }),
    ];
    expect(checkoutAt(rows, WORKTREE).pullRequest).toMatchObject({ number: 9, state: 'merged' });
  });
});

describe('disk lens: in use', () => {
  test('an open pull request keeps even a dirty checkout in use', () => {
    const rows = [
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE, { ahead: 3, dirty: true, modifiedCount: 4 }))],
        pullRequests: [pullRequest(12)],
      }),
    ];
    expect(classified(rows, WORKTREE)).toEqual({ group: 'in-use', reason: 'PR #12 open' });
    const draft = [
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [pullRequest(12, { draft: true })] }),
    ];
    expect(classified(draft, WORKTREE)).toEqual({ group: 'in-use', reason: 'PR #12 open (draft)' });
  });

  test('a recent session keeps a checkout without pull request in use', () => {
    const rows = [task('a', { local: [marker(WORKTREE, observed(WORKTREE), { lastSessionActivityAt: daysAgo(2) })] })];
    expect(classified(rows, WORKTREE)).toEqual({ group: 'in-use', reason: 'Session 2 days ago' });
  });

  test('a recent commit counts as activity when it is later than the last session', () => {
    const rows = [
      task('a', {
        local: [
          marker(WORKTREE, observed(WORKTREE, { lastCommitAt: daysAgo(3) }), { lastSessionActivityAt: daysAgo(20) }),
        ],
      }),
    ];
    expect(classified(rows, WORKTREE)).toEqual({ group: 'in-use', reason: 'Commit 3 days ago' });
  });

  test('activity under a day old says so instead of "0 days ago"', () => {
    const rows = [
      task('a', { local: [marker(WORKTREE, observed(WORKTREE), { lastSessionActivityAt: daysAgo(0.25) })] }),
    ];
    expect(classified(rows, WORKTREE)).toEqual({ group: 'in-use', reason: 'Session less than a day ago' });
  });

  test('the recent-activity window is the stale threshold of the Work view', () => {
    expect(DISK_RECENT_ACTIVITY_MS).toBe(7 * DAY_MS);
    const at = (days: number) => [
      task('a', { local: [marker(WORKTREE, observed(WORKTREE), { lastSessionActivityAt: daysAgo(days) })] }),
    ];
    expect(classified(at(7), WORKTREE).group).toBe('in-use');
    expect(classified(at(7.01), WORKTREE).group).toBe('needs-a-look');
  });

  test('a clean, pushed base branch is in use however old', () => {
    const rows = [
      task('a', {
        local: [marker(ROOT, observed(ROOT, { branch: 'main', upstream: 'origin/main' }), { key: branchKey('x') })],
      }),
      task('b', { pullRequests: [merged(9, { baseRef: 'main' })] }),
    ];
    const checkout = checkoutAt(rows, ROOT);
    expect(checkout.onBaseBranch).toBe(true);
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'in-use',
      reason: 'On base branch main, clean and pushed',
    });
  });

  test('a base branch with staged files needs a look', () => {
    const rows = [
      task('a', {
        local: [
          marker(ROOT, observed(ROOT, { branch: 'main', dirty: true, stagedCount: 2, upstream: 'origin/main' }), {
            key: branchKey('x'),
          }),
        ],
        pullRequests: [merged(9, { baseRef: 'main' })],
      }),
    ];
    expect(classified(rows, ROOT)).toEqual({
      group: 'needs-a-look',
      reason: 'No pull request · quiet for 40 days',
    });
  });

  test('a base branch of another project is not this checkout base branch', () => {
    const rows = [
      task('a', {
        local: [marker(ROOT, observed(ROOT, { branch: 'main', upstream: 'origin/main' }), { key: branchKey('x') })],
      }),
      task('b', { project: 'acme/other', pullRequests: [merged(9, { baseRef: 'main' })] }),
    ];
    expect(checkoutAt(rows, ROOT).onBaseBranch).toBe(false);
    expect(classified(rows, ROOT).group).toBe('needs-a-look');
  });
});

describe('disk lens: needs a look', () => {
  test('a branch without pull request gone quiet needs a look', () => {
    const rows = [
      task('a', {
        local: [
          marker(WORKTREE, observed(WORKTREE, { lastCommitAt: daysAgo(45) }), { lastSessionActivityAt: daysAgo(30) }),
        ],
      }),
    ];
    expect(classified(rows, WORKTREE)).toEqual({
      group: 'needs-a-look',
      reason: 'No pull request · quiet for 30 days',
    });
  });

  test('a checkout without any dated activity needs a look', () => {
    const rows = [task('a', { local: [marker(WORKTREE, observed(WORKTREE, { lastCommitAt: null }))] })];
    expect(classified(rows, WORKTREE)).toEqual({
      group: 'needs-a-look',
      reason: 'No pull request · no dated activity',
    });
  });

  test('a pull request closed without merge is named; what is left stays in the disk state', () => {
    const rows = [
      task('a', {
        local: [marker(WORKTREE, observed(WORKTREE, { ahead: 2, dirty: true, untrackedCount: 1 }))],
        pullRequests: [pullRequest(66, { state: 'CLOSED' })],
      }),
    ];
    expect(classified(rows, WORKTREE)).toEqual({
      group: 'needs-a-look',
      reason: 'PR #66 closed without merge · quiet for 40 days',
    });
    expect(describeDiskState(checkoutAt(rows, WORKTREE).state).words).toBe('1 untracked · 2 ahead');
  });
});

describe('disk lens: gone from disk', () => {
  test('a missing checkout is gone, with the branch it was last seen on and that branch pull request', () => {
    const last = observed(WORKTREE, { branch: 'fix/seen', observedAt: daysAgo(9) });
    const rows = [
      mainCheckout(),
      task('a', {
        local: [marker(WORKTREE, failed(WORKTREE, 'missing'), { latestSuccessful: last })],
        pullRequests: [merged(9, { headRef: 'fix/seen' })],
      }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({
      branch: 'fix/seen',
      branchSource: 'last-seen',
      lastPresentAt: daysAgo(9),
      observedAt: daysAgo(0),
      pullRequest: { number: 9, state: 'merged' },
      role: 'worktree',
      state: { kind: 'absent' },
    });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({ group: 'gone', reason: 'No longer on disk' });
    expect(diskRemovalCommands(checkout)).toEqual([]);
    expect(itemAt(rows, WORKTREE)).toMatchObject({
      commands: [],
      detail: 'No longer on disk',
      disk: { glyph: '✕', tone: 'absent', words: 'Absent' },
    });
  });

  test('a missing checkout never read successfully takes its branch from the task link', () => {
    const rows = [task('a', { local: [marker(WORKTREE, failed(WORKTREE, 'missing'))] })];
    expect(checkoutAt(rows, WORKTREE)).toMatchObject({
      branch: 'fix/retry',
      branchSource: 'link',
      lastPresentAt: null,
      pullRequest: null,
    });
    expect(classified(rows, WORKTREE).group).toBe('gone');
    const closed = [
      task('a', {
        local: [marker(WORKTREE, failed(WORKTREE, 'missing'))],
        pullRequests: [pullRequest(66, { state: 'CLOSED' })],
      }),
    ];
    expect(checkoutAt(closed, WORKTREE)).toMatchObject({
      branchSource: 'link',
      pullRequest: { number: 66, state: 'closed' },
    });
    expect(classified(closed, WORKTREE)).toEqual({ group: 'gone', reason: 'No longer on disk' });
  });

  test('links naming two branches, or a session checkout, leave the branch unknown', () => {
    const two = [
      task('a', { local: [marker(WORKTREE, failed(WORKTREE, 'missing'))] }),
      task('b', { local: [marker(WORKTREE, failed(WORKTREE, 'missing'), { key: branchKey('fix/other') })] }),
    ];
    expect(checkoutAt(two, WORKTREE)).toMatchObject({ branch: null, branchSource: null });
    const session = [
      task('a', {
        local: [
          marker(WORKTREE, failed(WORKTREE, 'missing'), {
            key: sessionLinkKey({ harness: 'claude', machineId: MACHINE, sessionId: 's1' }),
            via: 'session-checkout',
          }),
        ],
      }),
    ];
    expect(checkoutAt(session, WORKTREE)).toMatchObject({ branch: null, branchSource: null });
  });
});

describe('disk lens: not read', () => {
  test('a checkout never observed is not read, and still has its path', () => {
    const rows = [task('a', { local: [marker(WORKTREE, null)], pullRequests: [merged(9)] })];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({
      branch: 'fix/retry',
      branchSource: 'link',
      observedAt: null,
      pullRequest: { number: 9, state: 'merged' },
      state: { kind: 'not-read', reason: 'never-observed' },
    });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({ group: 'not-read', reason: 'Never observed' });
    expect(diskRemovalCommands(checkout)).toEqual([]);
  });

  test('a timed-out read stays not read despite an older clean observation and a merged pull request', () => {
    const clean = observed(WORKTREE, { observedAt: daysAgo(2) });
    const rows = [
      mainCheckout(),
      task('a', {
        local: [marker(WORKTREE, failed(WORKTREE, 'timeout'), { latestSuccessful: clean })],
        pullRequests: [merged(9)],
      }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({
      branch: 'fix/retry',
      branchSource: 'last-seen',
      lastPresentAt: daysAgo(2),
      pullRequest: { number: 9, state: 'merged' },
      role: 'worktree',
      state: { kind: 'not-read', reason: 'timeout' },
    });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({ group: 'not-read', reason: 'Read timed out' });
    expect(diskRemovalCommands(checkout)).toEqual([]);
    // The reason is the state: the row does not say it twice.
    expect(itemAt(rows, WORKTREE)).toMatchObject({
      commands: [],
      detail: null,
      disk: { glyph: '?', tone: 'not-read', words: 'Read timed out' },
    });
  });

  test('an observed checkout whose state git did not report is not read', () => {
    const unreported = { dirty: null, modifiedCount: null, stagedCount: null, untrackedCount: null };
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE, unreported))], pullRequests: [merged(9)] }),
    ];
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout.role).toBe('worktree');
    expect(checkout.state).toEqual({ kind: 'not-read', reason: 'state-not-reported' });
    expect(checkout.pullRequest).toMatchObject({ number: 9, state: 'merged' });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({ group: 'not-read', reason: 'State not reported' });
    expect(diskRemovalCommands(checkout)).toEqual([]);
  });

  test('zero counts for only some kinds of change do not establish a clean tree', () => {
    const partial = { dirty: null, modifiedCount: 0, stagedCount: null, untrackedCount: null };
    const rows = [task('a', { local: [marker(WORKTREE, observed(WORKTREE, partial))], pullRequests: [merged(9)] })];
    expect(checkoutAt(rows, WORKTREE).state).toEqual({ kind: 'not-read', reason: 'state-not-reported' });
    const counted = { dirty: null, modifiedCount: 0, stagedCount: 0, untrackedCount: 0 };
    const complete = [task('a', { local: [marker(WORKTREE, observed(WORKTREE, counted))] })];
    expect(checkoutAt(complete, WORKTREE).state).toMatchObject({ kind: 'present', changes: false });
    const some = { dirty: null, modifiedCount: 3, stagedCount: null, untrackedCount: null };
    const changed = [task('a', { local: [marker(WORKTREE, observed(WORKTREE, some))] })];
    expect(checkoutAt(changed, WORKTREE).state).toMatchObject({ kind: 'present', changes: true, modified: 3 });
  });

  test.each([
    ['not-a-repository', 'Not a git repository'],
    ['denied', 'Permission denied'],
    ['invalid', 'git status unreadable'],
  ] as const)('a %s read is not read', (outcome, reason) => {
    const rows = [task('a', { local: [marker(WORKTREE, failed(WORKTREE, outcome))], pullRequests: [merged(9)] })];
    expect(classified(rows, WORKTREE)).toEqual({ group: 'not-read', reason });
  });

  test('no checkout without a read state is classified outside not read', () => {
    const base: DiskCheckout = checkoutAt(
      [
        task('a', {
          local: [marker(WORKTREE, observed(WORKTREE), { lastSessionActivityAt: daysAgo(1) })],
          pullRequests: [merged(9)],
        }),
      ],
      WORKTREE,
    );
    for (const reason of [
      'never-observed',
      'timeout',
      'denied',
      'invalid',
      'not-a-repository',
      'state-not-reported',
    ] as const) {
      expect(classifyDiskCheckout({ ...base, state: { kind: 'not-read', reason } }, NOW).group).toBe('not-read');
    }
  });
});

describe('disk lens: a read too old to stand for the current state', () => {
  const readAgo = (days: number, pullRequests: readonly WorkThreadPullRequestMarker[] = [merged(9)]) => [
    mainCheckout(),
    task('a', { local: [marker(WORKTREE, observed(WORKTREE, { observedAt: daysAgo(days) }))], pullRequests }),
  ];

  test('the window is the stale threshold of the Work view', () => {
    expect(DISK_STALE_READ_MS).toBe(7 * DAY_MS);
  });

  test('a clean worktree with a merged pull request, last read 70 days ago, is not read', () => {
    const rows = readAgo(70);
    const checkout = checkoutAt(rows, WORKTREE);
    expect(checkout).toMatchObject({ role: 'worktree', state: { changes: false, kind: 'present' } });
    expect(classifyDiskCheckout(checkout, NOW)).toEqual({
      group: 'not-read',
      reason: 'Last read 70 days ago, current state unknown',
    });
    const item = itemAt(rows, WORKTREE);
    expect(item).toMatchObject({
      commands: [],
      detail: 'Current state unknown',
      disk: { glyph: '?', tone: 'not-read', words: 'Last read 70 days ago' },
      group: 'not-read',
    });
    expect(item.disk.words).not.toContain('Clean');
  });

  test('a read exactly as old as the window still stands, one older does not', () => {
    expect(classified(readAgo(7), WORKTREE).group).toBe('safe-to-remove');
    expect(classified(readAgo(7.01), WORKTREE)).toEqual({
      group: 'not-read',
      reason: 'Last read 7 days ago, current state unknown',
    });
    expect(classified(readAgo(8), WORKTREE)).toEqual({
      group: 'not-read',
      reason: 'Last read 8 days ago, current state unknown',
    });
  });

  test('an old read is settled before any pull request rule', () => {
    expect(classified(readAgo(30, [pullRequest(12)]), WORKTREE).group).toBe('not-read');
    expect(classified(readAgo(30, []), WORKTREE).group).toBe('not-read');
  });

  test('a read whose age cannot be computed does not stand either', () => {
    const checkout = checkoutAt(readAgo(0), WORKTREE);
    expect(classifyDiskCheckout(checkout, 'not a date')).toEqual({
      group: 'not-read',
      reason: 'Last read at an unknown time, current state unknown',
    });
  });

  test('a fresh read is worded from its state', () => {
    expect(itemAt(readAgo(0), WORKTREE)).toMatchObject({
      detail: 'PR #9 merged · clean · nothing unpushed',
      disk: { glyph: '✓', tone: 'clean', words: 'Clean' },
    });
    const dirty = [task('a', { local: [marker(WORKTREE, observed(WORKTREE, { dirty: true, untrackedCount: 1 }))] })];
    expect(itemAt(dirty, WORKTREE).disk).toEqual({ glyph: '●', tone: 'changes', words: '1 untracked' });
  });

  test('an absent checkout stays gone whatever the age of the read, which the reason then dates', () => {
    const goneAgo = (days: number) => [
      task('a', { local: [marker(WORKTREE, failed(WORKTREE, 'missing', daysAgo(days)))] }),
    ];
    expect(classified(goneAgo(2), WORKTREE)).toEqual({ group: 'gone', reason: 'No longer on disk' });
    expect(classified(goneAgo(11), WORKTREE)).toEqual({
      group: 'gone',
      reason: 'No longer on disk when last read 11 days ago',
    });
    expect(itemAt(goneAgo(11), WORKTREE)).toMatchObject({
      detail: 'No longer on disk when last read 11 days ago',
      disk: { glyph: '✕', tone: 'absent', words: 'Absent' },
    });
  });
});

describe('disk lens: one row per checkout', () => {
  test('a checkout named by three tasks is one row with the latest of their sessions', () => {
    const status = observed(ROOT, { branch: 'feat/migration', upstream: 'origin/feat/migration' });
    const key = branchKey('feat/migration');
    const rows = [
      task('a', { local: [marker(ROOT, status, { key, lastSessionActivityAt: daysAgo(9) })] }),
      task('b', {
        done: true,
        local: [marker(ROOT, status, { key, lastSessionActivityAt: daysAgo(4) })],
        pullRequests: [pullRequest(12, { headRef: 'feat/migration' })],
      }),
      task('c', { local: [marker(ROOT, status, { key, lastSessionActivityAt: null })] }),
      task('a', { local: [marker(ROOT, status, { key, lastSessionActivityAt: daysAgo(9) })] }),
    ];
    const { checkouts } = diskCheckoutsOf(rows);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toMatchObject({
      lastSessionAt: daysAgo(4),
      path: ROOT,
      project: REPOSITORY,
      tasks: [
        { done: true, threadId: 'b', title: 'Task b' },
        { done: false, threadId: 'a', title: 'Task a' },
        { done: false, threadId: 'c', title: 'Task c' },
      ],
    });
  });

  test('the newest attempt across the tasks decides the state, and a trailing slash is the same path', () => {
    const rows = [
      task('a', { local: [marker(`${WORKTREE}/`, observed(`${WORKTREE}/`, { observedAt: daysAgo(3) }))] }),
      task('b', { local: [marker(WORKTREE, failed(WORKTREE, 'missing', daysAgo(1)))] }),
      task('c', { local: [marker(WORKTREE, null)] }),
    ];
    const { checkouts } = diskCheckoutsOf(rows);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toMatchObject({
      branchSource: 'last-seen',
      lastPresentAt: daysAgo(3),
      observedAt: daysAgo(1),
      path: WORKTREE,
      state: { kind: 'absent' },
    });
  });

  test('the same path on another machine is another checkout', () => {
    const rows = [
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))] }),
      task('b', { local: [marker(WORKTREE, observed(WORKTREE, { machineId: 'machine-b' }))] }),
    ];
    expect(diskCheckoutsOf(rows).checkouts.map((checkout) => checkout.machineId)).toEqual(['machine-a', 'machine-b']);
  });

  test('the project is the first one a linked task names', () => {
    const rows = [
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], project: null }),
      task('b', { local: [marker(WORKTREE, observed(WORKTREE))], project: 'acme/shop' }),
    ];
    expect(checkoutAt(rows, WORKTREE).project).toBe('acme/shop');
  });

  test('counts linked branches no marker locates, once each, and ignores detached links', () => {
    const rows = [
      task('a', {
        links: [
          branchLink('a', 'fix/retry'),
          branchLink('a', 'feat/nowhere'),
          branchLink('a', 'feat/detached', daysAgo(1)),
        ],
        local: [marker(WORKTREE, observed(WORKTREE))],
      }),
      task('b', { links: [branchLink('b', 'feat/nowhere'), branchLink('b', 'feat/pathless')] }),
      task('c', {
        links: [branchLink('c', 'feat/pathless')],
        local: [marker(null, null, { key: branchKey('feat/pathless') })],
      }),
    ];
    const { branchesWithoutCheckout, checkouts } = diskCheckoutsOf(rows);
    expect(checkouts.map((checkout) => checkout.path)).toEqual([WORKTREE]);
    expect(branchesWithoutCheckout).toBe(2);
  });

  test('an empty path names no checkout', () => {
    const rows = [
      task('a', {
        links: [branchLink('a', 'feat/pathless')],
        local: [marker('', null, { key: branchKey('feat/pathless') })],
      }),
    ];
    expect(diskCheckoutsOf(rows)).toEqual({ branchesWithoutCheckout: 1, checkouts: [] });
  });
});

describe('disk lens: presentation', () => {
  test('every group is returned in order, empty ones included', () => {
    const empty = groupDiskCheckouts([], NOW);
    expect(empty.map((group) => group.group)).toEqual([...DISK_GROUPS]);
    expect(empty.map((group) => group.label)).toEqual([
      'Safe to remove',
      'Needs a look',
      'In use',
      'Gone from disk',
      'Not read',
    ]);
    expect(empty.every((group) => group.count === 0 && group.repositories.length === 0)).toBe(true);
    expect(empty.find((group) => group.group === 'not-read')?.note).toBe('State unknown. Not the same as clean.');
  });

  test('the safe group says what was and was not read, without claiming proof', () => {
    const safe = groupDiskCheckouts([], NOW).find((group) => group.group === 'safe-to-remove');
    expect(safe?.note).toBe(
      'Pull request merged, tracked and untracked files clean, nothing unpushed. Ignored files are not read.',
    );
    expect(safe?.empty).toBe(
      'No checkout meets the conditions: a merged pull request, a clean tree, a known upstream with nothing ahead, and a linked worktree.',
    );
    for (const group of groupDiskCheckouts([], NOW)) {
      expect(group.empty.length).toBeGreaterThan(0);
      expect(`${group.note} ${group.empty}`).not.toContain('provably');
    }
  });

  test('repositories are sorted by short label with "No project" last, rows by path', () => {
    const gone = (id: string, path: string, project: string | null) =>
      task(id, { local: [marker(path, failed(path, 'missing'))], project });
    const { checkouts } = diskCheckoutsOf([
      gone('a', '/w/zeta/b', 'acme/zeta'),
      gone('b', '/w/none', null),
      gone('c', '/w/zeta/a', 'acme/zeta'),
      gone('d', '/w/alpha', 'other/Alpha'),
      mainCheckout(),
      task('e', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [merged(9)] }),
    ]);
    const groups = groupDiskCheckouts(checkouts, NOW);
    const goneGroup = groups.find((group) => group.group === 'gone');
    expect(goneGroup?.count).toBe(4);
    expect(goneGroup?.repositories.map((repository) => [repository.label, repository.project])).toEqual([
      ['Alpha', 'other/Alpha'],
      ['zeta', 'acme/zeta'],
      ['No project', null],
    ]);
    expect(goneGroup?.repositories[1]?.items.map((item) => item.checkout.path)).toEqual(['/w/zeta/a', '/w/zeta/b']);
    const safe = groups.find((group) => group.group === 'safe-to-remove');
    expect(safe?.repositories[0]?.items[0]?.commands).toEqual([removal(ROOT, WORKTREE, 'fix/retry')]);
  });

  test('display paths drop the directory every checkout shares', () => {
    const paths = [
      '/home/x/Projects/Github/ai-usage',
      '/home/x/Projects/Github/ai-usage/.claude/worktrees/a',
      '/home/x/Projects/Github/other',
    ];
    const { checkouts } = diskCheckoutsOf(
      paths.map((path, index) => task(`t${index}`, { local: [marker(path, failed(path, 'missing'))] })),
    );
    const short = shortDiskPaths(checkouts);
    expect(checkouts.map((checkout) => short.get(checkout.id))).toEqual([
      'ai-usage',
      'ai-usage/.claude/worktrees/a',
      'other',
    ]);
    const single = diskCheckoutsOf([task('a', { local: [marker(WORKTREE, null)] })]).checkouts;
    expect(shortDiskPaths(single).get(single[0]?.id ?? '')).toBe('worktrees/retry');
  });

  test('the disk state is worded without leaning on colour', () => {
    const stateOf = (overrides: Partial<CheckoutStatusObservation>) =>
      describeDiskState(
        checkoutAt([task('a', { local: [marker(WORKTREE, observed(WORKTREE, overrides))] })], WORKTREE).state,
      );
    expect(stateOf({})).toEqual({ glyph: '✓', words: 'Clean' });
    expect(stateOf({ ahead: 2, behind: 1, dirty: true, modifiedCount: 2, untrackedCount: 1 })).toEqual({
      glyph: '●',
      words: '2 modified · 1 untracked · 2 ahead · 1 behind',
    });
    expect(stateOf({ ahead: null, behind: null, upstream: null })).toEqual({
      glyph: '✓',
      words: 'Clean · no upstream',
    });
    expect(stateOf({ ahead: null })).toEqual({ glyph: '✓', words: 'Clean · ahead not reported' });
    expect(describeDiskState({ kind: 'absent' })).toEqual({ glyph: '✕', words: 'Absent' });
    expect(describeDiskState({ kind: 'not-read', reason: 'denied' })).toEqual({
      glyph: '?',
      words: 'Permission denied',
    });
  });

  test('a pull request is a draft only while it is open', () => {
    expect(describeDiskPullRequest({ draft: true, state: 'open' })).toBe('Draft');
    expect(describeDiskPullRequest({ draft: false, state: 'open' })).toBe('Open');
    expect(describeDiskPullRequest({ draft: true, state: 'merged' })).toBe('Merged');
    expect(describeDiskPullRequest({ draft: false, state: 'closed' })).toBe('Closed');
  });

  test('the lens counts checkouts and named repositories', () => {
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [merged(9)] }),
      task('b', { local: [marker('/w/none', null)], project: null }),
      task('c', {
        links: [branchLink('c', 'feat/nowhere')],
        local: [marker('/w/other', null)],
        project: 'acme/other',
      }),
    ];
    const lens = diskLensOf(rows, NOW, true);
    expect(lens.checkoutCount).toBe(4);
    expect(lens.repositoryCount).toBe(2);
    expect(lens.branchesWithoutCheckout).toBe(1);
    expect(lens.commandsWithheld).toBe(false);
    expect(lens.groups.map((group) => group.count)).toEqual([1, 0, 1, 0, 2]);
    expect(lens.groups[0]?.repositories[0]?.items[0]).toMatchObject({
      commands: [removal(ROOT, WORKTREE, 'fix/retry')],
      shortPath: '/home/dev/Projects/shop/.claude/worktrees/retry',
    });
  });

  test('while tasks remain unread the safe rows are listed without any command', () => {
    const rows = [
      mainCheckout(),
      task('a', { local: [marker(WORKTREE, observed(WORKTREE))], pullRequests: [merged(9)] }),
    ];
    const lens = diskLensOf(rows, NOW, false);
    expect(lens.commandsWithheld).toBe(true);
    expect(lens.groups.map((group) => group.count)).toEqual([1, 0, 1, 0, 0]);
    const items = lens.groups.flatMap((group) => group.repositories.flatMap((repository) => repository.items));
    expect(items.map((item) => item.commands)).toEqual([[], []]);
  });
});

describe('disk lens: how the sources answered', () => {
  const source = (
    name: WorkThreadSourceStatus['source'],
    state: WorkThreadSourceStatus['state'],
    message: string | null = null,
    lastRunAt: CanonicalInstant | null = daysAgo(0),
  ): WorkThreadSourceStatus => ({ lastRunAt, message, source: name, state });

  test('keeps the checkout and session sources, each with the worst state any page reported', () => {
    const truncated = source('checkouts', 'truncated', 'Checkout reads were bounded.');
    expect(
      aggregateDiskSources([
        [source('checkouts', 'ok'), source('sessions', 'ok'), source('github', 'failed', 'No GitHub')],
        [truncated, source('sessions', 'ok'), source('jira', 'disabled')],
        [source('checkouts', 'ok'), source('sessions', 'ok')],
      ]),
    ).toEqual([truncated, source('sessions', 'ok')]);
  });

  test('among pages that did not answer ok, the one with a message is kept', () => {
    const explained = source('sessions', 'truncated', 'Partial linked-session evidence');
    expect(
      aggregateDiskSources([[source('sessions', 'failed')], [explained], [source('sessions', 'unavailable')]]),
    ).toEqual([explained]);
    const noted = source('checkouts', 'ok', 'Read from a cached pass.');
    expect(aggregateDiskSources([[source('checkouts', 'ok')], [noted]])).toEqual([noted]);
    expect(aggregateDiskSources([[source('checkouts', 'failed')], [noted]])).toEqual([source('checkouts', 'failed')]);
  });

  test('a source no page reported is absent, never assumed ok', () => {
    expect(aggregateDiskSources([])).toEqual([]);
    expect(aggregateDiskSources([[source('github', 'ok')]])).toEqual([]);
  });

  test('a source is worded when it did not answer ok or has something to say', () => {
    expect(describeDiskSource(source('checkouts', 'ok'))).toBeNull();
    expect(describeDiskSource(source('sessions', 'ok'))).toBeNull();
    expect(describeDiskSource(source('checkouts', 'ok', 'Read from a cached pass.'))).toBe(
      'Local read ok: Read from a cached pass.',
    );
    expect(describeDiskSource(source('sessions', 'truncated', 'Partial linked-session evidence'))).toBe(
      'Sessions truncated: Partial linked-session evidence',
    );
    expect(describeDiskSource(source('checkouts', 'never-run'))).toBe('Local read never-run.');
  });
});

describe('disk lens: reading every task', () => {
  const pagesOf =
    (next: Readonly<Record<string, string | null>>) =>
    (cursor: string | null): string | null | undefined =>
      next[cursor ?? 'first'];

  test('follows each answered page to the last one', () => {
    expect(diskPageChain(pagesOf({ first: 'b', b: 'c', c: null }))).toEqual({
      complete: true,
      cursors: [null, 'b', 'c'],
    });
    expect(diskPageChain(pagesOf({ first: null }))).toEqual({ complete: true, cursors: [null] });
  });

  test('stays incomplete while a page has not answered', () => {
    expect(diskPageChain(pagesOf({}))).toEqual({ complete: false, cursors: [null] });
    expect(diskPageChain(pagesOf({ first: 'b' }))).toEqual({ complete: false, cursors: [null, 'b'] });
  });

  test('a first page that changes its answer drops the pages read after the old one', () => {
    expect(diskPageChain(pagesOf({ first: 'b2', b: 'c', c: null }))).toEqual({
      complete: false,
      cursors: [null, 'b2'],
    });
  });

  test('stops at the page bound and on a repeated cursor without claiming completeness', () => {
    const endless = diskPageChain((cursor) => `${cursor ?? 'page'}+`);
    expect(endless.complete).toBe(false);
    expect(endless.cursors).toHaveLength(DISK_MAX_PAGES_PER_TAB);
    expect(diskPageChain(pagesOf({ first: 'b', b: 'b' }))).toEqual({ complete: false, cursors: [null, 'b'] });
  });
});
