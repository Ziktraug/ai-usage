import type { CanonicalInstant } from './canonical-instant';
import { isRecord } from './datasets';
import { normalizeIsoTimestamp } from './provider-status';

/**
 * Work thread: the durable unit of the Work view (CONTEXT.md "Work thread", plan 123). A thread
 * keeps one identity from a first exploration to the end of the operator's follow-up, whatever
 * appears around it: sessions, a branch, a pull request, a Jira issue.
 *
 * Three families stay apart on purpose:
 *
 * - The **thread** and its **follow state** are the operator's: written only by explicit commands,
 *   stored durably, never recomputed from sources by a collection.
 * - A **link** is a sourced association between a thread and one qualified external key. A link is
 *   detached, never deleted, so a correction keeps its history.
 * - **Facts** (pull requests, checkouts, Jira issues, sessions) stay in their own stores. Ending a
 *   follow-up changes none of them, and none of them ends a follow-up.
 *
 * This module is import-light on purpose: the usage-engine control contract validates the
 * commands below and sits in the browser's first-load closure.
 */

export const WORK_THREAD_FOLLOW_STATES = ['following', 'waiting', 'done'] as const;
export type WorkThreadFollowState = (typeof WORK_THREAD_FOLLOW_STATES)[number];

/** What the operator means to do; it decides which ends are plausible, never a universal rule. */
export const WORK_THREAD_INTENTS = ['analysis', 'change', 'review'] as const;
export type WorkThreadIntent = (typeof WORK_THREAD_INTENTS)[number];

/** How the thread came to exist. Only `user` threads are created without a qualified key. */
export const WORK_THREAD_ORIGINS = ['user', 'pull-request', 'jira-issue', 'session'] as const;
export type WorkThreadOrigin = (typeof WORK_THREAD_ORIGINS)[number];

export const WORK_THREAD_LINK_KINDS = ['pull-request', 'jira-issue', 'session', 'branch'] as const;
export type WorkThreadLinkKind = (typeof WORK_THREAD_LINK_KINDS)[number];

/**
 * Why a link exists:
 * - `user`: the operator associated it explicitly.
 * - `origin`: the thread was created from this key (discovery or "track this session").
 * - `declared`: a source named the key explicitly (a session recorded the pull request, a branch
 *   carries the Jira key as a whole segment, ADR 0054). Never proximity, a shared checkout or lineage.
 * - `launched`: an action started from the thread produced it.
 */
export const WORK_THREAD_LINK_PROVENANCES = ['user', 'origin', 'declared', 'launched'] as const;
export type WorkThreadLinkProvenance = (typeof WORK_THREAD_LINK_PROVENANCES)[number];

/** An identified expectation a matching observation may satisfy once (mandate §3). */
export const WORK_THREAD_WAIT_KINDS = ['pull-request-review', 'jira-update'] as const;
export type WorkThreadWaitKind = (typeof WORK_THREAD_WAIT_KINDS)[number];

export const WORK_THREAD_EVENT_KINDS = [
  'created',
  'follow-state',
  'link-added',
  'link-detached',
  'note',
  'renamed',
  'wait-satisfied',
  // ADR 0080: recorded on the kept task and on each task combined into it, then on separation.
  'combined',
  'separated',
] as const;
export type WorkThreadEventKind = (typeof WORK_THREAD_EVENT_KINDS)[number];

export const WORK_THREAD_COMMAND_FAILURES = [
  'not-found',
  'revision-conflict',
  'invalid-transition',
  'invalid-link',
  /** The task was combined into another; commands go to the kept task (ADR 0080). */
  'task-combined',
  /** The tasks following the ticket changed since the combination was previewed. */
  'stale-preview',
] as const;
export type WorkThreadCommandFailure = (typeof WORK_THREAD_COMMAND_FAILURES)[number];

export const WORK_THREAD_BOUNDS = {
  maxAcknowledgedRemainders: 16,
  /** Tasks one combination may join, the kept task included. */
  maxCombinedThreads: 8,
  maxEventsPerThread: 500,
  maxKey: 640,
  maxLinksPerThread: 64,
  maxNote: 2000,
  maxObjective: 512,
  maxReason: 512,
  maxTitle: 200,
  maxWaitingFor: 256,
} as const;

