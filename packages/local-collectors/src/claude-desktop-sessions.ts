import path from 'node:path';
import { LocalHistoryError, type LocalHistoryWarning } from '@ai-usage/local-machine/errors';
import {
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-machine/local-history';
import { firstExisting, resolvePathCandidates } from '@ai-usage/local-machine/platform-paths';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  CLAUDE_DESKTOP_SUGGESTION_RESOLUTIONS,
  CLAUDE_DESKTOP_TURN_STATUSES,
  type ClaudeDesktopCollectionCompleteness,
  type ClaudeDesktopDeclaredPullRequest,
  type ClaudeDesktopSessionObservation,
  type ClaudeDesktopSideSessionNote,
  type ClaudeDesktopSpawnOrigin,
  type ClaudeDesktopSuggestion,
  type ClaudeDesktopSuggestionResolution,
  type ClaudeDesktopTitleSource,
  type ClaudeDesktopTurnSummary,
  parseClaudeDesktopSessionObservation,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import { Effect } from 'effect';

/**
 * Claude Desktop writes one registry file per session under
 * `<desktopSessionsDir>/<account-uuid>/<org-uuid>/local_<uuid>.json`. This collector reads that
 * registry read-only and normalizes each file into the shared `ClaudeDesktopSessionObservation`
 * contract (`@ai-usage/report-core/work-attention`), which is the only shape the store accepts.
 *
 * Three rules shape every branch below:
 *
 * - **Nothing is invented.** The required identity (`sessionId`, `cliSessionId`, `cwd`, the two
 *   dates, `title`, `isArchived`) must be present and well-typed or the file is `rejected`. Any
 *   other key with an unexpected shape makes the file `unsupported`: its identity is still kept as
 *   a format-`unsupported` row so the read model can show a coverage gap, but no partial reading
 *   of the rest is presented as the session's declaration.
 * - **Text is clamped, identifiers are not.** Free text (titles, `status_detail`, `needs_action`,
 *   reports) is cut at the `WORK_ATTENTION_BOUNDS` ceiling and the clamp reported. Identifiers,
 *   paths and branch names over their bound cannot be shortened without changing their meaning,
 *   so they make the file `unsupported` instead.
 * - **A proposal's `prompt` is never read into the result.** It is the user's brief; only the
 *   title and `tldr` extracts are kept, and the test fixture plants a sentinel to prove it.
 */

export const CLAUDE_DESKTOP_SESSIONS_MAX_FILES = 2000;
export const CLAUDE_DESKTOP_SESSION_FILE_MAX_BYTES = 256 * 1024;
export const CLAUDE_DESKTOP_SESSION_FORMAT_V1 = 'claude-desktop-session-v1';

const SESSION_FILE_PATTERN = /^local_[^/\\]+\.json$/u;
const MAX_REPORTED_ISSUES = 3;

const { maxDetailText, maxId, maxListItems, maxPath, maxReportText, maxShortText, maxSideSessionNotes } =
  WORK_ATTENTION_BOUNDS;

export interface ClaudeDesktopSessionParseContext {
  readonly accountDirectory: string;
  /** ISO timestamp of the file's last modification. */
  readonly fileModifiedAt: string;
  readonly machineId: string;
  /** ISO timestamp of the sweep that read the file. */
  readonly observedAt: string;
  readonly organizationDirectory: string;
  /** Path relative to the observed home; never an absolute path. */
  readonly relativeFilePath: string;
}

export type ClaudeDesktopSessionParseResult =
  | {
      readonly kind: 'observation';
      /** Dotted names of the fields cut to their bound, for the collector's warning. */
      readonly clampedFields: readonly string[];
      readonly observation: ClaudeDesktopSessionObservation;
    }
  | {
      readonly kind: 'unsupported';
      /** The identity-only row, when the required fields were valid. */
      readonly observation: ClaudeDesktopSessionObservation | null;
      readonly reason: string;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

/** Mutable per-file parse state: field names with an unexpected shape, and fields that were cut. */
interface ParseIssues {
  readonly clamped: string[];
  readonly unsupported: string[];
}

const HIGH_SURROGATE_START = 0xd8_00;
const HIGH_SURROGATE_END = 0xdb_ff;

const clampText = (value: string, maxLength: number, field: string, issues: ParseIssues): string => {
  if (value.length <= maxLength) {
    return value;
  }
  issues.clamped.push(field);
  let cut = value.slice(0, maxLength);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= HIGH_SURROGATE_START && last <= HIGH_SURROGATE_END) {
    cut = cut.slice(0, -1);
  }
  return cut;
};

const isAbsent = (value: unknown): value is null | undefined => value === null || value === undefined;

/** Free text that may be cut; a non-string is an unexpected shape. */
const optionalClampedText = (value: unknown, maxLength: number, field: string, issues: ParseIssues): string | null => {
  if (isAbsent(value)) {
    return null;
  }
  if (typeof value !== 'string') {
    issues.unsupported.push(field);
    return null;
  }
  return clampText(value, maxLength, field, issues);
};

/** An identifier, path or ref: kept whole or not at all. */
const optionalIdentifier = (value: unknown, maxLength: number, field: string, issues: ParseIssues): string | null => {
  if (isAbsent(value)) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    issues.unsupported.push(field);
    return null;
  }
  return value;
};

