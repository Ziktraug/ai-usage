import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { isRecord } from '@ai-usage/report-core/datasets';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  CHECKOUT_STATUS_OUTCOMES,
  CLAUDE_DESKTOP_SUGGESTION_RESOLUTIONS,
  CLAUDE_DESKTOP_TITLE_SOURCES,
  CLAUDE_DESKTOP_TURN_STATUSES,
  PULL_REQUEST_CHECK_ROLLUPS,
  PULL_REQUEST_OBSERVATION_OUTCOMES,
  PULL_REQUEST_STATES,
  WORK_ATTENTION_BOUNDS,
  WORK_ATTENTION_KINDS,
  WORK_FACT_SOURCES,
  WORK_INTERPRETATION_KINDS,
  type WorkAttentionCoverage,
  type WorkAttentionDataset,
  type WorkFact,
  type WorkInterpretation,
  type WorkRoot,
} from '@ai-usage/report-core/work-attention';
import type { WebContractClient } from '@ai-usage/web-contract';
import { ORPCError } from '@orpc/client';

/**
 * Browser-side mirror of the `work.attention` oRPC envelope. The procedure is produced in
 * parallel with this view, so the client narrows an `unknown` response against the shared
 * report-core contract instead of trusting a transport type: an unexpected shape is a typed
 * `MalformedResponse` failure, never a partially rendered dataset.
 */
export interface WorkAttentionRequest {
  readonly limit?: number;
  readonly machineId?: string | null;
}

export interface WorkAttentionClientCallOptions {
  readonly signal?: AbortSignal;
}

export type WorkAttentionErrorTag = 'ForbiddenDemo' | 'IncompatibleStore' | 'MalformedResponse' | 'Unavailable';

export interface WorkAttentionClientError {
  readonly message: string;
  readonly tag: WorkAttentionErrorTag;
}

export type WorkAttentionClientResult =
  | { readonly data: WorkAttentionDataset; readonly ok: true }
  | { readonly error: WorkAttentionClientError; readonly ok: false };

export interface WorkAttentionClient {
  attention(input: WorkAttentionRequest, options?: WorkAttentionClientCallOptions): Promise<WorkAttentionClientResult>;
}

/** The minimal structural shape of the oRPC client; the integrator binds the generated contract type. */
export interface WorkAttentionRpc {
  readonly work: {
    attention(input: WorkAttentionRequest, options?: WorkAttentionClientCallOptions): Promise<unknown>;
  };
}

export const WORK_ATTENTION_LIMIT_BOUNDS = { max: WORK_ATTENTION_BOUNDS.maxRoots, min: 1 } as const;

const ENVELOPE_ERROR_TAGS = new Set<WorkAttentionErrorTag>(['ForbiddenDemo', 'IncompatibleStore', 'Unavailable']);

const unavailableError: WorkAttentionClientError = {
  message: 'Work attention observations are unavailable.',
  tag: 'Unavailable',
};
const malformedError: WorkAttentionClientError = {
  message: 'The Work attention response did not match the shared contract.',
  tag: 'MalformedResponse',
};

const {
  maxChildrenTitles,
  maxDetailText,
  maxFacts,
  maxId,
  maxInterpretations,
  maxPath,
  maxReportText,
  maxRoots,
  maxShortText,
} = WORK_ATTENTION_BOUNDS;

const text = (value: unknown, maxLength: number): string | undefined =>
  typeof value === 'string' && value.length <= maxLength ? value : undefined;
const requiredText = (value: unknown, maxLength: number): string | undefined => {
  const parsed = text(value, maxLength);
  return parsed === undefined || parsed.trim().length === 0 ? undefined : parsed;
};
const optionalText = (value: unknown, maxLength: number): string | null | undefined =>
  value === null || value === undefined ? null : text(value, maxLength);
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const optionalCount = (value: unknown): number | null | undefined =>
  value === null || value === undefined ? null : count(value);
const optionalBoolean = (value: unknown): boolean | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'boolean' ? value : undefined;
};
const instant = (value: unknown): CanonicalInstant | undefined => normalizeIsoTimestamp(value) ?? undefined;
const optionalInstant = (value: unknown): CanonicalInstant | null | undefined =>
  value === null || value === undefined ? null : instant(value);
