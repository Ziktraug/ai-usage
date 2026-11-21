import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { CheckoutStatusObservation, PullRequestObservation } from '@ai-usage/report-core/work-attention';
import { parseWorkThreadLinkKey } from '@ai-usage/report-core/work-thread';
import { WORK_THREAD_STALE_AFTER_MS } from '@ai-usage/report-core/work-thread-situation';
import type {
  WorkThreadLocalMarker,
  WorkThreadRow,
  WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import { projectShortLabel } from '../work-thread-model';

/**
 * The Disk lens of the Work view: what is lying around on this machine. One entry per local
 * checkout the followed tasks name, classified by what there is to do with it. The lens is
 * read-only: it never runs git and only words a command the operator may copy.
 *
 * Every rule lives here; the components only render. Nothing is listed as safe to remove unless
 * each condition was read: a checkout whose state was not read, or was read too long ago, is never
 * presented as clean; when the latest attempt failed, an older successful read names the branch it
 * was last seen on and nothing else.
 *
 * What the read does not cover: the checkout observation is `git status` without `--ignored`, so
 * ignored files (`.env`, local stores) are never counted, although removing a worktree deletes them.
 */

export const DISK_GROUPS = ['safe-to-remove', 'needs-a-look', 'in-use', 'gone', 'not-read'] as const;
export type DiskGroup = (typeof DISK_GROUPS)[number];

/** A linked session or commit this recent keeps a checkout without an open pull request "in use". */
export const DISK_RECENT_ACTIVITY_MS = WORK_THREAD_STALE_AFTER_MS;

/**
 * A read older than this no longer stands for the checkout's current state (ADR 0051): the row is
 * shown as not read, whatever the old read said.
 */
export const DISK_STALE_READ_MS = WORK_THREAD_STALE_AFTER_MS;

export type DiskNotReadReason =
  | 'never-observed'
  | 'timeout'
  | 'denied'
  | 'invalid'
  | 'not-a-repository'
  | 'state-not-reported';

export type DiskCheckoutState =
  | {
      readonly ahead: number | null;
      readonly behind: number | null;
      /** True when git reported uncommitted changes, counted or not. */
      readonly changes: boolean;
      readonly kind: 'present';
      readonly modified: number | null;
      readonly staged: number | null;
      readonly untracked: number | null;
      readonly upstream: string | null;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'not-read'; readonly reason: DiskNotReadReason };

export interface DiskTask {
  readonly done: boolean;
  readonly threadId: string;
  readonly title: string;
}

export interface DiskPullRequest {
  readonly draft: boolean;
  /**
   * True when the read said the head branch lives in the repository itself. False when the read did
   * not say (older observations): a fork's pull request is never attributed, but an unread fork
   * status cannot stand for "not a fork".
   */
  readonly headInRepository: boolean;
  readonly mergedAt: CanonicalInstant | null;
  readonly number: number;
  readonly observedAt: CanonicalInstant;
  readonly state: 'open' | 'merged' | 'closed';
  readonly title: string | null;
  readonly url: string | null;
}

export interface DiskCheckout {
  readonly branch: string | null;
  /**
   * Where `branch` comes from: the latest read, an older successful read ("last seen"), or the
   * task's branch link when the checkout was never read successfully. Only `observed` is current.
   */
  readonly branchSource: 'observed' | 'last-seen' | 'link' | null;
  /** Stable key of the checkout: its machine and its path. */
  readonly id: string;
  readonly lastCommitAt: CanonicalInstant | null;
  /** When the checkout was last read successfully; `null` when it never was. */
  readonly lastPresentAt: CanonicalInstant | null;
  readonly lastSessionAt: CanonicalInstant | null;
  readonly machineId: string;
  /** The latest attempt to read the checkout, successful or not; `null` when none was made. */
  readonly observedAt: CanonicalInstant | null;
  /** The observed branch is the base branch of a pull request of the same project. */
  readonly onBaseBranch: boolean;
  readonly path: string;
  readonly project: string | null;
  /**
   * The pull request of the checkout's repository whose head is `branch`; never a task's other pull
   * request, and none when the repository is not established. It is the checkout's current pull
   * request only when `branchSource` is `observed`: for a checkout that is gone or was not read it
   * is the pull request of the branch last known there, and it decides no group.
   */
  readonly pullRequest: DiskPullRequest | null;
  /**
   * `<host>/<owner>/<repo>` in lower case, as the branch links that lead to the checkout name it.
   * `null` when no branch link leads here or when they name two repositories: a branch name alone
   * identifies no repository.
   */
  readonly repository: string | null;
  readonly repositoryRoot: string | null;
  readonly role: 'worktree' | 'primary' | 'unknown';
  readonly state: DiskCheckoutState;
  /** The tasks that name the checkout, those holding its pull request first. */
  readonly tasks: readonly DiskTask[];
}

export interface DiskCheckouts {
  /** Active branch links no marker of any task locates on this machine. Distinct branches. */
  readonly branchesWithoutCheckout: number;
  readonly checkouts: readonly DiskCheckout[];
}

const DAY_MS = 86_400_000;

const TRAILING_SLASHES = /\/+$/;

/** The marker's checkout path without trailing slashes; an empty path names no checkout. */
const markerPath = (marker: WorkThreadLocalMarker): string | null => {
  const path = marker.checkoutPath ?? marker.latest?.checkoutPath ?? marker.latestSuccessful?.checkoutPath ?? null;
  if (path === null || path.length === 0) {
    return null;
  }
  const trimmed = path.replace(TRAILING_SLASHES, '');
  return trimmed.length > 0 ? trimmed : '/';
};

const checkoutId = (machineId: string, path: string): string => JSON.stringify([machineId, path]);

const newest = <Observation extends { readonly observedAt: CanonicalInstant }>(
  observations: readonly (Observation | null)[],
): Observation | null => {
  let latest: Observation | null = null;
  for (const observation of observations) {
    if (
      observation !== null &&
      (latest === null || Date.parse(observation.observedAt) > Date.parse(latest.observedAt))
    ) {
      latest = observation;
    }
  }
  return latest;
};

const latestInstant = (instants: readonly (CanonicalInstant | null)[]): CanonicalInstant | null => {
  let latest: CanonicalInstant | null = null;
  for (const instant of instants) {
    if (instant !== null && (latest === null || Date.parse(instant) > Date.parse(latest))) {
      latest = instant;
    }
  }
  return latest;
};

/**
 * A tree is known only when git said so: changes it reported, an explicit clean flag, or all three
 * kinds counted. Zero for some kinds and nothing for the others is not a clean tree.
 */
const observedState = (observation: CheckoutStatusObservation): DiskCheckoutState => {
  const counts = [observation.stagedCount, observation.modifiedCount, observation.untrackedCount];
  const changes = observation.dirty === true || counts.some((count) => count !== null && count > 0);
  const counted = counts.every((count) => count !== null);
  if (!(changes || observation.dirty === false || counted)) {
    return { kind: 'not-read', reason: 'state-not-reported' };
  }
  return {
    ahead: observation.ahead,
    behind: observation.behind,
    changes,
    kind: 'present',
    modified: observation.modifiedCount,
    staged: observation.stagedCount,
    untracked: observation.untrackedCount,
    upstream: observation.upstream,
  };
};

const stateOf = (latest: CheckoutStatusObservation | null): DiskCheckoutState => {
  if (latest === null) {
    return { kind: 'not-read', reason: 'never-observed' };
  }
  switch (latest.outcome) {
    case 'observed':
      return observedState(latest);
    case 'missing':
      return { kind: 'absent' };
    default:
      return { kind: 'not-read', reason: latest.outcome };
  }
};

/** What the markers' branch links say: the refs they name and the repositories they name them in. */
const branchLinksOf = (
  markers: readonly WorkThreadLocalMarker[],
): { readonly refs: ReadonlySet<string>; readonly repositories: ReadonlySet<string> } => {
  const refs = new Set<string>();
  const repositories = new Set<string>();
  for (const marker of markers) {
    const key = parseWorkThreadLinkKey('branch', marker.key);
    if (key?.kind === 'branch') {
      refs.add(key.ref);
      repositories.add(`${key.host}/${key.repository}`.toLowerCase());
    }
  }
  return { refs, repositories };
};

const onlyOf = (values: ReadonlySet<string>): string | null => {
  const [only] = values;
  return values.size === 1 && only !== undefined ? only : null;
};

const branchOf = (
  latest: CheckoutStatusObservation | null,
  successful: CheckoutStatusObservation | null,
  linkedRefs: ReadonlySet<string>,
): Pick<DiskCheckout, 'branch' | 'branchSource'> => {
  if (latest?.outcome === 'observed') {
    // A detached HEAD is the current fact: no older branch stands in for it.
    return { branch: latest.branch, branchSource: latest.branch === null ? null : 'observed' };
  }
  if (successful !== null && successful.branch !== null) {
    return { branch: successful.branch, branchSource: 'last-seen' };
  }
  const linked = onlyOf(linkedRefs);
  return linked === null ? { branch: null, branchSource: null } : { branch: linked, branchSource: 'link' };
};

const pullRequestState = (observation: PullRequestObservation): DiskPullRequest['state'] | null => {
  if (observation.mergedAt !== null || observation.state === 'MERGED') {
    return 'merged';
  }
  if (observation.state === 'OPEN') {
    return 'open';
  }
  // A successful read without a state establishes nothing about the pull request.
  return observation.state === 'CLOSED' ? 'closed' : null;
};

const PULL_REQUEST_PREFERENCE = { open: 0, merged: 1, closed: 2 } as const satisfies Record<
  DiskPullRequest['state'],
  number
>;

interface AttributedPullRequest {
  readonly pullRequest: DiskPullRequest;
  /** The tasks that hold the pull request, whether or not they name the checkout. */
  readonly threadIds: ReadonlySet<string>;
}

/**
 * The pull request of this repository whose head is this branch, among those of every task read. A
 * branch name identifies nothing across repositories, so the repository must match as well; a task
 * that names the checkout and has a merged pull request says nothing about a checkout that has since
 * moved to another branch; and a fork's head branch shares only a name with this repository's.
 *
 * Every task is searched, not only those naming the checkout: an open pull request another task
 * holds on the same branch still means the branch is in use.
 */
const attributePullRequest = (
  repository: string,
  branch: string,
  tasks: readonly WorkThreadRow[],
): AttributedPullRequest | null => {
  const candidates = new Map<number, { pullRequest: DiskPullRequest; threadIds: Set<string> }>();
  for (const row of tasks) {
    for (const marker of row.markers.pullRequests) {
      const observation = marker.latestSuccessful;
      if (
        observation === null ||
        observation.headRef !== branch ||
        observation.crossRepository === true ||
        `${observation.host}/${observation.repository}`.toLowerCase() !== repository
      ) {
        continue;
      }
      const state = pullRequestState(observation);
      if (state === null) {
        continue;
      }
      const known = candidates.get(observation.number);
      if (known && Date.parse(known.pullRequest.observedAt) >= Date.parse(observation.observedAt)) {
        known.threadIds.add(row.thread.threadId);
        continue;
      }
      candidates.set(observation.number, {
        pullRequest: {
          draft: observation.draft === true,
          headInRepository: observation.crossRepository === false,
          mergedAt: observation.mergedAt,
          number: observation.number,
          observedAt: observation.observedAt,
          state,
          title: observation.title,
          url: observation.url,
        },
        threadIds: new Set([...(known?.threadIds ?? []), row.thread.threadId]),
      });
    }
  }
  const [preferred] = [...candidates.values()].sort(
    (left, right) =>
      PULL_REQUEST_PREFERENCE[left.pullRequest.state] - PULL_REQUEST_PREFERENCE[right.pullRequest.state] ||
      Date.parse(right.pullRequest.observedAt) - Date.parse(left.pullRequest.observedAt),
  );
  return preferred ?? null;
};

interface CheckoutEvidence {
  readonly machineId: string;
  readonly markers: WorkThreadLocalMarker[];
  readonly path: string;
  /** The tasks that name the checkout. */
  readonly rows: WorkThreadRow[];
}

type UnplacedCheckout = Omit<DiskCheckout, 'repositoryRoot' | 'role'>;

const checkoutOf = (
  evidence: CheckoutEvidence,
  tasks: readonly WorkThreadRow[],
  baseRefsByProject: ReadonlyMap<string, ReadonlySet<string>>,
): UnplacedCheckout => {
  const { markers, rows } = evidence;
  const latest = newest(markers.map((marker) => marker.latest));
  const successful = newest(
    markers.flatMap((marker) => [
      marker.latestSuccessful,
      marker.latest?.outcome === 'observed' ? marker.latest : null,
    ]),
  );
  const links = branchLinksOf(markers);
  const repository = onlyOf(links.repositories);
  const { branch, branchSource } = branchOf(latest, successful, links.refs);
  const project = rows.map((row) => row.thread.projectLabel).find((label) => label !== null) ?? null;
  const observedBranch = branchSource === 'observed' ? branch : null;
  const attributed = repository === null || branch === null ? null : attributePullRequest(repository, branch, tasks);
  const named = rows.map((row) => ({
    done: row.thread.followState === 'done',
    threadId: row.thread.threadId,
    title: row.thread.title,
  }));
  return {
    branch,
    branchSource,
    id: checkoutId(evidence.machineId, evidence.path),
    lastCommitAt: successful?.lastCommitAt ?? null,
    lastPresentAt: successful?.observedAt ?? null,
    lastSessionAt: latestInstant(markers.map((marker) => marker.lastSessionActivityAt)),
    machineId: evidence.machineId,
    observedAt: latest?.observedAt ?? null,
    onBaseBranch:
      observedBranch !== null && project !== null && (baseRefsByProject.get(project)?.has(observedBranch) ?? false),
    path: evidence.path,
    project,
    pullRequest: attributed?.pullRequest ?? null,
    repository,
    state: stateOf(latest),
    tasks: attributed
      ? [
          ...named.filter((task) => attributed.threadIds.has(task.threadId)),
          ...named.filter((task) => !attributed.threadIds.has(task.threadId)),
        ]
      : named,
  };
};

const WORKTREE_DIRECTORY = /^(.+)\/\.[^/]+\/worktrees\/[^/]+$/;

/**
 * Whether a checkout is a linked worktree or its repository's main checkout. The checkout
 * observation (`git status`) does not say, and it answers the same in any subdirectory, so nothing
 * is inferred from one path lying inside another: a session's working directory inside a worktree,
 * or a repository nested in another, is neither.
 *
 * A checkout is a `worktree` only when its path is shaped `<root>/.<dir>/worktrees/<name>` (the
 * layout the harnesses create, e.g. `.claude/worktrees/x`) and `<root>` is itself a listed checkout
 * of the same machine that was read present; `<root>` is then its repository root and a `primary`.
 * A root that is not listed, was never read, is gone, failed to read or is not a repository leaves
 * the checkout `unknown`, which is never offered for removal.
 */
const placeCheckouts = (checkouts: readonly UnplacedCheckout[]): readonly DiskCheckout[] => {
  const present = new Set(
    checkouts.filter((checkout) => checkout.state.kind === 'present').map((checkout) => checkout.id),
  );
  const rootOf = (checkout: UnplacedCheckout): string | null => {
    const root = WORKTREE_DIRECTORY.exec(checkout.path)?.[1];
    return root !== undefined && present.has(checkoutId(checkout.machineId, root)) ? root : null;
  };
  const roots = new Set(
    checkouts.flatMap((checkout) => {
      const root = rootOf(checkout);
      return root === null ? [] : [checkoutId(checkout.machineId, root)];
    }),
  );
  return checkouts.map((checkout) => {
    const root = rootOf(checkout);
    if (root !== null) {
      return { ...checkout, repositoryRoot: root, role: 'worktree' };
    }
    return { ...checkout, repositoryRoot: null, role: roots.has(checkout.id) ? 'primary' : 'unknown' };
  });
};

const comparePaths = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** One checkout per machine and path, whatever the number of tasks and markers that name it. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
export const diskCheckoutsOf = (rows: readonly WorkThreadRow[]): DiskCheckouts => {
  const tasks = [...new Map(rows.map((row) => [row.thread.threadId, row])).values()];
  const evidence = new Map<string, CheckoutEvidence>();
  const locatedBranches = new Set<string>();
  const baseRefsByProject = new Map<string, Set<string>>();
  for (const row of tasks) {
    for (const marker of row.markers.local) {
      const path = markerPath(marker);
      if (path === null) {
        continue;
      }
      locatedBranches.add(marker.key);
      const machineId = marker.latest?.machineId ?? marker.latestSuccessful?.machineId ?? row.thread.machineId;
      const id = checkoutId(machineId, path);
      const entry = evidence.get(id) ?? { machineId, markers: [], path, rows: [] };
      entry.markers.push(marker);
      if (!entry.rows.includes(row)) {
        entry.rows.push(row);
      }
      evidence.set(id, entry);
    }
    const project = row.thread.projectLabel;
    if (project !== null) {
      const baseRefs = baseRefsByProject.get(project) ?? new Set<string>();
      for (const marker of row.markers.pullRequests) {
        const baseRef = marker.latestSuccessful?.baseRef ?? null;
        if (baseRef !== null) {
          baseRefs.add(baseRef);
        }
      }
      baseRefsByProject.set(project, baseRefs);
    }
  }
  const unlocated = new Set(
    tasks.flatMap((row) =>
      row.links
        .filter((link) => link.kind === 'branch' && link.detachedAt === null && !locatedBranches.has(link.key))
        .map((link) => link.key),
    ),
  );
  const checkouts = placeCheckouts([...evidence.values()].map((entry) => checkoutOf(entry, tasks, baseRefsByProject)));
  return {
    branchesWithoutCheckout: unlocated.size,
    checkouts: checkouts.toSorted(
      (left, right) => comparePaths(left.path, right.path) || left.machineId.localeCompare(right.machineId),
    ),
  };
};

const NOT_READ_REASONS = {
  denied: 'Permission denied',
  invalid: 'git status unreadable',
  'never-observed': 'Never observed',
  'not-a-repository': 'Not a git repository',
  'state-not-reported': 'State not reported',
  timeout: 'Read timed out',
} as const satisfies Record<DiskNotReadReason, string>;

type PresentState = Extract<DiskCheckoutState, { readonly kind: 'present' }>;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * "1 staged · 2 modified", worded as `describeCheckoutState` words a checkout on the other Work
 * surfaces. A kind git did not count is left out, never shown as zero.
 */
const changeWords = (state: PresentState): string => {
  const counted = (
    [
      [state.staged, 'staged'],
      [state.modified, 'modified'],
      [state.untracked, 'untracked'],
    ] as const
  ).flatMap(([count, kind]) => (count !== null && count > 0 ? [`${count} ${kind}`] : []));
  return counted.length > 0 ? counted.join(' · ') : 'uncommitted changes, counts not reported';
};

/** Commits that may exist only here. No upstream means unknown, never zero. */
const unpushedWords = (state: PresentState): string | null => {
  if (state.ahead !== null) {
    return state.ahead > 0 ? `${plural(state.ahead, 'commit')} not pushed` : null;
  }
  return state.upstream === null
    ? 'no upstream, unpushed commits not ruled out'
    : 'ahead count not reported, unpushed commits not ruled out';
};

const leftovers = (state: PresentState): readonly string[] => {
  const unpushed = unpushedWords(state);
  return [...(state.changes ? [changeWords(state)] : []), ...(unpushed === null ? [] : [unpushed])];
};

/**
 * When the latest read is too old to stand for the current state: how long ago it was, in words
 * ("70 days ago"). `null` for a read within the window. An age that cannot be computed is too old
 * as well: freshness that was not established is not assumed.
 */
const staleReadAge = (checkout: Pick<DiskCheckout, 'observedAt'>, now: string): string | null => {
  const ageMs = checkout.observedAt === null ? Number.NaN : Date.parse(now) - Date.parse(checkout.observedAt);
  if (ageMs <= DISK_STALE_READ_MS) {
    return null;
  }
  return Number.isFinite(ageMs) ? `${plural(Math.floor(ageMs / DAY_MS), 'day')} ago` : 'at an unknown time';
};

/** Characters single quotes do not carry the same way in every shell the operator may paste into. */
const defeatsQuoting = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return character === '\\' || code < 32 || code === 127;
  });