export interface WorkThreadWait {
  readonly kind: WorkThreadWaitKind;
  /** The qualified key of the link the expectation is about. */
  readonly linkKey: string;
  readonly since: CanonicalInstant;
}

export interface WorkThread {
  readonly createdAt: CanonicalInstant;
  readonly doneAt: CanonicalInstant | null;
  readonly doneReason: string | null;
  readonly followRevision: number;
  readonly followState: WorkThreadFollowState;
  readonly intent: WorkThreadIntent | null;
  readonly machineId: string;
  readonly note: string | null;
  readonly objective: string | null;
  readonly origin: WorkThreadOrigin;
  /** The qualified key the thread was created from; unique, so a repeated discovery is a no-op. */
  readonly originKey: string | null;
  readonly projectLabel: string | null;
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt: CanonicalInstant;
  /** A short label of what the operator waits for, present only while `waiting`. */
  readonly waitingFor: string | null;
  readonly waitingOn: WorkThreadWait | null;
}

export interface WorkThreadLink {
  readonly createdAt: CanonicalInstant;
  readonly detachedAt: CanonicalInstant | null;
  readonly key: string;
  readonly kind: WorkThreadLinkKind;
  readonly linkId: string;
  readonly provenance: WorkThreadLinkProvenance;
  readonly threadId: string;
}

export interface WorkThreadEvent {
  /** Remainders the operator saw and accepted when ending the follow-up despite them. */
  readonly acknowledgedRemainders: readonly string[];
  readonly at: CanonicalInstant;
  readonly eventId: string;
  readonly fromState: WorkThreadFollowState | null;
  readonly kind: WorkThreadEventKind;
  readonly linkKey: string | null;
  readonly reason: string | null;
  readonly threadId: string;
  readonly toState: WorkThreadFollowState | null;
}

export interface WorkThreadLinkInput {
  readonly key: string;
  readonly kind: WorkThreadLinkKind;
}

/**
 * Operator commands. Every command carries a client-generated `commandId`: replaying the same id
 * returns the recorded result without a second effect (refresh, double click, two tabs). Commands
 * that change the follow state name the revision they were decided on; a stale revision is a
 * typed `revision-conflict`, never a silent overwrite.
 */
export type WorkThreadCommand =
  | {
      readonly commandId: string;
      readonly intent: WorkThreadIntent | null;
      readonly links: readonly WorkThreadLinkInput[];
      readonly objective: string | null;
      readonly op: 'create';
      readonly projectLabel: string | null;
      readonly title: string;
    }
  | {
      readonly acknowledgedRemainders: readonly string[];
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly op: 'set-follow-state';
      readonly reason: string | null;
      readonly threadId: string;
      readonly to: WorkThreadFollowState;
      readonly waitingFor: string | null;
      readonly waitingOn: WorkThreadWait | null;
    }
  | {
      readonly commandId: string;
      readonly key: string;
      readonly kind: WorkThreadLinkKind;
      readonly op: 'link';
      readonly threadId: string;
    }
  | { readonly commandId: string; readonly linkId: string; readonly op: 'detach-link'; readonly threadId: string }
  /**
   * Detach a session by key, including one the task reads through its branch with no stored link
   * (ADR 0081): the detached link recorded either way is the operator's veto.
   */
  | { readonly commandId: string; readonly key: string; readonly op: 'detach-session'; readonly threadId: string }
  | { readonly commandId: string; readonly note: string | null; readonly op: 'set-note'; readonly threadId: string }
  | { readonly commandId: string; readonly op: 'rename'; readonly threadId: string; readonly title: string }
  /**
   * Combine every task following one ticket into the kept task (ADR 0080). The exact participant set
   * and their revisions are what the operator previewed; any drift is refused, never adjusted.
   */
  | {
      readonly commandId: string;
      readonly op: 'combine';
      readonly participants: readonly { readonly expectedRevision: number; readonly threadId: string }[];
      readonly threadId: string;
      readonly ticketKey: string;
    }
  /** End the combination kept by `threadId`; each task returns with the state it kept. */
  | {
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly op: 'separate';
      readonly threadId: string;
    }
  /** Hide (or restore) an assigned Jira issue in the intake; it concerns no task. */
  | { readonly commandId: string; readonly dismissed: boolean; readonly key: string; readonly op: 'dismiss-intake' };