const requiredIdentifier = (value: unknown, maxLength: number, field: string, issues: ParseIssues): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    issues.unsupported.push(field);
    return null;
  }
  return value;
};

const optionalBoolean = (value: unknown, field: string, issues: ParseIssues): boolean | null => {
  if (isAbsent(value)) {
    return null;
  }
  if (typeof value !== 'boolean') {
    issues.unsupported.push(field);
    return null;
  }
  return value;
};

const optionalCount = (value: unknown, field: string, issues: ParseIssues): number | null => {
  if (isAbsent(value)) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    issues.unsupported.push(field);
    return null;
  }
  return value;
};

/** Desktop writes millisecond epochs; an ISO string is accepted as the same fact. */
const instant = (value: unknown): CanonicalInstant | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? normalizeIsoTimestamp(value) : null;
  }
  return typeof value === 'string' ? normalizeIsoTimestamp(value) : null;
};

const optionalInstant = (value: unknown, field: string, issues: ParseIssues): CanonicalInstant | null => {
  if (isAbsent(value)) {
    return null;
  }
  const parsed = instant(value);
  if (parsed === null) {
    issues.unsupported.push(field);
  }
  return parsed;
};

const identifierList = (value: unknown, maxLength: number, field: string, issues: ParseIssues): readonly string[] => {
  if (isAbsent(value)) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.unsupported.push(field);
    return [];
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maxLength) {
      issues.unsupported.push(field);
      return [];
    }
    items.push(entry);
  }
  if (items.length > maxListItems) {
    issues.clamped.push(field);
    return items.slice(0, maxListItems);
  }
  return items;
};

/** A list of records, each parsed by `parseItem`; one malformed item marks the whole field. */
const recordList = <Item>(
  value: unknown,
  field: string,
  issues: ParseIssues,
  parseItem: (entry: Record<string, unknown>, itemField: string) => Item | null,
): readonly Item[] => {
  if (isAbsent(value)) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.unsupported.push(field);
    return [];
  }
  const items: Item[] = [];
  for (const [index, entry] of value.entries()) {
    const itemField = `${field}[${index}]`;
    if (!isRecord(entry)) {
      issues.unsupported.push(itemField);
      return [];
    }
    const parsed = parseItem(entry, itemField);
    if (parsed === null) {
      return [];
    }
    items.push(parsed);
  }
  return items;
};

const clampList = <Item>(items: readonly Item[], field: string, issues: ParseIssues): readonly Item[] => {
  if (items.length <= maxListItems) {
    return items;
  }
  issues.clamped.push(field);
  return items.slice(0, maxListItems);
};