const SHELL_SAFE = /^[A-Za-z0-9_./@:+-]+$/;
const shellQuote = (value: string): string =>
  SHELL_SAFE.test(value) && !value.startsWith('-') ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;

/**
 * The command that removes a worktree and then its branch, for the operator to copy; nothing here
 * runs it. One line: the branch is deleted only when the removal succeeded. Both are git's refusing
 * forms (`worktree remove` refuses a worktree with modified or untracked files, `branch -d` an
 * unmerged branch), every operand follows `--`, and nothing is forced.
 *
 * Empty unless the checkout is a worktree with a known repository root, present on disk and read on
 * the branch named. Empty as well when an operand holds a backslash or a control character: single
 * quotes are not read alike by POSIX shells and fish, so such a path is left to the operator.
 *
 * This words the command; whether it is offered is `classifyDiskCheckout`'s decision, which has the
 * date and the pull request.
 */
export const diskRemovalCommands = (checkout: DiskCheckout): readonly string[] => {
  const { branch, path, repositoryRoot } = checkout;
  if (
    checkout.state.kind !== 'present' ||
    checkout.role !== 'worktree' ||
    repositoryRoot === null ||
    branch === null ||
    checkout.branchSource !== 'observed' ||
    [repositoryRoot, path, branch].some(defeatsQuoting)
  ) {
    return [];
  }
  const git = `git -C ${shellQuote(repositoryRoot)}`;
  return [`${git} worktree remove -- ${shellQuote(path)} && ${git} branch -d -- ${shellQuote(branch)}`];
};