export type WorkThreadCommandResult =
  | {
      readonly ok: true;
      /** False when the command id was already applied: the recorded outcome is returned. */
      readonly applied: boolean;
      readonly followRevision: number;
      readonly threadId: string;
    }
  | {
      readonly ok: false;
      readonly currentRevision: number | null;
      readonly failure: WorkThreadCommandFailure;
      readonly message: string;
    };

/** Commands addressed to one task; their result always names it. */
export type WorkThreadTaskCommand = Exclude<WorkThreadCommand, { readonly op: 'dismiss-intake' }>;

/** An intake decision changes no task, so its result names none (and a fixed revision of 1). */
export type WorkIntakeCommandResult =
  | { readonly ok: true; readonly applied: boolean; readonly followRevision: number; readonly threadId: null }
  | Extract<WorkThreadCommandResult, { readonly ok: false }>;

// ---------------------------------------------------------------------------------------------
// Qualified keys. A path or a common name is never an identity; each key names its authority.
// ---------------------------------------------------------------------------------------------

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOST = /^[a-z0-9.-]+$/;
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const SEGMENT = /^[^\s/][^\s]*$/;
const PULL_REQUEST_KEY = /^([^/]+)\/([^#]+)#(\d+)$/;
const JIRA_LINK_KEY = /^jira:([^/]+)\/(.+)$/;
const SESSION_LINK_KEY = /^session:([^/]+)\/([^/]+)\/(.+)$/;
const BRANCH_LINK_KEY = /^branch:([^/]+)\/([^/]+\/[^@]+)@(.+)$/;

/** `github.com/owner/repo#123` */
export const pullRequestLinkKey = (input: {
  readonly host: string;
  readonly number: number;
  readonly repository: string;
}): string => `${input.host.toLowerCase()}/${input.repository}#${input.number}`;

/** `jira:<site>/<KEY-1>`; `site` is the configured site label, `default` for the CLI's own. */
export const jiraIssueLinkKey = (input: { readonly key: string; readonly site: string }): string =>
  `jira:${input.site}/${input.key}`;

/** `session:<machineId>/<harness>/<sessionId>` */
export const sessionLinkKey = (input: {
  readonly harness: string;
  readonly machineId: string;
  readonly sessionId: string;
}): string => `session:${input.machineId}/${input.harness}/${input.sessionId}`;

/** `branch:<host>/<owner>/<repo>@<ref>`, the repository as its remote names it. */
export const branchLinkKey = (input: {
  readonly host: string;
  readonly ref: string;
  readonly repository: string;
}): string => `branch:${input.host.toLowerCase()}/${input.repository}@${input.ref}`;

/** Branches everyone merges into: a session on one is no single task's work (ADR 0081). */
export const SHARED_BRANCH_NAMES: ReadonlySet<string> = new Set(['main', 'master', 'develop', 'development', 'trunk']);

const FORBIDDEN_REF_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\']);
/** Controls, space, DEL and the characters git reserves for revision syntax. */
const hasInvalidRefCharacter = (ref: string): boolean =>
  [...ref].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 32 || code === 127 || FORBIDDEN_REF_CHARACTERS.has(character);
  });

/**
 * `git check-ref-format` for a branch: what a harness may record that is not one (`HEAD`, a
 * placeholder such as `.invalid`, an empty name) never stands for work on a branch.
 */
export const isBranchRefName = (ref: string): boolean =>
  ref.length > 0 &&
  ref.length <= 255 &&
  ref !== 'HEAD' &&
  ref !== '@' &&
  !hasInvalidRefCharacter(ref) &&
  !ref.includes('..') &&
  !ref.includes('@{') &&
  !ref.includes('//') &&
  !ref.startsWith('/') &&
  !ref.startsWith('-') &&
  !ref.endsWith('/') &&
  !ref.endsWith('.') &&
  ref.split('/').every((segment) => !(segment.startsWith('.') || segment.endsWith('.lock')));