const titleSourceFrom = (value: unknown, issues: ParseIssues): ClaudeDesktopTitleSource => {
  if (isAbsent(value)) {
    return 'unknown';
  }
  if (typeof value !== 'string') {
    issues.unsupported.push('titleSource');
    return 'unknown';
  }
  // A source this reader does not know is still a source: it is labelled unknown, not rejected.
  return value === 'auto' || value === 'tool' ? value : 'unknown';
};

const turnSummaryFrom = (value: unknown, issues: ParseIssues): ClaudeDesktopTurnSummary | null => {
  if (isAbsent(value)) {
    return null;
  }
  if (!isRecord(value)) {
    issues.unsupported.push('postTurnSummary');
    return null;
  }
  const status = value.status_category;
  if (typeof status !== 'string' || !(CLAUDE_DESKTOP_TURN_STATUSES as readonly string[]).includes(status)) {
    issues.unsupported.push('postTurnSummary.status_category');
    return null;
  }
  if (typeof value.status_detail !== 'string') {
    issues.unsupported.push('postTurnSummary.status_detail');
    return null;
  }
  const detail = clampText(value.status_detail, maxDetailText, 'postTurnSummary.status_detail', issues);
  const needsActionText = optionalClampedText(
    value.needs_action,
    maxDetailText,
    'postTurnSummary.needs_action',
    issues,
  );
  const summarizesUuid = optionalIdentifier(value.summarizes_uuid, maxId, 'postTurnSummary.summarizes_uuid', issues);
  return {
    detail,
    // Desktop writes an empty string when nothing is asked; the contract says `null` for that.
    needsAction: needsActionText === null || needsActionText.trim().length === 0 ? null : needsActionText,
    status: status as ClaudeDesktopTurnSummary['status'],
    summarizesUuid,
  };
};

const wrapUpFrom = (value: unknown, issues: ParseIssues): string | null => {
  if (isAbsent(value)) {
    return null;
  }
  if (!isRecord(value)) {
    issues.unsupported.push('turnWrapUp');
    return null;
  }
  return optionalClampedText(value.description, maxReportText, 'turnWrapUp.description', issues);
};

const spawnOriginFrom = (value: unknown, issues: ParseIssues): ClaudeDesktopSpawnOrigin | null => {
  if (isAbsent(value)) {
    return null;
  }
  if (!isRecord(value)) {
    issues.unsupported.push('spawnedFrom');
    return null;
  }
  const sessionId = requiredIdentifier(value.sessionId, maxId, 'spawnedFrom.sessionId', issues);
  if (sessionId === null) {
    return null;
  }
  return {
    sessionId,
    sideSession: optionalBoolean(value.sideSession, 'spawnedFrom.sideSession', issues),
    taskId: optionalIdentifier(value.taskId, maxId, 'spawnedFrom.taskId', issues),
    title: optionalClampedText(value.title, maxShortText, 'spawnedFrom.title', issues),
  };
};

const suggestionFrom = (
  entry: Record<string, unknown>,
  field: string,
  issues: ParseIssues,
): ClaudeDesktopSuggestion | null => {
  // `entry.prompt` is deliberately never read: a proposal is persisted without its brief.
  const id = requiredIdentifier(entry.id, maxId, `${field}.id`, issues);
  if (id === null) {
    return null;
  }
  if (typeof entry.title !== 'string') {
    issues.unsupported.push(`${field}.title`);
    return null;
  }
  return {
    createdAt: optionalInstant(entry.createdAt, `${field}.createdAt`, issues),
    expiresAt: optionalInstant(entry.expiresAt, `${field}.expiresAt`, issues),
    id,
    title: clampText(entry.title, maxShortText, `${field}.title`, issues),
    tldr: optionalClampedText(entry.tldr, maxDetailText, `${field}.tldr`, issues),
  };
};