export interface DiskClassification {
  readonly group: DiskGroup;
  readonly reason: string;
}

const ageWords = (ageMs: number): string => {
  const days = Math.floor(ageMs / DAY_MS);
  return days < 1 ? 'less than a day' : plural(days, 'day');
};

/**
 * Whether a commit follows the merge. A merge or a last commit whose date was not read answers
 * nothing: an unread date never stands for "no commit after the merge".
 */
const commitChronology = (checkout: DiskCheckout, pullRequest: DiskPullRequest): readonly string[] => {
  const mergedMs = pullRequest.mergedAt === null ? Number.NaN : Date.parse(pullRequest.mergedAt);
  const commitMs = checkout.lastCommitAt === null ? Number.NaN : Date.parse(checkout.lastCommitAt);
  if (!(Number.isFinite(mergedMs) && Number.isFinite(commitMs))) {
    return ['commit chronology not read'];
  }
  return commitMs > mergedMs ? ['a commit is dated after the merge'] : [];
};

/** A linked session inside the recent-activity window: someone may still be working there. */
const recentSession = (checkout: DiskCheckout, now: string): readonly string[] => {
  const ageMs = checkout.lastSessionAt === null ? Number.NaN : Date.parse(now) - Date.parse(checkout.lastSessionAt);
  return Number.isFinite(ageMs) && ageMs <= DISK_RECENT_ACTIVITY_MS
    ? [`a linked session ran ${ageWords(Math.max(0, ageMs))} ago`]
    : [];
};