export type ParsedWorkThreadLinkKey =
  | { readonly host: string; readonly kind: 'pull-request'; readonly number: number; readonly repository: string }
  | { readonly key: string; readonly kind: 'jira-issue'; readonly site: string }
  | { readonly harness: string; readonly kind: 'session'; readonly machineId: string; readonly sessionId: string }
  | { readonly host: string; readonly kind: 'branch'; readonly ref: string; readonly repository: string };

export const parseWorkThreadLinkKey = (kind: WorkThreadLinkKind, key: string): ParsedWorkThreadLinkKey | null => {
  if (key.length === 0 || key.length > WORK_THREAD_BOUNDS.maxKey) {
    return null;
  }
  switch (kind) {
    case 'pull-request': {
      const match = PULL_REQUEST_KEY.exec(key);
      const number = match ? Number(match[3]) : Number.NaN;
      if (!(match?.[1] && match[2] && HOST.test(match[1]) && OWNER_REPO.test(match[2]))) {
        return null;
      }
      return Number.isSafeInteger(number) && number > 0 ? { host: match[1], kind, number, repository: match[2] } : null;
    }
    case 'jira-issue': {
      const match = JIRA_LINK_KEY.exec(key);
      return match?.[1] && match[2] && SEGMENT.test(match[1]) && JIRA_KEY.test(match[2])
        ? { key: match[2], kind, site: match[1] }
        : null;
    }
    case 'session': {
      const match = SESSION_LINK_KEY.exec(key);
      return match?.[1] && match[2] && match[3] && SEGMENT.test(match[3])
        ? { harness: match[2], kind, machineId: match[1], sessionId: match[3] }
        : null;
    }
    case 'branch': {
      const match = BRANCH_LINK_KEY.exec(key);
      return match?.[1] && match[2] && match[3] && HOST.test(match[1]) && OWNER_REPO.test(match[2])
        ? { host: match[1], kind, ref: match[3], repository: match[2] }
        : null;
    }
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------------------------
// Parsers. Stored rows and wire values are re-validated with these; a value that no longer
// parses is reported by the caller, never coerced.
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const text = (value: unknown, maxLength: number): string | null =>
  typeof value === 'string' && value.length <= maxLength ? value : null;
const requiredText = (value: unknown, maxLength: number): string | null => {
  const parsed = text(value, maxLength);
  return parsed === null || parsed.trim().length === 0 ? null : parsed;
};
const optionalText = (value: unknown, maxLength: number): string | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = requiredText(value, maxLength);
  return parsed === null ? undefined : parsed;
};
const instant = (value: unknown): CanonicalInstant | null =>
  typeof value === 'string' ? normalizeIsoTimestamp(value) : null;
const optionalInstant = (value: unknown): CanonicalInstant | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  return instant(value) ?? undefined;
};
const oneOf = <const Values extends readonly string[]>(values: Values, value: unknown): Values[number] | undefined =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as Values[number]) : undefined;
const optionalOneOf = <const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): Values[number] | null | undefined => (value === null || value === undefined ? null : oneOf(values, value));
const revision = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

export const isWorkThreadId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

const parseWait = (value: unknown): WorkThreadWait | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!(isRecord(value) && hasOnlyKeys(value, ['kind', 'linkKey', 'since']))) {
    return;
  }
  const kind = oneOf(WORK_THREAD_WAIT_KINDS, value.kind);
  const linkKey = requiredText(value.linkKey, WORK_THREAD_BOUNDS.maxKey);
  const since = instant(value.since);
  return kind && linkKey && since ? { kind, linkKey, since } : undefined;
};

const THREAD_KEYS = [
  'createdAt',
  'doneAt',
  'doneReason',
  'followRevision',
  'followState',
  'intent',
  'machineId',
  'note',
  'objective',
  'origin',
  'originKey',
  'projectLabel',
  'threadId',
  'title',
  'updatedAt',
  'waitingFor',
  'waitingOn',
] as const;