const resolvedSuggestionsFrom = (
  value: unknown,
  issues: ParseIssues,
): Readonly<Record<string, ClaudeDesktopSuggestionResolution>> => {
  if (isAbsent(value)) {
    return {};
  }
  if (!isRecord(value)) {
    issues.unsupported.push('resolvedBackgroundTaskSuggestions');
    return {};
  }
  const resolved: Record<string, ClaudeDesktopSuggestionResolution> = {};
  let kept = 0;
  for (const [id, resolution] of Object.entries(value)) {
    if (
      id.length === 0 ||
      id.length > maxId ||
      typeof resolution !== 'string' ||
      !(CLAUDE_DESKTOP_SUGGESTION_RESOLUTIONS as readonly string[]).includes(resolution)
    ) {
      // A resolution word this reader does not know is a new vocabulary, not a dismissal.
      issues.unsupported.push('resolvedBackgroundTaskSuggestions');
      return {};
    }
    if (kept === maxListItems) {
      issues.clamped.push('resolvedBackgroundTaskSuggestions');
      break;
    }
    resolved[id] = resolution as ClaudeDesktopSuggestionResolution;
    kept++;
  }
  return resolved;
};

const declaredPullRequestFrom = (
  entry: Record<string, unknown>,
  field: string,
  issues: ParseIssues,
): ClaudeDesktopDeclaredPullRequest | null => {
  const number = entry.prNumber;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    issues.unsupported.push(`${field}.prNumber`);
    return null;
  }
  const repository = requiredIdentifier(entry.repo, maxShortText, `${field}.repo`, issues);
  const host = requiredIdentifier(entry.host, maxShortText, `${field}.host`, issues);
  const state = requiredIdentifier(entry.state, maxShortText, `${field}.state`, issues);
  if (repository === null || host === null || state === null) {
    return null;
  }
  return {
    baseRef: optionalIdentifier(entry.baseRef, maxShortText, `${field}.baseRef`, issues),
    branch: optionalIdentifier(entry.branch, maxShortText, `${field}.branch`, issues),
    host,
    number,
    own: optionalBoolean(entry.own, `${field}.own`, issues),
    repository,
    state,
    url: optionalIdentifier(entry.url, maxPath, `${field}.url`, issues),
  };
};

const sideSessionNoteFrom = (
  entry: Record<string, unknown>,
  field: string,
  issues: ParseIssues,
): ClaudeDesktopSideSessionNote | null => {
  const sessionId = requiredIdentifier(entry.sessionId, maxId, `${field}.sessionId`, issues);
  const at = instant(entry.at);
  if (sessionId === null || at === null || typeof entry.title !== 'string' || typeof entry.report !== 'string') {
    issues.unsupported.push(field);
    return null;
  }
  return {
    at,
    report: clampText(entry.report, maxReportText, `${field}.report`, issues),
    sessionId,
    title: clampText(entry.title, maxShortText, `${field}.title`, issues),
  };
};

/** The most recent notes by `at`, in chronological order, within the contract's bound. */
const latestSideSessionNotes = (
  notes: readonly ClaudeDesktopSideSessionNote[],
  issues: ParseIssues,
): readonly ClaudeDesktopSideSessionNote[] => {
  if (notes.length <= maxSideSessionNotes) {
    return notes;
  }
  issues.clamped.push('sideSessionNotes');
  return [...notes]
    .map((note, index) => ({ index, note }))
    .sort((left, right) => {
      if (left.note.at !== right.note.at) {
        return left.note.at < right.note.at ? 1 : -1;
      }
      return right.index - left.index;
    })
    .slice(0, maxSideSessionNotes)
    .sort((left, right) => left.index - right.index)
    .map(({ note }) => note);
};

interface RequiredFields {
  readonly archived: boolean;
  readonly cliSessionId: string;
  readonly createdAt: CanonicalInstant;
  readonly cwd: string;
  readonly desktopSessionId: string;
  readonly lastActivityAt: CanonicalInstant;
  readonly title: string;
}