/**
 * A present checkout whose pull request is merged. Every condition of "safe to remove" is checked
 * here, and each one that fails names itself: the tree and the upstream, the commit dates, recent
 * sessions, the base branch, the checkout's role, the fork status, and last that a command can be
 * worded at all.
 */
const classifyMerged = (
  checkout: DiskCheckout,
  state: PresentState,
  pullRequest: DiskPullRequest,
  now: string,
): DiskClassification => {
  const merged = `PR #${pullRequest.number} merged`;
  const blockers = [...leftovers(state), ...commitChronology(checkout, pullRequest), ...recentSession(checkout, now)];
  if (blockers.length > 0) {
    return { group: 'needs-a-look', reason: `${merged}, but ${blockers.join(' · ')}` };
  }
  // A branch other pull requests target (develop merged into main) outlives its own merge.
  if (checkout.onBaseBranch && checkout.branch !== null) {
    return {
      group: 'needs-a-look',
      reason: `${merged} and clean; on base branch ${checkout.branch}, which other pull requests target`,
    };
  }
  if (checkout.role === 'primary') {
    return { group: 'needs-a-look', reason: `${merged} and clean; main checkout, switch branch instead of removing` };
  }
  if (checkout.role === 'unknown') {
    return {
      group: 'needs-a-look',
      reason: `${merged} and clean; the read does not say whether this is a linked worktree`,
    };
  }
  if (!pullRequest.headInRepository) {
    return { group: 'needs-a-look', reason: `${merged} and clean; whether its head branch is a fork's was not read` };
  }
  // A worktree read on its branch always has a command, except for a path quoting cannot carry.
  if (diskRemovalCommands(checkout).length === 0) {
    return {
      group: 'needs-a-look',
      reason: `${merged} and clean; the path needs quoting this view does not do, remove it by hand`,
    };
  }
  return { group: 'safe-to-remove', reason: `${merged} · clean · nothing unpushed` };
};