export const parseWorkThread = (value: unknown): WorkThread | null => {
  if (!(isRecord(value) && hasOnlyKeys(value, THREAD_KEYS))) {
    return null;
  }
  const threadId = isWorkThreadId(value.threadId) ? value.threadId : null;
  const machineId = requiredText(value.machineId, WORK_THREAD_BOUNDS.maxKey);
  const title = requiredText(value.title, WORK_THREAD_BOUNDS.maxTitle);
  const followState = oneOf(WORK_THREAD_FOLLOW_STATES, value.followState);
  const followRevision = revision(value.followRevision);
  const origin = oneOf(WORK_THREAD_ORIGINS, value.origin);
  const intent = optionalOneOf(WORK_THREAD_INTENTS, value.intent);
  const objective = optionalText(value.objective, WORK_THREAD_BOUNDS.maxObjective);
  const originKey = optionalText(value.originKey, WORK_THREAD_BOUNDS.maxKey);
  const projectLabel = optionalText(value.projectLabel, WORK_THREAD_BOUNDS.maxTitle);
  const note = optionalText(value.note, WORK_THREAD_BOUNDS.maxNote);
  const waitingFor = optionalText(value.waitingFor, WORK_THREAD_BOUNDS.maxWaitingFor);
  const waitingOn = parseWait(value.waitingOn);
  const doneReason = optionalText(value.doneReason, WORK_THREAD_BOUNDS.maxReason);
  const createdAt = instant(value.createdAt);
  const updatedAt = instant(value.updatedAt);
  const doneAt = optionalInstant(value.doneAt);
  if (
    threadId === null ||
    machineId === null ||
    title === null ||
    followState === undefined ||
    followRevision === null ||
    origin === undefined ||
    intent === undefined ||
    objective === undefined ||
    originKey === undefined ||
    projectLabel === undefined ||
    note === undefined ||
    waitingFor === undefined ||
    waitingOn === undefined ||
    doneReason === undefined ||
    doneAt === undefined ||
    createdAt === null ||
    updatedAt === null ||
    (origin === 'user') !== (originKey === null) ||
    (followState === 'done') !== (doneAt !== null) ||
    (followState !== 'done' && doneReason !== null) ||
    (followState !== 'waiting' && (waitingFor !== null || waitingOn !== null))
  ) {
    return null;
  }
  return {
    createdAt,
    doneAt,
    doneReason,
    followRevision,
    followState,
    intent,
    machineId,
    note,
    objective,
    origin,
    originKey,
    projectLabel,
    threadId,
    title,
    updatedAt,
    waitingFor,
    waitingOn,
  };
};

export const parseWorkThreadLink = (value: unknown): WorkThreadLink | null => {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, ['createdAt', 'detachedAt', 'key', 'kind', 'linkId', 'provenance', 'threadId'])
    )
  ) {
    return null;
  }
  const kind = oneOf(WORK_THREAD_LINK_KINDS, value.kind);
  const key = requiredText(value.key, WORK_THREAD_BOUNDS.maxKey);
  const provenance = oneOf(WORK_THREAD_LINK_PROVENANCES, value.provenance);
  const createdAt = instant(value.createdAt);
  const detachedAt = optionalInstant(value.detachedAt);
  if (
    kind === undefined ||
    key === null ||
    parseWorkThreadLinkKey(kind, key) === null ||
    provenance === undefined ||
    createdAt === null ||
    detachedAt === undefined ||
    !isWorkThreadId(value.linkId) ||
    !isWorkThreadId(value.threadId)
  ) {
    return null;
  }
  return { createdAt, detachedAt, key, kind, linkId: value.linkId, provenance, threadId: value.threadId };
};

const textList = (value: unknown, maxLength: number, maxItems: number): readonly string[] | null => {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maxItems) {
    return null;
  }
  const items = value.map((item) => requiredText(item, maxLength));
  return items.every((item): item is string => item !== null) ? items : null;
};