const oneOf = <const Values extends readonly string[]>(values: Values, value: unknown): Values[number] | undefined =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as Values[number]) : undefined;
const optionalOneOf = <const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): Values[number] | null | undefined => (value === null || value === undefined ? null : oneOf(values, value));
const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const boundedList = <Item>(
  value: unknown,
  maxItems: number,
  parseItem: (entry: unknown) => Item | undefined,
): readonly Item[] | undefined => {
  if (!Array.isArray(value) || value.length > maxItems) {
    return;
  }
  const items: Item[] = [];
  for (const entry of value) {
    const parsed = parseItem(entry);
    if (parsed === undefined) {
      return;
    }
    items.push(parsed);
  }
  return items;
};
const defined = <Value>(entries: readonly (Value | undefined)[]): entries is readonly Value[] =>
  entries.every((entry) => entry !== undefined);

const parseProvenance = (value: unknown): WorkFact['provenance'] | undefined => {
  if (!isRecord(value)) {
    return;
  }
  const coverage = oneOf(['complete', 'partial'] as const, value.coverage);
  const machineId = requiredText(value.machineId, maxId);
  const observedAt = instant(value.observedAt);
  const source = oneOf(WORK_FACT_SOURCES, value.source);
  if (coverage === undefined || machineId === undefined || observedAt === undefined || source === undefined) {
    return;
  }
  return { coverage, machineId, observedAt, source };
};

type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown ? Omit<Value, Key> : never;
type WorkFactBody = DistributiveOmit<WorkFact, 'id' | 'provenance'>;

const parseFactBody = (value: Record<string, unknown>): WorkFactBody | undefined => {
  switch (value.kind) {
    case 'declared-turn': {
      const declaredAt = instant(value.declaredAt);
      const desktopSessionId = requiredText(value.desktopSessionId, maxId);
      const detail = text(value.detail, maxDetailText);
      const needsAction = optionalText(value.needsAction, maxDetailText);
      const status = oneOf(CLAUDE_DESKTOP_TURN_STATUSES, value.status);
      if (
        declaredAt === undefined ||
        desktopSessionId === undefined ||
        detail === undefined ||
        needsAction === undefined ||
        status === undefined
      ) {
        return;
      }
      return { declaredAt, desktopSessionId, detail, kind: 'declared-turn', needsAction, status };
    }
    case 'declared-pull-request': {
      const branch = optionalText(value.branch, maxShortText);
      const declaredBy = oneOf(['root', 'child'] as const, value.declaredBy);
      const host = requiredText(value.host, maxShortText);
      const number = positiveInteger(value.number);
      const repository = requiredText(value.repository, maxShortText);
      const state = requiredText(value.state, maxShortText);
      const url = optionalText(value.url, maxPath);
      if (
        branch === undefined ||
        declaredBy === undefined ||
        host === undefined ||
        number === undefined ||
        repository === undefined ||
        state === undefined ||
        url === undefined
      ) {
        return;
      }
      return { branch, declaredBy, host, kind: 'declared-pull-request', number, repository, state, url };
    }
    case 'pull-request': {
      const accountLabel = optionalText(value.accountLabel, maxShortText);
      const checksRollup = optionalOneOf(PULL_REQUEST_CHECK_ROLLUPS, value.checksRollup);
      const draft = optionalBoolean(value.draft);
      const host = requiredText(value.host, maxShortText);
      const mergedAt = optionalInstant(value.mergedAt);
      const number = positiveInteger(value.number);
      const outcome = oneOf(PULL_REQUEST_OBSERVATION_OUTCOMES, value.outcome);
      const repository = requiredText(value.repository, maxShortText);
      const reviewDecision = optionalText(value.reviewDecision, maxShortText);
      const state = optionalOneOf(PULL_REQUEST_STATES, value.state);
      const updatedAt = optionalInstant(value.updatedAt);
      const url = optionalText(value.url, maxPath);
      if (
        accountLabel === undefined ||
        checksRollup === undefined ||
        draft === undefined ||
        host === undefined ||
        mergedAt === undefined ||
        number === undefined ||
        outcome === undefined ||
        repository === undefined ||
        reviewDecision === undefined ||
        state === undefined ||
        updatedAt === undefined ||
        url === undefined
      ) {
        return;
      }
      return {
        accountLabel,
        checksRollup,
        draft,
        host,
        kind: 'pull-request',
        mergedAt,
        number,
        outcome,
        repository,
        reviewDecision,
        state,
        updatedAt,
        url,
      };
    }
    case 'checkout-status': {
      const ahead = optionalCount(value.ahead);
      const behind = optionalCount(value.behind);
      const branch = optionalText(value.branch, maxShortText);
      const checkoutPath = requiredText(value.checkoutPath, maxPath);
      const dirty = optionalBoolean(value.dirty);
      const lastCommitAt = optionalInstant(value.lastCommitAt);
      const modifiedCount = optionalCount(value.modifiedCount);
      const outcome = oneOf(CHECKOUT_STATUS_OUTCOMES, value.outcome);
      const untrackedCount = optionalCount(value.untrackedCount);
      if (
        ahead === undefined ||
        behind === undefined ||
        branch === undefined ||
        checkoutPath === undefined ||
        dirty === undefined ||
        lastCommitAt === undefined ||
        modifiedCount === undefined ||
        outcome === undefined ||
        untrackedCount === undefined
      ) {
        return;
      }
      return {
        ahead,
        behind,
        branch,
        checkoutPath,
        dirty,
        kind: 'checkout-status',
        lastCommitAt,
        modifiedCount,
        outcome,
        untrackedCount,
      };
    }
    case 'proposal': {
      const createdAt = optionalInstant(value.createdAt);
      const resolution = oneOf(['open', ...CLAUDE_DESKTOP_SUGGESTION_RESOLUTIONS] as const, value.resolution);
      const suggestionId = requiredText(value.suggestionId, maxId);
      const title = requiredText(value.title, maxShortText);
      const tldr = optionalText(value.tldr, maxDetailText);
      if (
        createdAt === undefined ||
        resolution === undefined ||
        suggestionId === undefined ||
        title === undefined ||
        tldr === undefined
      ) {
        return;
      }
      return { createdAt, kind: 'proposal', resolution, suggestionId, title, tldr };
    }
    case 'wrap-up':
    case 'turn-report': {
      const at = instant(value.at);
      const body = text(value.text, maxReportText);
      if (at === undefined || body === undefined) {
        return;
      }
      return { at, kind: value.kind === 'wrap-up' ? 'wrap-up' : 'turn-report', text: body };
    }
    case 'written-branch': {
      const branch = requiredText(value.branch, maxShortText);
      return branch === undefined ? undefined : { branch, kind: 'written-branch' };
    }
    case 'spawned-from': {
      const desktopSessionId = requiredText(value.desktopSessionId, maxId);
      const taskId = optionalText(value.taskId, maxId);
      const title = optionalText(value.title, maxShortText);
      if (desktopSessionId === undefined || taskId === undefined || title === undefined) {
        return;
      }
      return { desktopSessionId, kind: 'spawned-from', taskId, title };
    }
    case 'side-session-note': {
      const at = instant(value.at);
      const report = text(value.report, maxReportText);
      const sessionId = requiredText(value.sessionId, maxId);
      const title = text(value.title, maxShortText);
      if (at === undefined || report === undefined || sessionId === undefined || title === undefined) {
        return;
      }
      return { at, kind: 'side-session-note', report, sessionId, title };
    }
    default:
      return;
  }
};