const latestActivity = (
  checkout: DiskCheckout,
  now: string,
): { readonly ageMs: number; readonly kind: 'Session' | 'Commit' } | null => {
  const ages = (
    [
      ['Session', checkout.lastSessionAt],
      ['Commit', checkout.lastCommitAt],
    ] as const
  ).flatMap(([kind, instant]) => {
    const ageMs = instant === null ? Number.NaN : Date.parse(now) - Date.parse(instant);
    return Number.isFinite(ageMs) ? [{ ageMs, kind }] : [];
  });
  const [latest] = ages.sort((left, right) => left.ageMs - right.ageMs);
  return latest ?? null;
};

/**
 * No pull request, or one closed without merge. The reason names why the checkout is listed; what
 * the tree holds stays in the disk state beside it and is not repeated.
 */
const classifyWithoutMerge = (checkout: DiskCheckout, state: PresentState, now: string): DiskClassification => {
  const activity = latestActivity(checkout, now);
  if (activity !== null && activity.ageMs <= DISK_RECENT_ACTIVITY_MS) {
    return { group: 'in-use', reason: `${activity.kind} ${ageWords(activity.ageMs)} ago` };
  }
  if (checkout.onBaseBranch && checkout.branch !== null && !state.changes && state.ahead === 0) {
    return { group: 'in-use', reason: `On base branch ${checkout.branch}, clean and pushed` };
  }
  const closed = checkout.pullRequest?.state === 'closed' ? checkout.pullRequest.number : null;
  return {
    group: 'needs-a-look',
    reason: [
      ...(checkout.branch === null ? ['Detached HEAD'] : []),
      closed === null ? 'No pull request' : `PR #${closed} closed without merge`,
      activity === null ? 'no dated activity' : `quiet for ${plural(Math.floor(activity.ageMs / DAY_MS), 'day')}`,
    ].join(' · '),
  };
};