export const parseWorkThreadEvent = (value: unknown): WorkThreadEvent | null => {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, [
        'acknowledgedRemainders',
        'at',
        'eventId',
        'fromState',
        'kind',
        'linkKey',
        'reason',
        'threadId',
        'toState',
      ])
    )
  ) {
    return null;
  }
  const kind = oneOf(WORK_THREAD_EVENT_KINDS, value.kind);
  const at = instant(value.at);
  const fromState = optionalOneOf(WORK_THREAD_FOLLOW_STATES, value.fromState);
  const toState = optionalOneOf(WORK_THREAD_FOLLOW_STATES, value.toState);
  const linkKey = optionalText(value.linkKey, WORK_THREAD_BOUNDS.maxKey);
  const reason = optionalText(value.reason, WORK_THREAD_BOUNDS.maxNote);
  const acknowledgedRemainders = textList(
    value.acknowledgedRemainders,
    WORK_THREAD_BOUNDS.maxReason,
    WORK_THREAD_BOUNDS.maxAcknowledgedRemainders,
  );
  if (
    kind === undefined ||
    at === null ||
    fromState === undefined ||
    toState === undefined ||
    linkKey === undefined ||
    reason === undefined ||
    acknowledgedRemainders === null ||
    !isWorkThreadId(value.eventId) ||
    !isWorkThreadId(value.threadId)
  ) {
    return null;
  }
  return {
    acknowledgedRemainders,
    at,
    eventId: value.eventId,
    fromState,
    kind,
    linkKey,
    reason,
    threadId: value.threadId,
    toState,
  };
};

const parseLinkInput = (value: unknown): WorkThreadLinkInput | null => {
  if (!(isRecord(value) && hasOnlyKeys(value, ['key', 'kind']))) {
    return null;
  }
  const kind = oneOf(WORK_THREAD_LINK_KINDS, value.kind);
  const key = requiredText(value.key, WORK_THREAD_BOUNDS.maxKey);
  return kind && key && parseWorkThreadLinkKey(kind, key) ? { key, kind } : null;
};

