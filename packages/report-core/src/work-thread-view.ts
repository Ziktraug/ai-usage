import type { CanonicalInstant } from './canonical-instant';
import type { CheckoutStatusObservation, JiraIssueObservation, PullRequestObservation } from './work-attention';
import type { WorkThread, WorkThreadEvent, WorkThreadLink } from './work-thread';

/**
 * The read model of the Work view (plan 123): what the reader assembles for one Work thread from
 * the thread store, the fact stores and the served sessions, and what the browser renders. Facts
 * are carried as observations with their own dates and outcomes; the view never turns a missing
 * or failed read into "nothing to do".
 */

export const WORK_THREAD_VIEW_BOUNDS = {
  /** Session and work marks per row, for the compact week lane. */
  maxMarksPerRow: 64,
  maxNativeRequests: 64,
  maxEpisodes: 100,
  maxEpisodeChildren: 20,
  maxEpisodeText: 1000,
  /** Opened, merged or closed, for each linked pull request at most. */
  maxFactEvents: 192,
  maxPageSize: 100,
  defaultPageSize: 50,
  maxSearch: 200,
  maxProjects: 200,
  /** Assigned Jira issues awaiting the operator's choice, shown at once above the tasks. */
  maxJiraIntake: 100,
  /** Ticket groups proposed for combination at once. */
  maxCombineSuggestions: 50,
  /** Participants and blockers one suggestion previews; a larger group is reported, not listed. */
  maxCombineParticipants: 16,
  maxCombineBlockers: 12,
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
  /** What the mark stands for (a session title, "PR #12 opened"), for its accessible name and detail. */
  readonly label: string | null;
}

/** One native question. Presentation acknowledgements and unrelated messages are never answers. */
export interface WorkThreadNativeRequest {
  readonly answeredAt: CanonicalInstant | null;
  readonly askedAt: CanonicalInstant | null;
  readonly callId: string | null;
  readonly detail: string;
  readonly evidence: 'codex-request-user-input' | 'codex-request-user-input-async' | 'claude-desktop-declaration';
  readonly harness: string;
  readonly key: string;
  readonly machineId: string;
  readonly observedAt: CanonicalInstant;
  readonly questionId: string | null;
  readonly sessionKey: string;
  readonly sourceSessionId: string;
  readonly state: 'open' | 'answered' | 'uncertain' | 'withdrawn';
  readonly text: string;
}

export interface WorkThreadRow {
  /** Facts newer than `doneAt` on a Done thread: shown, never reopening it silently (plan 123 decision 3). */
  readonly afterDone: { readonly count: number; readonly latestAt: CanonicalInstant } | null;
  /** Tasks combined into this one (ADR 0080); their links and history read as this task's. */
  readonly combinedThreads: readonly WorkThreadReference[];
  /**
   * Sessions those linked sessions delegated (subagents, automated reviews), nested under their
   * parent and counted apart: they are part of the work, not more work to follow.
   */
  readonly delegatedSessionCount: number;
  /**
   * The earliest dated evidence of the work: the thread's creation, its linked sessions' starts and
   * its linked pull requests' creation. A discovered thread is younger than the work it tracks.
   */
  readonly firstActivityAt: CanonicalInstant;
  readonly lastActivityAt: CanonicalInstant;
  readonly links: readonly WorkThreadLink[];
  readonly markers: WorkThreadMarkers;
  readonly marks: readonly WorkThreadMark[];
  readonly nativeRequestCoverage: 'complete' | 'partial';
  readonly nativeRequests: readonly WorkThreadNativeRequest[];
  /** Linked sessions still active by their own last activity, when the reader can tell. */
  readonly runningSessions: number;
  /** Linked sessions themselves (the episodes of the thread), without their delegated children. */
  readonly sessionCount: number;
  readonly thread: WorkThread;
}

export interface WorkThreadReference {
  readonly threadId: string;
  readonly title: string;
}

/** One task proposed for a combination, with what the preview shows of it. */
export interface WorkThreadCombineParticipant {
  readonly followRevision: number;
  readonly origin: WorkThread['origin'];
  /** Pull request link keys the task holds itself. */
  readonly pullRequestKeys: readonly string[];
  readonly sessionCount: number;
  readonly threadId: string;
  readonly title: string;
}

/**
 * Open tasks that follow the same ticket and could become one (ADR 0080). `blockers` lists what the
 * operator must settle first; a suggestion with blockers is shown but cannot be applied.
 */