/**
 * Which group a checkout belongs to and why, in one sentence the row shows. Total and ordered: a
 * state that was not read, or was read too long ago to stand for now, is settled before any pull
 * request is looked at, so no later rule can present it as clean.
 */
export const classifyDiskCheckout = (checkout: DiskCheckout, now: string): DiskClassification => {
  const { pullRequest, state } = checkout;
  if (state.kind === 'not-read') {
    return { group: 'not-read', reason: NOT_READ_REASONS[state.reason] };
  }
  const staleAge = staleReadAge(checkout, now);
  if (state.kind === 'absent') {
    // A path found missing stays in this group; an old read only dates the finding.
    return {
      group: 'gone',
      reason: staleAge === null ? 'No longer on disk' : `No longer on disk when last read ${staleAge}`,
    };
  }
  if (staleAge !== null) {
    return { group: 'not-read', reason: `Last read ${staleAge}, current state unknown` };
  }
  if (pullRequest?.state === 'open') {
    return { group: 'in-use', reason: `PR #${pullRequest.number} open${pullRequest.draft ? ' (draft)' : ''}` };
  }
  if (pullRequest?.state === 'merged') {
    return classifyMerged(checkout, state, pullRequest, now);
  }
  return classifyWithoutMerge(checkout, state, now);
};

/** A text glyph and words for a disk state, so the state never rests on colour. */
export const describeDiskState = (state: DiskCheckoutState): { readonly glyph: string; readonly words: string } => {
  if (state.kind === 'not-read') {
    return { glyph: '?', words: NOT_READ_REASONS[state.reason] };
  }
  if (state.kind === 'absent') {
    return { glyph: '✕', words: 'Absent' };
  }
  const upstream = [
    ...(state.ahead !== null && state.ahead > 0 ? [`${state.ahead} ahead`] : []),
    ...(state.behind !== null && state.behind > 0 ? [`${state.behind} behind`] : []),
    ...(state.upstream === null ? ['no upstream'] : []),
    ...(state.upstream !== null && state.ahead === null ? ['ahead not reported'] : []),
  ];
  return {
    glyph: state.changes ? '●' : '✓',
    words: [state.changes ? changeWords(state) : 'Clean', ...upstream].join(' · '),
  };
};

const toneOf = (state: DiskCheckoutState): DiskStateWords['tone'] => {
  if (state.kind !== 'present') {
    return state.kind;
  }
  return state.changes ? 'changes' : 'clean';
};

export interface DiskStateWords {
  readonly glyph: string;
  readonly tone: 'clean' | 'changes' | 'absent' | 'not-read';
  readonly words: string;
}

/**
 * The disk state as the row shows it at `now`, with the line under it. A present checkout whose
 * read is too old is worded by that read's age, never by what it said: "Clean" from weeks ago is
 * not the state. The line under the state is the row's reason, unless the state already says it.
 */