/** Validates a command from the wire. Returns `null` for any unknown field or invalid value. */
export const parseWorkThreadCommand = (value: unknown): WorkThreadCommand | null => {
  if (!(isRecord(value) && isWorkThreadId(value.commandId))) {
    return null;
  }
  const commandId = value.commandId;
  switch (value.op) {
    case 'create': {
      if (!hasOnlyKeys(value, ['commandId', 'intent', 'links', 'objective', 'op', 'projectLabel', 'title'])) {
        return null;
      }
      const title = requiredText(value.title, WORK_THREAD_BOUNDS.maxTitle);
      const intent = optionalOneOf(WORK_THREAD_INTENTS, value.intent);
      const objective = optionalText(value.objective, WORK_THREAD_BOUNDS.maxObjective);
      const projectLabel = optionalText(value.projectLabel, WORK_THREAD_BOUNDS.maxTitle);
      const rawLinks = value.links ?? [];
      if (!Array.isArray(rawLinks) || rawLinks.length > WORK_THREAD_BOUNDS.maxLinksPerThread) {
        return null;
      }
      const links = rawLinks.map(parseLinkInput);
      if (
        title === null ||
        intent === undefined ||
        objective === undefined ||
        projectLabel === undefined ||
        !links.every((link): link is WorkThreadLinkInput => link !== null)
      ) {
        return null;
      }
      return { commandId, intent, links, objective, op: 'create', projectLabel, title };
    }
    case 'set-follow-state': {
      if (
        !hasOnlyKeys(value, [
          'acknowledgedRemainders',
          'commandId',
          'expectedRevision',
          'op',
          'reason',
          'threadId',
          'to',
          'waitingFor',
          'waitingOn',
        ])
      ) {
        return null;
      }
      const to = oneOf(WORK_THREAD_FOLLOW_STATES, value.to);
      const expectedRevision = revision(value.expectedRevision);
      const reason = optionalText(value.reason, WORK_THREAD_BOUNDS.maxReason);
      const waitingFor = optionalText(value.waitingFor, WORK_THREAD_BOUNDS.maxWaitingFor);
      const waitingOn = parseWait(value.waitingOn);
      const acknowledgedRemainders = textList(
        value.acknowledgedRemainders,
        WORK_THREAD_BOUNDS.maxReason,
        WORK_THREAD_BOUNDS.maxAcknowledgedRemainders,
      );
      if (
        to === undefined ||
        expectedRevision === null ||
        reason === undefined ||
        waitingFor === undefined ||
        waitingOn === undefined ||
        acknowledgedRemainders === null ||
        !isWorkThreadId(value.threadId) ||
        (to !== 'waiting' && (waitingFor !== null || waitingOn !== null))
      ) {
        return null;
      }
      return {
        acknowledgedRemainders,
        commandId,
        expectedRevision,
        op: 'set-follow-state',
        reason,
        threadId: value.threadId,
        to,
        waitingFor,
        waitingOn,
      };
    }
    case 'link': {
      const link = parseLinkInput({ key: value.key, kind: value.kind });
      return hasOnlyKeys(value, ['commandId', 'key', 'kind', 'op', 'threadId']) &&
        link &&
        isWorkThreadId(value.threadId)
        ? { commandId, key: link.key, kind: link.kind, op: 'link', threadId: value.threadId }
        : null;
    }
    case 'detach-session':
      return hasOnlyKeys(value, ['commandId', 'key', 'op', 'threadId']) &&
        typeof value.key === 'string' &&
        parseWorkThreadLinkKey('session', value.key) !== null &&
        isWorkThreadId(value.threadId)
        ? { commandId, key: value.key, op: 'detach-session', threadId: value.threadId }
        : null;
    case 'detach-link':
      return hasOnlyKeys(value, ['commandId', 'linkId', 'op', 'threadId']) &&
        isWorkThreadId(value.linkId) &&
        isWorkThreadId(value.threadId)
        ? { commandId, linkId: value.linkId, op: 'detach-link', threadId: value.threadId }
        : null;
    case 'set-note': {
      const note = optionalText(value.note, WORK_THREAD_BOUNDS.maxNote);
      return hasOnlyKeys(value, ['commandId', 'note', 'op', 'threadId']) &&
        note !== undefined &&
        isWorkThreadId(value.threadId)
        ? { commandId, note, op: 'set-note', threadId: value.threadId }
        : null;
    }
    case 'combine': {
      const ticket = parseLinkInput({ key: value.ticketKey, kind: 'jira-issue' });
      const rawParticipants = value.participants;
      if (
        !(
          hasOnlyKeys(value, ['commandId', 'op', 'participants', 'threadId', 'ticketKey']) &&
          ticket &&
          isWorkThreadId(value.threadId) &&
          Array.isArray(rawParticipants)
        ) ||
        rawParticipants.length < 2 ||
        rawParticipants.length > WORK_THREAD_BOUNDS.maxCombinedThreads
      ) {
        return null;
      }
      const participants = rawParticipants.map((item: unknown) => {
        if (!(isRecord(item) && hasOnlyKeys(item, ['expectedRevision', 'threadId']) && isWorkThreadId(item.threadId))) {
          return null;
        }
        const expectedRevision = revision(item.expectedRevision);
        return expectedRevision === null ? null : { expectedRevision, threadId: item.threadId };
      });
      if (
        !participants.every((item): item is { expectedRevision: number; threadId: string } => item !== null) ||
        new Set(participants.map((item) => item.threadId)).size !== participants.length ||
        !participants.some((item) => item.threadId === value.threadId)
      ) {
        return null;
      }
      return { commandId, op: 'combine', participants, threadId: value.threadId, ticketKey: ticket.key };
    }
    case 'separate': {
      const expectedRevision = revision(value.expectedRevision);
      return hasOnlyKeys(value, ['commandId', 'expectedRevision', 'op', 'threadId']) &&
        expectedRevision !== null &&
        isWorkThreadId(value.threadId)
        ? { commandId, expectedRevision, op: 'separate', threadId: value.threadId }
        : null;
    }
    case 'dismiss-intake': {
      const link = parseLinkInput({ key: value.key, kind: 'jira-issue' });
      return hasOnlyKeys(value, ['commandId', 'dismissed', 'key', 'op']) && link && typeof value.dismissed === 'boolean'
        ? { commandId, dismissed: value.dismissed, key: link.key, op: 'dismiss-intake' }
        : null;
    }
    case 'rename': {
      const title = requiredText(value.title, WORK_THREAD_BOUNDS.maxTitle);
      return hasOnlyKeys(value, ['commandId', 'op', 'threadId', 'title']) && title && isWorkThreadId(value.threadId)
        ? { commandId, op: 'rename', threadId: value.threadId, title }
        : null;
    }
    default:
      return null;
  }
};