const requiredFieldsFrom = (
  raw: Record<string, unknown>,
  issues: ParseIssues,
): { readonly fields: RequiredFields } | { readonly missing: readonly string[] } => {
  const missing: string[] = [];
  const identity = (value: unknown, maxLength: number, field: string): string | null => {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
      missing.push(field);
      return null;
    }
    return value;
  };
  const desktopSessionId = identity(raw.sessionId, maxId, 'sessionId');
  const cliSessionId = identity(raw.cliSessionId, maxId, 'cliSessionId');
  const cwd = identity(raw.cwd, maxPath, 'cwd');
  const createdAt = instant(raw.createdAt);
  if (createdAt === null) {
    missing.push('createdAt');
  }
  const lastActivityAt = instant(raw.lastActivityAt);
  if (lastActivityAt === null) {
    missing.push('lastActivityAt');
  }
  if (typeof raw.title !== 'string') {
    missing.push('title');
  }
  if (typeof raw.isArchived !== 'boolean') {
    missing.push('isArchived');
  }
  if (
    missing.length > 0 ||
    desktopSessionId === null ||
    cliSessionId === null ||
    cwd === null ||
    createdAt === null ||
    lastActivityAt === null ||
    typeof raw.title !== 'string' ||
    typeof raw.isArchived !== 'boolean'
  ) {
    return { missing };
  }
  return {
    fields: {
      archived: raw.isArchived,
      cliSessionId,
      createdAt,
      cwd,
      desktopSessionId,
      lastActivityAt,
      title: clampText(raw.title, maxShortText, 'title', issues),
    },
  };
};

const identityOnlyObservation = (
  fields: RequiredFields,
  titleSource: ClaudeDesktopTitleSource,
  context: ClaudeDesktopSessionParseContext,
  reason: string,
): ClaudeDesktopSessionObservation | null =>
  parseClaudeDesktopSessionObservation({
    accountDirectory: context.accountDirectory,
    archived: fields.archived,
    branch: null,
    cliSessionId: fields.cliSessionId,
    completedTurns: null,
    createdAt: fields.createdAt,
    cwd: fields.cwd,
    declaredPullRequests: [],
    desktopSessionId: fields.desktopSessionId,
    effort: null,
    fileModifiedAt: context.fileModifiedAt,
    filePath: context.relativeFilePath,
    format: 'unsupported',
    lastActivityAt: fields.lastActivityAt,
    lastTurnReport: null,
    machineId: context.machineId,
    model: null,
    observedAt: context.observedAt,
    openSuggestions: [],
    organizationDirectory: context.organizationDirectory,
    originCwd: null,
    priorCliSessionIds: [],
    resolvedSuggestions: {},
    sideSessionNotes: [],
    sourceBranch: null,
    spawnedFrom: null,
    title: fields.title,
    titleSource,
    turnSummary: null,
    unsupportedReason: reason.slice(0, maxDetailText),
    worktreePath: null,
    wrapUpDescription: null,
    writtenBranches: [],
  });

const describeIssues = (issues: readonly string[]): string => {
  const unique = [...new Set(issues)];
  const shown = unique.slice(0, MAX_REPORTED_ISSUES).join(', ');
  return unique.length > MAX_REPORTED_ISSUES ? `${shown} (+${unique.length - MAX_REPORTED_ISSUES})` : shown;
};

/**
 * Normalizes one parsed `local_<uuid>.json` document. Pure: the caller supplies the file context
 * and already decoded the JSON, so the same function serves the collector and its tests.
 */