const diskStateAt = (checkout: DiskCheckout, reason: string, now: string): Pick<DiskGroupItem, 'detail' | 'disk'> => {
  const { state } = checkout;
  if (state.kind === 'present') {
    const staleAge = staleReadAge(checkout, now);
    if (staleAge !== null) {
      return {
        detail: 'Current state unknown',
        disk: { glyph: '?', tone: 'not-read', words: `Last read ${staleAge}` },
      };
    }
  }
  const disk = describeDiskState(state);
  return { detail: reason === disk.words ? null : reason, disk: { ...disk, tone: toneOf(state) } };
};

const PULL_REQUEST_WORDS = { closed: 'Closed', merged: 'Merged', open: 'Open' } as const satisfies Record<
  DiskPullRequest['state'],
  string
>;

/** The pull request's state in one word; "Draft" only while it is open. */
export const describeDiskPullRequest = (pullRequest: Pick<DiskPullRequest, 'draft' | 'state'>): string =>
  pullRequest.state === 'open' && pullRequest.draft ? 'Draft' : PULL_REQUEST_WORDS[pullRequest.state];

/**
 * Each checkout's path without the directory all listed checkouts share, keyed by checkout id. A
 * single checkout keeps its last two segments; paths with nothing in common stay absolute.
 */
export const shortDiskPaths = (checkouts: readonly DiskCheckout[]): ReadonlyMap<string, string> => {
  const segments = checkouts.map((checkout) => checkout.path.split('/').filter(Boolean));
  const [first] = segments;
  if (first === undefined) {
    return new Map();
  }
  let shared = segments.length === 1 ? Math.max(0, first.length - 2) : first.length - 1;
  for (const path of segments) {
    let common = 0;
    while (common < Math.min(shared, path.length - 1) && path[common] === first[common]) {
      common += 1;
    }
    shared = common;
  }
  return new Map(
    checkouts.map((checkout, index) => [
      checkout.id,
      shared > 0 ? (segments[index] ?? []).slice(shared).join('/') : checkout.path,
    ]),
  );
};

const GROUP_COPY = {
  'safe-to-remove': {
    empty:
      'No checkout meets the conditions: a merged pull request, a clean tree, a known upstream with nothing ahead, and a linked worktree.',
    label: 'Safe to remove',
    note: 'Pull request merged, tracked and untracked files clean, nothing unpushed. Ignored files are not read.',
  },
  'needs-a-look': {
    empty: 'No checkout needs a look.',
    label: 'Needs a look',
    note: 'Merged with leftovers, or a branch without a pull request gone quiet.',
  },
  'in-use': {
    empty: 'No checkout is in use.',
    label: 'In use',
    note: 'Open pull request, recent activity, or a clean base branch.',
  },
  gone: {
    empty: 'No named checkout was found missing.',
    label: 'Gone from disk',
    note: 'The path no longer exists. Whether the local branch remains was not read.',
  },
  'not-read': {
    empty: 'Every named checkout was read recently.',
    label: 'Not read',
    note: 'State unknown. Not the same as clean.',
  },
} as const satisfies Record<DiskGroup, { empty: string; label: string; note: string }>;

export interface DiskGroupItem {
  readonly checkout: DiskCheckout;
  /** The removal command: one element in the "Safe to remove" group, none anywhere else. */
  readonly commands: readonly string[];
  /** The line under the disk state: why the row is in its group, unless the state already says it. */
  readonly detail: string | null;
  readonly disk: DiskStateWords;
  readonly reason: string;
  readonly shortPath: string;
}

export interface DiskRepository {
  readonly items: readonly DiskGroupItem[];
  readonly label: string;
  readonly project: string | null;
}

export interface DiskGroupView {
  readonly count: number;
  /** The sentence shown when the group holds no checkout. */
  readonly empty: string;
  readonly group: DiskGroup;
  readonly label: string;
  readonly note: string;
  readonly repositories: readonly DiskRepository[];
}

const compareRepositories = (left: DiskRepository, right: DiskRepository): number => {
  if (left.project === null || right.project === null) {
    return Number(left.project === null) - Number(right.project === null);
  }
  return (
    left.label.localeCompare(right.label, 'en', { sensitivity: 'base' }) || comparePaths(left.project, right.project)
  );
};

/** The five groups in order, every one present even when empty; rows by repository, then path. */
export const groupDiskCheckouts = (checkouts: readonly DiskCheckout[], now: string): readonly DiskGroupView[] => {
  const shortPaths = shortDiskPaths(checkouts);
  const classified = checkouts.map((checkout) => ({ checkout, ...classifyDiskCheckout(checkout, now) }));
  return DISK_GROUPS.map((group) => {
    const repositories = new Map<string | null, DiskGroupItem[]>();
    for (const { checkout, group: assigned, reason } of classified) {
      if (assigned !== group) {
        continue;
      }
      const items = repositories.get(checkout.project) ?? [];
      items.push({
        ...diskStateAt(checkout, reason, now),
        checkout,
        commands: group === 'safe-to-remove' ? diskRemovalCommands(checkout) : [],
        reason,
        shortPath: shortPaths.get(checkout.id) ?? checkout.path,
      });
      repositories.set(checkout.project, items);
    }
    const sorted = [...repositories]
      .map(([project, items]) => ({
        items: items.toSorted((left, right) => comparePaths(left.checkout.path, right.checkout.path)),
        label: projectShortLabel(project),
        project,
      }))
      .sort(compareRepositories);
    return {
      ...GROUP_COPY[group],
      count: sorted.reduce((total, repository) => total + repository.items.length, 0),
      group,
      repositories: sorted,
    };
  });
};

