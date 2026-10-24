import type { CanonicalInstant } from './canonical-instant';
import type { CheckoutStatusObservation, JiraIssueObservation, PullRequestObservation } from './work-attention';
import type { WorkThread, WorkThreadEvent, WorkThreadLink } from './work-thread';

/**
 * The read model of the Work view (plan 120): what the reader assembles for one Work thread from
 * the thread store, the fact stores and the served sessions, and what the browser renders. Facts
 * are carried as observations with their own dates and outcomes; the view never turns a missing
 * or failed read into "nothing to do".
 */

export const WORK_THREAD_VIEW_BOUNDS = {
  /** Session and work marks per row, for the compact week lane. */
  maxMarksPerRow: 64,
  maxEpisodes: 100,
  maxEpisodeChildren: 20,
  maxEpisodeText: 1000,
  maxPageSize: 100,
  defaultPageSize: 50,
  maxSearch: 200,
  maxProjects: 200,
} as const;

export const WORK_THREAD_TABS = ['open', 'done'] as const;
/** `open` lists Following and Waiting threads; `done` lists the operator's ended follow-ups. */
export type WorkThreadTab = (typeof WORK_THREAD_TABS)[number];

export interface WorkThreadListQuery {
  readonly cursor: string | null;
  readonly limit: number;
  readonly project: string | null;
  /** Matched against the title, linked keys (PR number, Jira key, branch) and linked session titles. */
  readonly search: string | null;
  readonly tab: WorkThreadTab;
}

/** How a source answered on its latest run, from `work_fact_run_state`; never inferred from emptiness. */
export const WORK_THREAD_SOURCE_STATES = [
  'ok',
  'never-run',
  'disabled',
  'unavailable',
  'unauthenticated',
  'failed',
  'truncated',
] as const;
export type WorkThreadSourceState = (typeof WORK_THREAD_SOURCE_STATES)[number];

export interface WorkThreadSourceStatus {
  readonly lastRunAt: CanonicalInstant | null;
  readonly message: string | null;
  readonly source: 'checkouts' | 'github' | 'jira' | 'sessions';
  readonly state: WorkThreadSourceState;
}

/** A dated fact with the latest attempt beside the latest success, as the fact store keeps them. */
export interface WorkThreadFact<Observation> {
  readonly key: string;
  readonly latest: Observation | null;
  readonly latestSuccessful: Observation | null;
}

export interface WorkThreadLocalMarker extends WorkThreadFact<CheckoutStatusObservation> {
  /** The branch link or linked session the checkout was reached through. */
  readonly via: 'branch-link' | 'session-checkout';
}

/** Why a discovered pull request concerns the operator; `null` when it came through a link. */
export type WorkThreadPullRequestRole = 'author' | 'review-requested' | null;

export interface WorkThreadPullRequestMarker extends WorkThreadFact<PullRequestObservation> {
  /** Mergeability as GitHub reported it; `null` when unknown. Behind the base is not a conflict. */
  readonly mergeable: 'mergeable' | 'conflicting' | 'unknown' | null;
  readonly mergeStateStatus: string | null;
  readonly role: WorkThreadPullRequestRole;
}

export interface WorkThreadMarkers {
  readonly jiraIssues: readonly WorkThreadFact<JiraIssueObservation>[];
  readonly local: readonly WorkThreadLocalMarker[];
  readonly pullRequests: readonly WorkThreadPullRequestMarker[];
}

/** One dated point of the week lane. Placement only: not proportional to any duration. */
export interface WorkThreadMark {
  readonly at: CanonicalInstant;
  readonly harness: string | null;
  readonly kind: 'session' | 'event';
}

export interface WorkThreadRow {
  /** Facts newer than `doneAt` on a Done thread: shown, never reopening it silently (plan 120 decision 3). */
  readonly afterDone: { readonly count: number; readonly latestAt: CanonicalInstant } | null;
  /**
   * Sessions those linked sessions delegated (subagents, automated reviews), nested under their
   * parent and counted apart: they are part of the work, not more work to follow.
   */
  readonly delegatedSessionCount: number;
  readonly lastActivityAt: CanonicalInstant;
  readonly links: readonly WorkThreadLink[];
  readonly markers: WorkThreadMarkers;
  readonly marks: readonly WorkThreadMark[];
  /** Linked sessions still active by their own last activity, when the reader can tell. */
  readonly runningSessions: number;
  /** Linked sessions themselves (the episodes of the thread), without their delegated children. */
  readonly sessionCount: number;
  readonly thread: WorkThread;
}

export interface WorkThreadListDataset {
  readonly counts: { readonly done: number; readonly open: number };
  readonly generatedAt: CanonicalInstant;
  readonly machineId: string;
  readonly nextCursor: string | null;
  readonly projects: readonly string[];
  readonly rows: readonly WorkThreadRow[];
  readonly sources: readonly WorkThreadSourceStatus[];
}

/**
 * How an episode's duration is known. `span` is first to last observed activity of one session and
 * may contain pauses; it is labelled as such. `unknown` is never replaced by a guess.
 */
export type WorkThreadDurationBasis = 'span' | 'unknown';

/** A resume path the product has verified for this harness; nothing else is offered. */
export type WorkThreadResumePath =
  | { readonly command: string; readonly cwd: string | null; readonly kind: 'cli-resume' }
  | { readonly kind: 'none'; readonly reason: string };

export interface WorkThreadEpisode {
  readonly children: readonly WorkThreadEpisode[];
  readonly durationBasis: WorkThreadDurationBasis;
  readonly durationMs: number | null;
  readonly endedAt: CanonicalInstant | null;
  readonly firstPrompt: string | null;
  readonly harness: string;
  readonly lastInstruction: string | null;
  /** The parent session's harness and title when the session was delegated by a declared parent. */
  readonly launchedBy: { readonly harness: string; readonly title: string | null } | null;
  readonly linkKey: string;
  readonly machineId: string;
  readonly origin: 'human' | 'delegated' | 'automated-review' | null;
  readonly projectLabel: string | null;
  /** What the session declared it needs from the operator, as dated by the session. */
  readonly question: string | null;
  readonly result: string | null;
  readonly resume: WorkThreadResumePath;
  readonly running: boolean | null;
  readonly sourceSessionId: string;
  readonly startedAt: CanonicalInstant;
  readonly title: string | null;
}

export interface WorkThreadDetailDataset {
  readonly detachedLinks: readonly WorkThreadLink[];
  readonly episodes: readonly WorkThreadEpisode[];
  readonly events: readonly WorkThreadEvent[];
  readonly generatedAt: CanonicalInstant;
  readonly row: WorkThreadRow;
  readonly sources: readonly WorkThreadSourceStatus[];
}