export interface WorkThreadCombineSuggestion {
  readonly blockers: readonly string[];
  readonly issue: JiraIssueObservation | null;
  readonly keptThreadId: string;
  readonly participants: readonly WorkThreadCombineParticipant[];
  /** `jira:<site>/<KEY>` */
  readonly ticketKey: string;
}

/**
 * An issue Jira assigns to the operator that no open task follows yet. Assignment alone is not a
 * commitment: the operator follows it, attaches it to a task, or dismisses it.
 */
export interface WorkThreadJiraIntakeItem {
  /** First time discovery returned the issue as assigned. */
  readonly firstSeenAt: CanonicalInstant;
  /** Latest successful observation; `null` until the issue has been read. */
  readonly issue: JiraIssueObservation | null;
  /** `jira:<site>/<KEY>`, as a task link names it. */
  readonly key: string;
}

export interface WorkThreadListDataset {
  readonly combineSuggestions: {
    readonly items: readonly WorkThreadCombineSuggestion[];
    readonly truncated: boolean;
  };
  readonly counts: { readonly done: number; readonly open: number };
  readonly generatedAt: CanonicalInstant;
  readonly jiraIntake: { readonly items: readonly WorkThreadJiraIntakeItem[]; readonly truncated: boolean };
  readonly machineId: string;
  readonly nextCursor: string | null;
  readonly projects: readonly string[];
  readonly rows: readonly WorkThreadRow[];
  readonly sources: readonly WorkThreadSourceStatus[];
}

/** A resume path the product has verified for this harness; nothing else is offered. */
export type WorkThreadResumePath =
  | { readonly command: string; readonly cwd: string | null; readonly kind: 'cli-resume' }
  | { readonly kind: 'none'; readonly reason: string };

export interface WorkThreadEpisode {
  /**
   * Recorded turn time of the session (the union of its turn intervals, as the collectors compute
   * it); `null` when the harness records none. Never derived from the span.
   */
  readonly activeMs: number | null;
  readonly children: readonly WorkThreadEpisode[];
  readonly endedAt: CanonicalInstant | null;
  readonly firstPrompt: string | null;
  readonly harness: string;
  readonly lastInstruction: string | null;
  /** The parent session's harness and title when the session was delegated by a declared parent. */
  readonly launchedBy: { readonly harness: string; readonly title: string | null } | null;
  readonly linkKey: string;
  readonly machineId: string;
  readonly nativeRequests: readonly WorkThreadNativeRequest[];
  readonly origin: 'human' | 'delegated' | 'automated-review' | null;
  readonly projectLabel: string | null;
  /** What the session declared it needs from the operator, as dated by the session. */
  readonly question: string | null;
  readonly result: string | null;
  readonly resume: WorkThreadResumePath;
  readonly running: boolean | null;
  readonly sourceSessionId: string;
  /**
   * First to last observed activity of the session. It contains pauses: a conversation that exists
   * for days is not days of work, so it is shown as a span, never as work time.
   */
  readonly spanMs: number | null;
  readonly startedAt: CanonicalInstant;
  readonly title: string | null;
}

export const WORK_THREAD_FACT_EVENT_KINDS = [
  'pull-request-opened',
  'pull-request-merged',
  'pull-request-closed',
] as const;
export type WorkThreadFactEventKind = (typeof WORK_THREAD_FACT_EVENT_KINDS)[number];

/**
 * A dated fact of a linked source placed in the task's thread beside the sessions. It carries the
 * source's own date (a pull request's `createdAt`, `mergedAt`, `closedAt`), never the instant the
 * product observed it, and it is not stored as a thread event.
 */
export interface WorkThreadFactEvent {
  readonly at: CanonicalInstant;
  /** The linked source's qualified key. */
  readonly key: string;
  readonly kind: WorkThreadFactEventKind;
  /** The source's short name, e.g. "PR #12". */
  readonly label: string;
  readonly title: string | null;
}

export interface WorkThreadDetailDataset {
  /** Set when this task was combined into another: it is read-only history until separated. */
  readonly combinedInto: WorkThreadReference | null;
  readonly detachedLinks: readonly WorkThreadLink[];
  readonly episodes: readonly WorkThreadEpisode[];
  readonly events: readonly WorkThreadEvent[];
  readonly factEvents: readonly WorkThreadFactEvent[];
  readonly generatedAt: CanonicalInstant;
  readonly row: WorkThreadRow;
  readonly sources: readonly WorkThreadSourceStatus[];
}