export interface DiskLens {
  readonly branchesWithoutCheckout: number;
  readonly checkoutCount: number;
  /**
   * True while tasks remain unread: the safe rows are listed, but no command is offered, because an
   * open pull request on one of their branches could sit on a page not read yet.
   */
  readonly commandsWithheld: boolean;
  readonly groups: readonly DiskGroupView[];
  /** Distinct projects the listed checkouts belong to; a checkout without project counts for none. */
  readonly repositoryCount: number;
}

/**
 * Everything the Disk lens shows for the tasks read, as of `now`. `complete` says whether every task
 * of both tabs was read: pull requests are searched across all tasks, so until then no command is
 * offered.
 */
export const diskLensOf = (rows: readonly WorkThreadRow[], now: string, complete: boolean): DiskLens => {
  const { branchesWithoutCheckout, checkouts } = diskCheckoutsOf(rows);
  const groups = groupDiskCheckouts(checkouts, now);
  return {
    branchesWithoutCheckout,
    checkoutCount: checkouts.length,
    commandsWithheld: !complete,
    groups: complete
      ? groups
      : groups.map((group) => ({
          ...group,
          repositories: group.repositories.map((repository) => ({
            ...repository,
            items: repository.items.map((item) => ({ ...item, commands: [] })),
          })),
        })),
    repositoryCount: new Set(checkouts.flatMap((checkout) => (checkout.project === null ? [] : [checkout.project])))
      .size,
  };
};

/** Pages the lens reads per tab at most; beyond it the list is reported partial, never complete. */
export const DISK_MAX_PAGES_PER_TAB = 20;

export interface DiskPageChain {
  /** True once a page answered that it is the last one. */
  readonly complete: boolean;
  /** The cursors to read, the first page (`null`) included. */
  readonly cursors: readonly (string | null)[];
}

/**
 * The pages of one tab to read so the lens sees every task, walked from the first page each time:
 * `nextCursorOf` answers a page's next cursor, `null` for the last page and `undefined` while the
 * page has not answered. A page that fails, a repeated cursor or the page bound leaves the chain
 * incomplete.
 */
export const diskPageChain = (nextCursorOf: (cursor: string | null) => string | null | undefined): DiskPageChain => {
  const cursors: (string | null)[] = [null];
  for (;;) {
    const next = nextCursorOf(cursors.at(-1) ?? null);
    if (next === null) {
      return { complete: true, cursors };
    }
    if (next === undefined || cursors.includes(next) || cursors.length >= DISK_MAX_PAGES_PER_TAB) {
      return { complete: false, cursors };
    }
    cursors.push(next);
  }
};

/** The sources whose answer decides what the lens can list: the checkout reads and the linked sessions. */
const DISK_SOURCES = ['checkouts', 'sessions'] as const satisfies readonly WorkThreadSourceStatus['source'][];

/** A page that did not answer `ok` outranks one that did, and one that says why outranks one that does not. */
const sourceRank = (status: WorkThreadSourceStatus): number =>
  (status.state === 'ok' ? 0 : 2) + (status.message === null ? 0 : 1);

/**
 * How the checkout and session sources answered across every page read, one status per source. Each
 * page reports its own run, so a truncation on one page must not vanish behind a later page that
 * answered `ok`: the worst state is kept, and among equals the one that says why. A source no page
 * reported is absent, never assumed `ok`.
 */
export const aggregateDiskSources = (
  pages: readonly (readonly WorkThreadSourceStatus[])[],
): readonly WorkThreadSourceStatus[] =>
  DISK_SOURCES.flatMap((source) => {
    let worst: WorkThreadSourceStatus | null = null;
    for (const status of pages.flat()) {
      if (status.source === source && (worst === null || sourceRank(status) > sourceRank(worst))) {
        worst = status;
      }
    }
    return worst === null ? [] : [worst];
  });

const DISK_SOURCE_NAMES = { checkouts: 'Local read', sessions: 'Sessions' } as const satisfies Record<
  (typeof DISK_SOURCES)[number],
  string
>;

/**
 * "Local read truncated: …" for the scope note, the source's message verbatim. `null` for a source
 * that answered `ok` with nothing to say, and for sources the lens does not depend on.
 */
export const describeDiskSource = (status: WorkThreadSourceStatus): string | null => {
  if (status.source !== 'checkouts' && status.source !== 'sessions') {
    return null;
  }
  if (status.state === 'ok' && status.message === null) {
    return null;
  }
  const name = DISK_SOURCE_NAMES[status.source];
  return status.message === null ? `${name} ${status.state}.` : `${name} ${status.state}: ${status.message}`;
};