export const parseClaudeDesktopSessionFile = (
  raw: unknown,
  context: ClaudeDesktopSessionParseContext,
): ClaudeDesktopSessionParseResult => {
  if (!isRecord(raw)) {
    return { kind: 'rejected', reason: 'The session file is not a JSON object.' };
  }
  const issues: ParseIssues = { clamped: [], unsupported: [] };
  const required = requiredFieldsFrom(raw, issues);
  if ('missing' in required) {
    return { kind: 'rejected', reason: `Required fields are missing or invalid: ${describeIssues(required.missing)}.` };
  }
  const { fields } = required;
  const titleSource = titleSourceFrom(raw.titleSource, issues);
  // The only key whose non-null shape has never been observed; a value means a format this
  // reader does not know rather than data to interpret.
  if (!isAbsent(raw.interruptedAwaitingPerson)) {
    issues.unsupported.push('interruptedAwaitingPerson');
  }
  const candidate = {
    accountDirectory: context.accountDirectory,
    archived: fields.archived,
    branch: optionalIdentifier(raw.branch, maxShortText, 'branch', issues),
    cliSessionId: fields.cliSessionId,
    completedTurns: optionalCount(raw.completedTurns, 'completedTurns', issues),
    createdAt: fields.createdAt,
    cwd: fields.cwd,
    declaredPullRequests: clampList(
      recordList(raw.prs, 'prs', issues, (entry, field) => declaredPullRequestFrom(entry, field, issues)),
      'prs',
      issues,
    ),
    desktopSessionId: fields.desktopSessionId,
    effort: optionalClampedText(raw.effort, maxShortText, 'effort', issues),
    fileModifiedAt: context.fileModifiedAt,
    filePath: context.relativeFilePath,
    format: CLAUDE_DESKTOP_SESSION_FORMAT_V1,
    lastActivityAt: fields.lastActivityAt,
    lastTurnReport: optionalClampedText(raw.lastTurnReport, maxReportText, 'lastTurnReport', issues),
    machineId: context.machineId,
    model: optionalClampedText(raw.model, maxShortText, 'model', issues),
    observedAt: context.observedAt,
    openSuggestions: clampList(
      recordList(raw.backgroundTaskSuggestions, 'backgroundTaskSuggestions', issues, (entry, field) =>
        suggestionFrom(entry, field, issues),
      ),
      'backgroundTaskSuggestions',
      issues,
    ),
    organizationDirectory: context.organizationDirectory,
    originCwd: optionalIdentifier(raw.originCwd, maxPath, 'originCwd', issues),
    priorCliSessionIds: identifierList(raw.priorCliSessionIds, maxId, 'priorCliSessionIds', issues),
    resolvedSuggestions: resolvedSuggestionsFrom(raw.resolvedBackgroundTaskSuggestions, issues),
    sideSessionNotes: latestSideSessionNotes(
      recordList(raw.sideSessionNotes, 'sideSessionNotes', issues, (entry, field) =>
        sideSessionNoteFrom(entry, field, issues),
      ),
      issues,
    ),
    sourceBranch: optionalIdentifier(raw.sourceBranch, maxShortText, 'sourceBranch', issues),
    spawnedFrom: spawnOriginFrom(raw.spawnedFrom, issues),
    title: fields.title,
    titleSource,
    turnSummary: turnSummaryFrom(raw.postTurnSummary, issues),
    unsupportedReason: null,
    // `worktreeName` is not carried: on every attested file it equals `basename(worktreePath)`.
    worktreePath: optionalIdentifier(raw.worktreePath, maxPath, 'worktreePath', issues),
    wrapUpDescription: wrapUpFrom(raw.turnWrapUp, issues),
    writtenBranches: identifierList(raw.writtenBranches, maxShortText, 'writtenBranches', issues),
  };
  if (issues.unsupported.length > 0) {
    const reason = `Unsupported field shape: ${describeIssues(issues.unsupported)}.`;
    return { kind: 'unsupported', observation: identityOnlyObservation(fields, titleSource, context, reason), reason };
  }
  // The contract parser is the store's gate; running it here keeps the collector from emitting a
  // row the store would count as skipped.
  const observation = parseClaudeDesktopSessionObservation(candidate);
  if (observation === null) {
    return { kind: 'rejected', reason: 'The normalized observation does not satisfy the Work attention contract.' };
  }
  return { clampedFields: issues.clamped, kind: 'observation', observation };
};

export interface CollectClaudeDesktopSessionsOptions {
  readonly machineId: string;
  /** Per-file byte ceiling; a larger file is rejected and counted, never partially read. */
  readonly maximumFileBytes?: number;
  /** Files read per sweep; the rest leave `truncated` set and a warning. */
  readonly maximumFiles?: number;
  readonly now?: () => Date;
}