const parseFact = (value: unknown): WorkFact | undefined => {
  if (!isRecord(value)) {
    return;
  }
  const id = requiredText(value.id, maxId);
  const provenance = parseProvenance(value.provenance);
  const body = parseFactBody(value);
  if (id === undefined || provenance === undefined || body === undefined) {
    return;
  }
  return { id, provenance, ...body } as WorkFact;
};

const parseInterpretation = (value: unknown): WorkInterpretation | undefined => {
  if (!isRecord(value)) {
    return;
  }
  const evidence = boundedList(value.evidence, maxFacts, (entry) => requiredText(entry, maxId));
  const kind = oneOf(WORK_INTERPRETATION_KINDS, value.kind);
  const body = text(value.text, maxDetailText);
  const uncertainty = text(value.uncertainty, maxDetailText);
  if (evidence === undefined || kind === undefined || body === undefined || uncertainty === undefined) {
    return;
  }
  return { evidence, kind, text: body, uncertainty };
};

const parseRoot = (value: unknown): WorkRoot | undefined => {
  if (
    !(
      isRecord(value) &&
      isRecord(value.age) &&
      isRecord(value.children) &&
      isRecord(value.key) &&
      isRecord(value.project)
    )
  ) {
    return;
  }
  const age = {
    createdAt: optionalInstant(value.age.createdAt),
    declaredAt: optionalInstant(value.age.declaredAt),
    lastActivityAt: optionalInstant(value.age.lastActivityAt),
    lastObservedAt: optionalInstant(value.age.lastObservedAt),
  };
  const children = {
    blocked: count(value.children.blocked),
    completed: count(value.children.completed),
    count: count(value.children.count),
    reviewReady: count(value.children.reviewReady),
    titles: boundedList(value.children.titles, maxChildrenTitles, (entry) => text(entry, maxShortText)),
  };
  const key = {
    harness: requiredText(value.key.harness, maxShortText),
    machineId: requiredText(value.key.machineId, maxId),
    sourceSessionId: requiredText(value.key.sourceSessionId, maxId),
  };
  const project = {
    branch: optionalText(value.project.branch, maxShortText),
    checkoutPath: optionalText(value.project.checkoutPath, maxPath),
    label: text(value.project.label, maxShortText),
    worktreeName: optionalText(value.project.worktreeName, maxShortText),
  };
  const declared = parseDeclaration(value.declared);
  const session = parseSession(value.session);
  const archived = typeof value.archived === 'boolean' ? value.archived : undefined;
  const reconsidered = typeof value.reconsidered === 'boolean' ? value.reconsidered : undefined;
  const attention = oneOf(WORK_ATTENTION_KINDS, value.attention);
  const desktopSessionId = optionalText(value.desktopSessionId, maxId);
  const facts = boundedList(value.facts, maxFacts, parseFact);
  const interpretations = boundedList(value.interpretations, maxInterpretations, parseInterpretation);
  const title = text(value.title, maxShortText);
  const titleSource = oneOf(CLAUDE_DESKTOP_TITLE_SOURCES, value.titleSource);
  if (
    !(
      defined(Object.values(age)) &&
      defined(Object.values(children)) &&
      defined(Object.values(key)) &&
      defined(Object.values(project))
    ) ||
    declared === undefined ||
    session === undefined ||
    archived === undefined ||
    reconsidered === undefined ||
    attention === undefined ||
    desktopSessionId === undefined ||
    facts === undefined ||
    interpretations === undefined ||
    title === undefined ||
    titleSource === undefined
  ) {
    return;
  }
  return {
    age: age as WorkRoot['age'],
    archived,
    attention,
    children: children as WorkRoot['children'],
    declared,
    desktopSessionId,
    facts,
    interpretations,
    key: key as WorkRoot['key'],
    project: project as WorkRoot['project'],
    reconsidered,
    session,
    title,
    titleSource,
  };
};

const parseDeclaration = (value: unknown): WorkRoot['declared'] | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return;
  }
  const at = instant(value.at);
  const detail = text(value.detail, maxDetailText);
  const needsAction = optionalText(value.needsAction, maxDetailText);
  const status = oneOf(CLAUDE_DESKTOP_TURN_STATUSES, value.status);
  if (at === undefined || detail === undefined || needsAction === undefined || status === undefined) {
    return;
  }
  return { at, detail, needsAction, status };
};

const parseSession = (value: unknown): WorkRoot['session'] | undefined => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return;
  }
  const campaignKey = optionalText(value.campaignKey, maxId);
  const rowId = requiredText(value.rowId, maxId);
  return campaignKey === undefined || rowId === undefined ? undefined : { campaignKey, rowId };
};

const nullableRevision = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
};

const parseCoverage = (value: unknown): WorkAttentionCoverage | undefined => {
  if (
    !(
      isRecord(value) &&
      isRecord(value.checkouts) &&
      isRecord(value.desktopSessions) &&
      isRecord(value.pullRequests) &&
      isRecord(value.sessions) &&
      isRecord(value.window)
    )
  ) {
    return;
  }
  const checkouts = {
    failed: count(value.checkouts.failed),
    lastRunAt: optionalInstant(value.checkouts.lastRunAt),
    observed: count(value.checkouts.observed),
  };
  const desktopSessions = {
    collectedAt: optionalInstant(value.desktopSessions.collectedAt),
    filesParsed: count(value.desktopSessions.filesParsed),
    filesSeen: count(value.desktopSessions.filesSeen),
    refusedRows: count(value.desktopSessions.refusedRows),
    truncated: typeof value.desktopSessions.truncated === 'boolean' ? value.desktopSessions.truncated : undefined,
    unsupported: count(value.desktopSessions.unsupported),
  };
  const pullRequests = {
    disabled: typeof value.pullRequests.disabled === 'boolean' ? value.pullRequests.disabled : undefined,
    failed: count(value.pullRequests.failed),
    lastRunAt: optionalInstant(value.pullRequests.lastRunAt),
    observed: count(value.pullRequests.observed),
  };
  const sessions = {
    joined: count(value.sessions.joined),
    revision: nullableRevision(value.sessions.revision),
    unmatched: count(value.sessions.unmatched),
  };
  const window = {
    excludedRoots: count(value.window.excludedRoots),
    sinceDays: positiveInteger(value.window.sinceDays),
  };
  if (
    !(
      defined(Object.values(checkouts)) &&
      defined(Object.values(desktopSessions)) &&
      defined(Object.values(pullRequests)) &&
      defined(Object.values(sessions)) &&
      defined(Object.values(window))
    )
  ) {
    return;
  }
  return {
    checkouts: checkouts as WorkAttentionCoverage['checkouts'],
    desktopSessions: desktopSessions as WorkAttentionCoverage['desktopSessions'],
    pullRequests: pullRequests as WorkAttentionCoverage['pullRequests'],
    sessions: sessions as WorkAttentionCoverage['sessions'],
    window: window as WorkAttentionCoverage['window'],
  };
};