export interface ClaudeDesktopSessionCollection {
  readonly completeness: ClaudeDesktopCollectionCompleteness;
  readonly observations: readonly ClaudeDesktopSessionObservation[];
  readonly warnings: readonly LocalHistoryWarning[];
}

const OPERATIONS = {
  clamped: 'claudeDesktopSessions.clamped',
  invalidJson: 'claudeDesktopSessions.invalidJson',
  notRegular: 'claudeDesktopSessions.notRegularFile',
  oversized: 'claudeDesktopSessions.oversized',
  rejected: 'claudeDesktopSessions.rejectedFormat',
  truncated: 'claudeDesktopSessions.truncated',
  unreadable: 'claudeDesktopSessions.unreadable',
} as const;

const emptyCollection = (): ClaudeDesktopSessionCollection => ({
  completeness: { filesParsed: 0, filesSeen: 0, rejected: 0, truncated: false, unsupported: 0 },
  observations: [],
  warnings: [],
});

const countWarning = (operation: string, message: string, count: number, root: string): LocalHistoryWarning => ({
  harness: 'claude',
  message,
  operation,
  path: root,
  rejectedRecords: count,
});

const directoryNames = (
  storage: LocalHistoryStorageService,
  directory: string,
): Effect.Effect<readonly string[] | null, never> =>
  storage.readDir(directory).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.isDirectory)
        .map((entry) => entry.name)
        .sort(),
    ),
    Effect.catchAll(() => Effect.succeed(null)),
  );

/**
 * One bounded, read-only sweep of the Desktop registry on this machine. Only regular files named
 * `local_*.json` at exactly `<account>/<org>/` depth are read; `archived-sessions.idx`,
 * `scheduled-tasks.json`, `deleted_*` and the `backlog/` directory are the app's own bookkeeping
 * and are ignored by name. A missing registry is an empty, complete collection: detection is the
 * source adapter's job.
 */
export const collectClaudeDesktopSessions = (
  options: CollectClaudeDesktopSessionsOptions,
): Effect.Effect<ClaudeDesktopSessionCollection, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const maximumFiles = options.maximumFiles ?? CLAUDE_DESKTOP_SESSIONS_MAX_FILES;
    const maximumFileBytes = options.maximumFileBytes ?? CLAUDE_DESKTOP_SESSION_FILE_MAX_BYTES;
    if (
      !(
        Number.isSafeInteger(maximumFiles) &&
        maximumFiles > 0 &&
        Number.isSafeInteger(maximumFileBytes) &&
        maximumFileBytes > 0
      )
    ) {
      return yield* Effect.fail(
        new LocalHistoryError({
          cause: new Error('Claude Desktop session collection bounds must be positive integers.'),
          operation: 'claudeDesktopSessions.bounds',
        }),
      );
    }
    const root = yield* firstExisting(storage, ...resolvePathCandidates(storage).claude.desktopSessionsDir);
    if (root === null) {
      return emptyCollection();
    }
    const readMetadata = storage.readFileMetadata?.bind(storage);
    if (readMetadata === undefined) {
      return yield* Effect.fail(
        new LocalHistoryError({
          cause: new Error('The local history storage does not expose file metadata.'),
          operation: 'readFileMetadata',
          path: root,
        }),
      );
    }
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const observations: ClaudeDesktopSessionObservation[] = [];
    const warnings: LocalHistoryWarning[] = [];
    const counts = { clamped: 0, invalidJson: 0, notRegular: 0, oversized: 0, rejected: 0, unreadable: 0 };
    let filesSeen = 0;
    let filesParsed = 0;
    let unsupported = 0;
    let truncated = false;

    const accounts = yield* storage.readDir(root);
    const accountNames = accounts
      .filter((entry) => entry.isDirectory)
      .map((entry) => entry.name)
      .sort();
    scan: for (const account of accountNames) {
      const accountDirectory = path.join(root, account);
      const organizations = yield* directoryNames(storage, accountDirectory);
      if (organizations === null) {
        truncated = true;
        continue;
      }
      for (const organization of organizations) {
        const organizationDirectory = path.join(accountDirectory, organization);
        const entries = yield* storage.readDir(organizationDirectory).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (entries === null) {
          truncated = true;
          continue;
        }
        const candidates = entries
          .filter((entry) => SESSION_FILE_PATTERN.test(entry.name))
          .sort((left, right) => left.name.localeCompare(right.name, 'en'));
        for (const entry of candidates) {
          if (filesSeen >= maximumFiles) {
            truncated = true;
            break scan;
          }
          filesSeen++;
          const filePath = path.join(organizationDirectory, entry.name);
          if (!entry.isRegularFile) {
            counts.notRegular++;
            counts.rejected++;
            continue;
          }
          if (entry.size > maximumFileBytes) {
            counts.oversized++;
            counts.rejected++;
            continue;
          }
          const read = yield* Effect.all({
            metadata: readMetadata(filePath),
            text: storage.readText(filePath, maximumFileBytes),
          }).pipe(Effect.either);
          if (read._tag === 'Left') {
            // A file listed and then removed or replaced mid-sweep is counted, not fatal: the
            // rest of the registry still answers and the count says one did not.
            counts.unreadable++;
            counts.rejected++;
            continue;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(read.right.text);
          } catch {
            counts.invalidJson++;
            counts.rejected++;
            continue;
          }
          const fileModifiedAt = normalizeIsoTimestamp(read.right.metadata.mtimeMs);
          if (fileModifiedAt === null) {
            counts.unreadable++;
            counts.rejected++;
            continue;
          }
          const result = parseClaudeDesktopSessionFile(raw, {
            accountDirectory: account,
            fileModifiedAt,
            machineId: options.machineId,
            observedAt,
            organizationDirectory: organization,
            relativeFilePath: path.relative(storage.home, filePath),
          });
          switch (result.kind) {
            case 'observation':
              filesParsed++;
              observations.push(result.observation);
              if (result.clampedFields.length > 0) {
                counts.clamped++;
              }
              break;
            case 'unsupported':
              unsupported++;
              if (result.observation !== null) {
                observations.push(result.observation);
              }
              break;
            default:
              counts.rejected++;
              break;
          }
        }
      }
    }

    if (truncated) {
      warnings.push({
        harness: 'claude',
        message: `Claude Desktop session registry exceeds the ${maximumFiles}-file bound or a directory was unreadable; later files were not read.`,
        operation: OPERATIONS.truncated,
        path: root,
      });
    }
    const countWarnings: readonly (readonly [keyof typeof counts, string, string])[] = [
      ['oversized', OPERATIONS.oversized, `Claude Desktop session files over ${maximumFileBytes} bytes were not read.`],
      ['notRegular', OPERATIONS.notRegular, 'Claude Desktop session entries that are not regular files were not read.'],
      ['invalidJson', OPERATIONS.invalidJson, 'Claude Desktop session files that are not valid JSON were rejected.'],
      ['unreadable', OPERATIONS.unreadable, 'Claude Desktop session files could not be read.'],
      ['clamped', OPERATIONS.clamped, 'Claude Desktop session fields were cut to the Work attention bounds.'],
    ];
    for (const [key, operation, message] of countWarnings) {
      if (counts[key] > 0) {
        warnings.push(countWarning(operation, message, counts[key], root));
      }
    }
    const rejectedFormat =
      counts.rejected - counts.oversized - counts.notRegular - counts.invalidJson - counts.unreadable;
    if (rejectedFormat > 0) {
      warnings.push(
        countWarning(
          OPERATIONS.rejected,
          'Claude Desktop session files without the required identity fields were rejected.',
          rejectedFormat,
          root,
        ),
      );
    }
    return {
      completeness: { filesParsed, filesSeen, rejected: counts.rejected, truncated, unsupported },
      observations,
      warnings,
    };
  });