/**
 * Narrows an untrusted value to a `WorkAttentionDataset`, enforcing the shared bounds. Returns
 * `undefined` for anything incomplete or out of bounds; nothing is defaulted or dropped silently.
 */
export const parseWorkAttentionDataset = (value: unknown): WorkAttentionDataset | undefined => {
  if (!isRecord(value)) {
    return;
  }
  const coverage = parseCoverage(value.coverage);
  const generatedAt = instant(value.generatedAt);
  const machineId = optionalText(value.machineId, maxId);
  const roots = boundedList(value.roots, maxRoots, parseRoot);
  const totalRoots = count(value.totalRoots);
  const truncated = typeof value.truncated === 'boolean' ? value.truncated : undefined;
  if (
    coverage === undefined ||
    generatedAt === undefined ||
    machineId === undefined ||
    roots === undefined ||
    totalRoots === undefined ||
    truncated === undefined ||
    totalRoots < roots.length
  ) {
    return;
  }
  return { coverage, generatedAt, machineId, roots, totalRoots, truncated };
};

const parseEnvelope = (value: unknown): WorkAttentionClientResult => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return { error: malformedError, ok: false };
  }
  if (value.ok) {
    const data = parseWorkAttentionDataset(value.data);
    return data === undefined ? { error: malformedError, ok: false } : { data, ok: true };
  }
  if (!isRecord(value.error)) {
    return { error: malformedError, ok: false };
  }
  const tag = typeof value.error.tag === 'string' ? value.error.tag : '';
  const message = text(value.error.message, maxDetailText);
  if (!ENVELOPE_ERROR_TAGS.has(tag as WorkAttentionErrorTag) || message === undefined) {
    return { error: malformedError, ok: false };
  }
  return { error: { message, tag: tag as WorkAttentionErrorTag }, ok: false };
};

const normalizeRequest = (input: WorkAttentionRequest): WorkAttentionRequest => {
  const limit = input.limit;
  if (
    limit !== undefined &&
    !(
      Number.isSafeInteger(limit) &&
      limit >= WORK_ATTENTION_LIMIT_BOUNDS.min &&
      limit <= WORK_ATTENTION_LIMIT_BOUNDS.max
    )
  ) {
    throw new RangeError(`Work attention limit must be an integer between 1 and ${WORK_ATTENTION_LIMIT_BOUNDS.max}.`);
  }
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
  };
};

export const createWorkAttentionClient = (rpc: WorkAttentionRpc): WorkAttentionClient => ({
  attention: async (input, options = {}) => {
    const request = normalizeRequest(input);
    try {
      options.signal?.throwIfAborted();
      const response = await rpc.work.attention(request, options);
      options.signal?.throwIfAborted();
      return parseEnvelope(response);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof ORPCError && error.defined && ENVELOPE_ERROR_TAGS.has(error.code as WorkAttentionErrorTag)) {
        return { error: { message: error.message, tag: error.code as WorkAttentionErrorTag }, ok: false };
      }
      return { error: unavailableError, ok: false };
    }
  },
});

/** A client that answers every call with one typed `Unavailable` failure and never touches a transport. */
export const unavailableWorkAttentionClient = (message: string): WorkAttentionClient => ({
  attention: () => Promise.resolve({ error: { message, tag: 'Unavailable' }, ok: false }),
});

/**
 * Integration seam. `work.attention` is not part of this checkout's web contract yet, and the oRPC
 * proxy cannot be probed at runtime (every property resolves to a callable), so the only honest
 * answer before integration is a typed unavailability rather than a request to a route that does
 * not exist. Replace the body with `createWorkAttentionClient(rpc)` once the contract carries it.
 */
export const resolveWorkAttentionClient = (rpc: WebContractClient): WorkAttentionClient =>
  createWorkAttentionClient(rpc);
