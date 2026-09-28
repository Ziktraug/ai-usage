import type { SerializedUsageRow } from './report-data';
import { isSerializedUsageRow } from './serialized-usage-validation';
import { parseServedRevision } from './served-revision';
import { parseSessionVcsContext, type SessionVcsContext } from './session-vcs';

const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;
const MAX_PHASES = 256;
// Prompt identities are what group activity into rounds, so their budget matches
// the turn budget. Prompt bodies stay bounded separately by the byte budgets
// below and by the reader's total-body budget; an identity whose body was not
// retained keeps an empty text and reports it through coverage.
const MAX_PROMPTS = 1024;
const MAX_PROMPT_TEXT_LENGTH = 32 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TURNS = 1024;
const MAX_TURN_INTERVALS = 2048;
const MAX_CHILDREN = 512;
const MAX_INTERACTIONS = 2048;
const MAX_COVERAGE_REASONS = 16;

export const sessionDetailHarnessKeys = ['claude', 'codex', 'opencode'] as const;
export type SessionDetailHarnessKey = (typeof sessionDetailHarnessKeys)[number];

export const supportsSessionDetailHarness = (value: string): value is SessionDetailHarnessKey =>
  sessionDetailHarnessKeys.some((key) => key === value);

export interface SessionDetailRequest {
  revision: string;
  rowId: string;
}

export interface SessionDetailTokenCounts {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  total: number;
}

export interface SessionProjectionModelFacts {
  model: string;
  tokens: SessionDetailTokenCounts;
}

export interface SessionProjectionFacts {
  calls: number;
  durationMs: number | null;
  modelSegments: SessionProjectionModelFacts[] | null;
  partial: boolean;
  tokens: SessionDetailTokenCounts | null;
  tools: number;
  turns: number;
}

export interface LocalSessionAnalysis {
  detail: SessionDetail;
  projection: SessionProjectionFacts;
}

export const sessionDetailSourceAuthorities = ['local-observed', 'portable-opaque'] as const;
export type SessionDetailSourceAuthority = (typeof sessionDetailSourceAuthorities)[number];

export interface SessionDetailReportAnchor {
  harnessKey: string | null;
  machineId: string | null;
  projection: SessionProjectionFacts;
  sourceAuthority: SessionDetailSourceAuthority;
  sourceSessionId: string | null;
  vcs: SessionVcsContext | null;
}

export interface SessionDetailAnchorResult {
  anchor: SessionDetailReportAnchor | null;
  requestFingerprint: string;
  revision: string;
}

export type SessionDetailComparableField =
  | 'calls'
  | 'duration'
  | 'model-attribution'
  | 'coverage'
  | 'tokens'
  | 'tools'
  | 'turns';

export type SessionDetailConsistency =
  | { checkedFields: SessionDetailComparableField[]; status: 'matches-report' }
  | {
      checkedFields: SessionDetailComparableField[];
      differingFields: SessionDetailComparableField[];
      status: 'differs-from-report';
    }
  | {
      checkedFields: SessionDetailComparableField[];
      reason: 'insufficient-comparable-facts';
      status: 'cannot-compare';
    };

export type SessionDetailCostKind = 'approximate' | 'reported' | 'unknown';
export type SessionDetailCoverageStatus = 'partial' | 'recorded';
export type SessionDetailEffortKind = 'default' | 'recorded' | 'unavailable';
export const sessionDetailTimingStatuses = ['recorded', 'partial', 'unavailable'] as const;
export type SessionDetailTimingStatus = (typeof sessionDetailTimingStatuses)[number];

export interface SessionDetailPhase {
  cost: number | null;
  costKind: SessionDetailCostKind;
  effort: string | null;
  effortKind: SessionDetailEffortKind;
  endAt: string;
  model: string;
  startAt: string;
  tokens: SessionDetailTokenCounts;
}

export interface SessionDetailPrompt {
  id: string;
  text: string;
  timestamp: string;
  truncated: boolean;
}

export interface SessionDetailInterval {
  endAt: string;
  startAt: string;
}

export interface SessionDetailTurn {
  /** API calls attributed to this turn; null when the harness does not record them. */
  calls: number | null;
  /** Canonical API-equivalent value of the turn's own usage; null exactly when unknown. */
  cost: number | null;
  costKind: SessionDetailCostKind;
  durationMs: number | null;
  effort: string | null;
  effortKind: SessionDetailEffortKind;
  endAt: string;
  index: number;
  intervals: SessionDetailInterval[];
  model: string;
  promptIds: string[];
  startAt: string;
  timingStatus: 'recorded' | 'unavailable';
  tokens: SessionDetailTokenCounts;
  tools: number;
}

/**
 * How a child session was linked to this session. The evidence kind is part of
 * the fact: a Codex thread edge proves parentage but not the spawning turn,
 * while a Claude tool link names both.
 */
export const sessionDetailChildEvidences = [
  'claude-agent-link',
  'claude-agent-meta',
  'codex-thread-edge',
  'opencode-session-parent',
] as const;
export type SessionDetailChildEvidence = (typeof sessionDetailChildEvidences)[number];

export interface SessionDetailChildLink {
  agentType: string | null;
  evidence: SessionDetailChildEvidence;
  label: string | null;
  /** The child's own source session identity, joinable to its report row. */
  sourceSessionId: string;
  /** Turn that launched the child; null means the spawning turn is not recorded. */
  spawnTurnIndex: number | null;
}

export type SessionDetailInteractionKind = 'message' | 'spawn';

export interface SessionDetailInteraction {
  at: string;
  /** Null when the tool result never named the child, so the launch is known but not its identity. */
  childSourceSessionId: string | null;
  kind: SessionDetailInteractionKind;
  label: string | null;
  toolUseId: string;
  /** Turn the interaction belongs to; null keeps an unattributed interaction visible. */
  turnIndex: number | null;
}

export const sessionDetailCoverageReasons = [
  'ancestry-budget',
  'ancestry-conflict',
  'ancestry-cycle',
  'child-budget',
  'child-metadata-unreadable',
  'child-result-missing',
  'harness-no-child-evidence',
  'harness-no-spawn-evidence',
  'interaction-budget',
  'prompt-body-budget',
  'prompt-budget',
  'record-budget',
  'timing-not-recorded',
  'timing-rejected',
  'turn-budget',
  'unattributed-activity',
] as const;
export type SessionDetailCoverageReason = (typeof sessionDetailCoverageReasons)[number];

export type SessionDetailCoverageState = 'complete' | 'partial' | 'unavailable';

export interface SessionDetailCoverageFact {
  /** Items known to be missing; null when the count itself is unknowable. */
  omittedCount: number | null;
  reasons: SessionDetailCoverageReason[];
  status: SessionDetailCoverageState;
}

export interface SessionDetailCoverage {
  childDiscovery: SessionDetailCoverageFact;
  grouping: SessionDetailCoverageFact;
  interactionAttribution: SessionDetailCoverageFact;
  promptBodies: SessionDetailCoverageFact;
  recordedTiming: SessionDetailCoverageFact;
}

export const sessionDetailCoverageKeys = [
  'childDiscovery',
  'grouping',
  'interactionAttribution',
  'promptBodies',
  'recordedTiming',
] as const satisfies readonly (keyof SessionDetailCoverage)[];

export const completeCoverage = (): SessionDetailCoverageFact => ({ omittedCount: 0, reasons: [], status: 'complete' });

export interface SessionDetail {
  activeDurationMs: number | null;
  children: SessionDetailChildLink[];
  coverage: SessionDetailCoverage;
  durationStatus: SessionDetailTimingStatus;
  efforts: string[];
  elapsedDurationMs: number;
  endedAt: string;
  idleDurationMs: number | null;
  interactions: SessionDetailInteraction[];
  models: string[];
  observedAt: string;
  phases: SessionDetailPhase[];
  prompts: SessionDetailPrompt[];
  promptsTruncated: boolean;
  sourceSessionId: string;
  startedAt: string;
  turns: SessionDetailTurn[];
  turnsStatus: SessionDetailCoverageStatus;
}

export type SessionDetailRoundKind = 'prompt' | 'unattributed';

/**
 * A round is one prompt-led unit of activity: the prompt(s) that opened it,
 * the activity attributable to them until the next prompt, and the sub-agent
 * interactions launched or messaged in between. Activity without a prompt
 * stays a round of its own (ADR 0017: absence is shown, never folded away).
 */
export interface SessionDetailRound {
  calls: number | null;
  cost: number | null;
  costKind: SessionDetailCostKind;
  endAt: string;
  id: string;
  index: number;
  interactionIndexes: number[];
  kind: SessionDetailRoundKind;
  model: string;
  /** Wall-clock distance between the first and last attributable record; not active time. */
  observedSpanMs: number;
  promptIds: string[];
  /** Union of recorded harness intervals; null when the harness recorded none. */
  recordedActiveMs: number | null;
  startAt: string;
  tokens: SessionDetailTokenCounts;
  tools: number;
  turnIndex: number;
}

/**
 * The one canonical derivation of rounds from validated turns (ADR 0018).
 * Readers already group each harness's activity per prompt into a turn, so a
 * round is the turn plus its interactions; nothing is re-priced or re-summed.
 */
export const deriveSessionRounds = (detail: Pick<SessionDetail, 'interactions' | 'turns'>): SessionDetailRound[] => {
  const interactionsByTurn = new Map<number, number[]>();
  for (const [index, interaction] of detail.interactions.entries()) {
    if (interaction.turnIndex === null) {
      continue;
    }
    const current = interactionsByTurn.get(interaction.turnIndex) ?? [];
    current.push(index);
    interactionsByTurn.set(interaction.turnIndex, current);
  }
  return [...detail.turns]
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt) || left.index - right.index)
    .map((turn, index) => ({
      calls: turn.calls,
      cost: turn.cost,
      costKind: turn.costKind,
      endAt: turn.endAt,
      id: turn.promptIds[0] === undefined ? `activity:${turn.index}` : `prompt:${turn.promptIds[0]}`,
      index,
      interactionIndexes: interactionsByTurn.get(turn.index) ?? [],
      kind: turn.promptIds.length > 0 ? 'prompt' : 'unattributed',
      model: turn.model,
      observedSpanMs: Math.max(0, Date.parse(turn.endAt) - Date.parse(turn.startAt)),
      promptIds: turn.promptIds,
      recordedActiveMs: turn.durationMs,
      startAt: turn.startAt,
      tokens: turn.tokens,
      tools: turn.tools,
      turnIndex: turn.index,
    }));
};

export type SessionDetailUnavailableReason =
  | 'history-unavailable'
  | 'not-found'
  | 'not-local'
  | 'report-provenance-unavailable'
  | 'report-row-not-found'
  | 'revision-expired'
  | 'unsupported';

export type SessionDetailResponse =
  | { consistency: SessionDetailConsistency; detail: SessionDetail; revision: string; status: 'available' }
  | { message: string; reason: SessionDetailUnavailableReason; status: 'unavailable' };

export class SessionDetailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionDetailValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertExactKeys = (record: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new SessionDetailValidationError(`${label} contains unknown fields`);
  }
};

const requireString = (value: unknown, label: string, maximumLength = MAX_LABEL_LENGTH): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new SessionDetailValidationError(`${label} must be a non-empty bounded string`);
  }
  return value;
};

const requireNullableString = (value: unknown, label: string, maximumLength = MAX_LABEL_LENGTH): string | null =>
  value === null ? null : requireString(value, label, maximumLength);

const requireTimestamp = (value: unknown, label: string): string => {
  const timestamp = requireString(value, label);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== timestamp) {
    throw new SessionDetailValidationError(`${label} must be an ISO timestamp`);
  }
  return timestamp;
};

const requireNonNegativeNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SessionDetailValidationError(`${label} must be a non-negative finite number`);
  }
  return value;
};

const requireNullableNonNegativeNumber = (value: unknown, label: string): number | null =>
  value === null ? null : requireNonNegativeNumber(value, label);

const parseCostKind = (value: unknown, label: string): SessionDetailCostKind => {
  if (value !== 'approximate' && value !== 'reported' && value !== 'unknown') {
    throw new SessionDetailValidationError(`${label} is invalid`);
  }
  return value;
};

const parseCoverageStatus = (value: unknown, label: string): SessionDetailCoverageStatus => {
  if (value !== 'partial' && value !== 'recorded') {
    throw new SessionDetailValidationError(`${label} is invalid`);
  }
  return value;
};

const parseTimingStatus = (value: unknown, label: string): SessionDetailTimingStatus => {
  const status = sessionDetailTimingStatuses.find((candidate) => candidate === value);
  if (!status) {
    throw new SessionDetailValidationError(`${label} is invalid`);
  }
  return status;
};

const parseEffortKind = (value: unknown, label: string): SessionDetailEffortKind => {
  if (value !== 'default' && value !== 'recorded' && value !== 'unavailable') {
    throw new SessionDetailValidationError(`${label} is invalid`);
  }
  return value;
};

const requireNonNegativeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SessionDetailValidationError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
};

const parseStringArray = (value: unknown, label: string, maximumItems: number): string[] => {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new SessionDetailValidationError(`${label} must be a bounded string array`);
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`));
};

const parseTokenCounts = (value: unknown, label: string): SessionDetailTokenCounts => {
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(value, ['cacheRead', 'cacheWrite', 'input', 'output', 'total'], label);
  const tokens = {
    cacheRead: requireNonNegativeInteger(value.cacheRead, `${label}.cacheRead`),
    cacheWrite: requireNonNegativeInteger(value.cacheWrite, `${label}.cacheWrite`),
    input: requireNonNegativeInteger(value.input, `${label}.input`),
    output: requireNonNegativeInteger(value.output, `${label}.output`),
    total: requireNonNegativeInteger(value.total, `${label}.total`),
  };
  if (tokens.total !== tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite) {
    throw new SessionDetailValidationError(`${label}.total does not match its token parts`);
  }
  return tokens;
};

const parseProjectionFacts = (value: unknown, label: string): SessionProjectionFacts => {
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(value, ['calls', 'durationMs', 'modelSegments', 'partial', 'tokens', 'tools', 'turns'], label);
  if (typeof value.partial !== 'boolean') {
    throw new SessionDetailValidationError(`${label}.partial must be a boolean`);
  }
  let modelSegments: SessionProjectionModelFacts[] | null = null;
  if (value.modelSegments !== null) {
    if (!Array.isArray(value.modelSegments) || value.modelSegments.length > MAX_PHASES) {
      throw new SessionDetailValidationError(`${label}.modelSegments must be a bounded array or null`);
    }
    modelSegments = value.modelSegments.map((segment, index) => {
      const segmentLabel = `${label}.modelSegments[${index}]`;
      if (!isRecord(segment)) {
        throw new SessionDetailValidationError(`${segmentLabel} must be an object`);
      }
      assertExactKeys(segment, ['model', 'tokens'], segmentLabel);
      return {
        model: requireString(segment.model, `${segmentLabel}.model`),
        tokens: parseTokenCounts(segment.tokens, `${segmentLabel}.tokens`),
      };
    });
    for (let index = 1; index < modelSegments.length; index += 1) {
      if (modelSegments[index - 1]!.model.localeCompare(modelSegments[index]!.model) >= 0) {
        throw new SessionDetailValidationError(`${label}.modelSegments must be canonically ordered and unique`);
      }
    }
  }
  return {
    calls: requireNonNegativeInteger(value.calls, `${label}.calls`),
    durationMs: requireNullableNonNegativeNumber(value.durationMs, `${label}.durationMs`),
    modelSegments,
    partial: value.partial,
    tokens: value.tokens === null ? null : parseTokenCounts(value.tokens, `${label}.tokens`),
    tools: requireNonNegativeInteger(value.tools, `${label}.tools`),
    turns: requireNonNegativeInteger(value.turns, `${label}.turns`),
  };
};

const projectionTokensForRow = (
  row: Pick<SerializedUsageRow, 'tokCr' | 'tokCw' | 'tokIn' | 'tokOut' | 'tokenTotal'>,
): SessionDetailTokenCounts => ({
  cacheRead: row.tokCr,
  cacheWrite: row.tokCw,
  input: row.tokIn,
  output: row.tokOut,
  total: row.tokenTotal,
});

export const sessionProjectionFactsForSerializedRow = (value: unknown): SessionProjectionFacts => {
  if (!isSerializedUsageRow(value)) {
    throw new SessionDetailValidationError('Session projection source row is invalid');
  }
  let modelSegments: SessionProjectionModelFacts[] | null;
  if (value.modelSegments) {
    modelSegments = value.modelSegments
      .map((segment) => ({
        model: segment.model,
        tokens: projectionTokensForRow({
          tokCr: segment.tokCr,
          tokCw: segment.tokCw,
          tokIn: segment.tokIn,
          tokOut: segment.tokOut,
          tokenTotal: segment.tokCr + segment.tokCw + segment.tokIn + segment.tokOut,
        }),
      }))
      .sort((left, right) => left.model.localeCompare(right.model));
  } else if (value.models && value.models.length > 1) {
    modelSegments = null;
  } else {
    modelSegments = [{ model: value.model, tokens: projectionTokensForRow(value) }];
  }
  return {
    calls: value.calls,
    durationMs: value.durationMs,
    modelSegments,
    partial: value.partial ?? false,
    tokens: value.usageUnavailable ? null : projectionTokensForRow(value),
    tools: value.tools,
    turns: value.turns,
  };
};

const parsePhase = (value: unknown, index: number): SessionDetailPhase => {
  const label = `session detail.phases[${index}]`;
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(value, ['cost', 'costKind', 'effort', 'effortKind', 'endAt', 'model', 'startAt', 'tokens'], label);
  const cost = requireNullableNonNegativeNumber(value.cost, `${label}.cost`);
  const costKind = parseCostKind(value.costKind, `${label}.costKind`);
  const effort = requireNullableString(value.effort, `${label}.effort`);
  const effortKind = parseEffortKind(value.effortKind, `${label}.effortKind`);
  if ((costKind === 'unknown') !== (cost === null)) {
    throw new SessionDetailValidationError(`${label}.cost must be null exactly when its kind is unknown`);
  }
  if ((effortKind === 'recorded') !== (effort !== null)) {
    throw new SessionDetailValidationError(`${label}.effort must be present exactly when it was recorded`);
  }
  return {
    cost,
    costKind,
    effort,
    effortKind,
    endAt: requireTimestamp(value.endAt, `${label}.endAt`),
    model: requireString(value.model, `${label}.model`),
    startAt: requireTimestamp(value.startAt, `${label}.startAt`),
    tokens: parseTokenCounts(value.tokens, `${label}.tokens`),
  };
};

const parsePrompt = (value: unknown, index: number): SessionDetailPrompt => {
  const label = `session detail.prompts[${index}]`;
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(value, ['id', 'text', 'timestamp', 'truncated'], label);
  if (typeof value.truncated !== 'boolean') {
    throw new SessionDetailValidationError(`${label}.truncated must be a boolean`);
  }
  // An empty body is a prompt whose identity was kept for grouping while its
  // text fell outside the body budget; it must say so through `truncated`.
  if (typeof value.text !== 'string' || value.text.length > MAX_PROMPT_TEXT_LENGTH) {
    throw new SessionDetailValidationError(`${label}.text must be a bounded string`);
  }
  if (value.text.length === 0 && !value.truncated) {
    throw new SessionDetailValidationError(`${label}.text may be empty only when its body was not retained`);
  }
  return {
    id: requireString(value.id, `${label}.id`, MAX_ID_LENGTH),
    text: value.text,
    timestamp: requireTimestamp(value.timestamp, `${label}.timestamp`),
    truncated: value.truncated,
  };
};

const parseInterval = (value: unknown, index: number, turnIndex: number): SessionDetailInterval => {
  const label = `session detail.turns[${turnIndex}].intervals[${index}]`;
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(value, ['endAt', 'startAt'], label);
  return {
    endAt: requireTimestamp(value.endAt, `${label}.endAt`),
    startAt: requireTimestamp(value.startAt, `${label}.startAt`),
  };
};

const parseTurn = (value: unknown, index: number): SessionDetailTurn => {
  const label = `session detail.turns[${index}]`;
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(
    value,
    [
      'calls',
      'cost',
      'costKind',
      'durationMs',
      'effort',
      'effortKind',
      'endAt',
      'index',
      'intervals',
      'model',
      'promptIds',
      'startAt',
      'timingStatus',
      'tokens',
      'tools',
    ],
    label,
  );
  if (!(Array.isArray(value.intervals) && value.intervals.length <= MAX_TURN_INTERVALS)) {
    throw new SessionDetailValidationError(`${label}.intervals must be a bounded array`);
  }
  const cost = requireNullableNonNegativeNumber(value.cost, `${label}.cost`);
  const costKind = parseCostKind(value.costKind, `${label}.costKind`);
  if ((costKind === 'unknown') !== (cost === null)) {
    throw new SessionDetailValidationError(`${label}.cost must be null exactly when its kind is unknown`);
  }
  const effort = requireNullableString(value.effort, `${label}.effort`);
  const effortKind = parseEffortKind(value.effortKind, `${label}.effortKind`);
  if ((effortKind === 'recorded') !== (effort !== null)) {
    throw new SessionDetailValidationError(`${label}.effort must be present exactly when it was recorded`);
  }
  const timingStatus = value.timingStatus;
  if (timingStatus !== 'recorded' && timingStatus !== 'unavailable') {
    throw new SessionDetailValidationError(`${label}.timingStatus is invalid`);
  }
  const durationMs = requireNullableNonNegativeNumber(value.durationMs, `${label}.durationMs`);
  if (timingStatus === 'recorded' && (durationMs === null || value.intervals.length === 0)) {
    throw new SessionDetailValidationError(`${label} recorded timing requires a duration and interval`);
  }
  if (timingStatus === 'unavailable' && (durationMs !== null || value.intervals.length !== 0)) {
    throw new SessionDetailValidationError(`${label} unavailable timing cannot contain a duration or interval`);
  }
  return {
    calls: value.calls === null ? null : requireNonNegativeInteger(value.calls, `${label}.calls`),
    cost,
    costKind,
    durationMs,
    effort,
    effortKind,
    endAt: requireTimestamp(value.endAt, `${label}.endAt`),
    index: requireNonNegativeInteger(value.index, `${label}.index`),
    intervals: value.intervals.map((interval, intervalIndex) => parseInterval(interval, intervalIndex, index)),
    model: requireString(value.model, `${label}.model`),
    promptIds: parseStringArray(value.promptIds, `${label}.promptIds`, MAX_PROMPTS),
    startAt: requireTimestamp(value.startAt, `${label}.startAt`),
    timingStatus,
    tokens: parseTokenCounts(value.tokens, `${label}.tokens`),
    tools: requireNonNegativeInteger(value.tools, `${label}.tools`),
  };
};

const intervalUnionDuration = (intervals: readonly SessionDetailInterval[]): number => {
  const ordered = intervals
    .map(({ endAt, startAt }) => ({ end: Date.parse(endAt), start: Date.parse(startAt) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const first = ordered[0];
  if (!first) {
    return 0;
  }
  let duration = 0;
  let currentStart = first.start;
  let currentEnd = first.end;
  for (const interval of ordered.slice(1)) {
    if (interval.start > currentEnd) {
      duration += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    } else {
      currentEnd = Math.max(currentEnd, interval.end);
    }
  }
  return duration + currentEnd - currentStart;
};

const assertContainedInterval = (
  startAt: string,
  endAt: string,
  sessionStartMs: number,
  sessionEndMs: number,
  label: string,
): void => {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (endMs < startMs) {
    throw new SessionDetailValidationError(`${label} ends before it starts`);
  }
  if (startMs < sessionStartMs || endMs > sessionEndMs) {
    throw new SessionDetailValidationError(`${label} falls outside its enclosing interval`);
  }
};

export const parseSessionDetailRequest = (value: unknown): SessionDetailRequest => {
  if (!isRecord(value)) {
    throw new SessionDetailValidationError('Session detail request must be an object');
  }
  assertExactKeys(value, ['revision', 'rowId'], 'Session detail request');
  return {
    revision: parseServedRevision(value.revision, 'Session detail request.revision'),
    rowId: requireString(value.rowId, 'Session detail request.rowId', MAX_ID_LENGTH),
  };
};

const fnv1a64 = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    // biome-ignore lint/suspicious/noBitwiseOperators: The XOR step is intrinsic to FNV-1a.
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

export const sessionDetailRequestFingerprint = (input: SessionDetailRequest): string => {
  const request = parseSessionDetailRequest(input);
  return `session-detail-v2:${fnv1a64(request.rowId)}`;
};

export const parseSessionDetailAnchorResult = (
  value: unknown,
  input: SessionDetailRequest,
): SessionDetailAnchorResult => {
  const request = parseSessionDetailRequest(input);
  if (!isRecord(value)) {
    throw new SessionDetailValidationError('Session detail anchor result must be an object');
  }
  assertExactKeys(value, ['anchor', 'requestFingerprint', 'revision'], 'Session detail anchor result');
  const revision = requireString(value.revision, 'Session detail anchor result.revision', MAX_ID_LENGTH);
  const requestFingerprint = requireString(
    value.requestFingerprint,
    'Session detail anchor result.requestFingerprint',
    MAX_ID_LENGTH,
  );
  if (revision !== request.revision || requestFingerprint !== sessionDetailRequestFingerprint(request)) {
    throw new SessionDetailValidationError('Session detail anchor result does not match its request');
  }
  if (value.anchor === null) {
    return { anchor: null, requestFingerprint, revision };
  }
  if (!isRecord(value.anchor)) {
    throw new SessionDetailValidationError('Session detail anchor result.anchor must be an object or null');
  }
  const anchor = value.anchor;
  assertExactKeys(
    anchor,
    ['harnessKey', 'machineId', 'projection', 'sourceAuthority', 'sourceSessionId', 'vcs'],
    'Session detail anchor result.anchor',
  );
  const sourceAuthority = sessionDetailSourceAuthorities.find((authority) => authority === anchor.sourceAuthority);
  if (!sourceAuthority) {
    throw new SessionDetailValidationError('Session detail anchor result.anchor.sourceAuthority is invalid');
  }
  return {
    anchor: {
      harnessKey: requireNullableString(anchor.harnessKey, 'Session detail anchor result.anchor.harnessKey'),
      machineId: requireNullableString(
        anchor.machineId,
        'Session detail anchor result.anchor.machineId',
        MAX_ID_LENGTH,
      ),
      projection: parseProjectionFacts(anchor.projection, 'Session detail anchor result.anchor.projection'),
      sourceAuthority,
      sourceSessionId: requireNullableString(
        anchor.sourceSessionId,
        'Session detail anchor result.anchor.sourceSessionId',
        MAX_ID_LENGTH,
      ),
      vcs: anchor.vcs === null ? null : parseSessionVcsContext(anchor.vcs),
    },
    requestFingerprint,
    revision,
  };
};

const tokenCountsEqual = (left: SessionDetailTokenCounts, right: SessionDetailTokenCounts): boolean =>
  left.cacheRead === right.cacheRead &&
  left.cacheWrite === right.cacheWrite &&
  left.input === right.input &&
  left.output === right.output &&
  left.total === right.total;

const modelSegmentsEqual = (left: SessionProjectionModelFacts[], right: SessionProjectionModelFacts[]): boolean =>
  left.length === right.length &&
  left.every((segment, index) => {
    const other = right[index];
    return other !== undefined && segment.model === other.model && tokenCountsEqual(segment.tokens, other.tokens);
  });

export const compareSessionProjectionFacts = (
  report: SessionProjectionFacts,
  local: SessionProjectionFacts,
): SessionDetailConsistency => {
  const checkedFields: SessionDetailComparableField[] = [];
  const differingFields: SessionDetailComparableField[] = [];
  const check = (field: SessionDetailComparableField, equal: boolean): void => {
    checkedFields.push(field);
    if (!equal) {
      differingFields.push(field);
    }
  };
  if (report.tokens !== null && local.tokens !== null) {
    check('calls', report.calls === local.calls);
  }
  if (report.durationMs !== null || local.durationMs !== null) {
    check('duration', report.durationMs === local.durationMs);
  }
  if (report.modelSegments !== null && local.modelSegments !== null) {
    check('model-attribution', modelSegmentsEqual(report.modelSegments, local.modelSegments));
  }
  check('coverage', report.partial === local.partial && (report.tokens !== null) === (local.tokens !== null));
  if (report.tokens !== null && local.tokens !== null) {
    check('tokens', tokenCountsEqual(report.tokens, local.tokens));
    check('tools', report.tools === local.tools);
  }
  check('turns', report.turns === local.turns);
  if (differingFields.length > 0) {
    return { checkedFields, differingFields, status: 'differs-from-report' };
  }
  if (checkedFields.includes('tokens')) {
    return { checkedFields, status: 'matches-report' };
  }
  return { checkedFields, reason: 'insufficient-comparable-facts', status: 'cannot-compare' };
};

const parseChildLink = (value: unknown, index: number): SessionDetailChildLink => {
  const label = `session detail.children[${index}]`;
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(value, ['agentType', 'evidence', 'label', 'sourceSessionId', 'spawnTurnIndex'], label);
  const evidence = sessionDetailChildEvidences.find((candidate) => candidate === value.evidence);
  if (!evidence) {
    throw new SessionDetailValidationError(`${label}.evidence is invalid`);
  }
  return {
    agentType: requireNullableString(value.agentType, `${label}.agentType`),
    evidence,
    label: requireNullableString(value.label, `${label}.label`),
    sourceSessionId: requireString(value.sourceSessionId, `${label}.sourceSessionId`, MAX_ID_LENGTH),
    spawnTurnIndex:
      value.spawnTurnIndex === null ? null : requireNonNegativeInteger(value.spawnTurnIndex, `${label}.spawnTurnIndex`),
  };
};

const parseInteraction = (value: unknown, index: number): SessionDetailInteraction => {
  const label = `session detail.interactions[${index}]`;
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(value, ['at', 'childSourceSessionId', 'kind', 'label', 'toolUseId', 'turnIndex'], label);
  if (value.kind !== 'message' && value.kind !== 'spawn') {
    throw new SessionDetailValidationError(`${label}.kind is invalid`);
  }
  return {
    at: requireTimestamp(value.at, `${label}.at`),
    childSourceSessionId: requireNullableString(
      value.childSourceSessionId,
      `${label}.childSourceSessionId`,
      MAX_ID_LENGTH,
    ),
    kind: value.kind,
    label: requireNullableString(value.label, `${label}.label`),
    toolUseId: requireString(value.toolUseId, `${label}.toolUseId`, MAX_ID_LENGTH),
    turnIndex: value.turnIndex === null ? null : requireNonNegativeInteger(value.turnIndex, `${label}.turnIndex`),
  };
};

const parseCoverageFact = (value: unknown, label: string): SessionDetailCoverageFact => {
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(value, ['omittedCount', 'reasons', 'status'], label);
  if (value.status !== 'complete' && value.status !== 'partial' && value.status !== 'unavailable') {
    throw new SessionDetailValidationError(`${label}.status is invalid`);
  }
  if (!(Array.isArray(value.reasons) && value.reasons.length <= MAX_COVERAGE_REASONS)) {
    throw new SessionDetailValidationError(`${label}.reasons must be a bounded array`);
  }
  const reasons = value.reasons.map((reason, reasonIndex) => {
    const known = sessionDetailCoverageReasons.find((candidate) => candidate === reason);
    if (!known) {
      throw new SessionDetailValidationError(`${label}.reasons[${reasonIndex}] is invalid`);
    }
    return known;
  });
  if (new Set(reasons).size !== reasons.length) {
    throw new SessionDetailValidationError(`${label}.reasons must be unique`);
  }
  const omittedCount =
    value.omittedCount === null ? null : requireNonNegativeInteger(value.omittedCount, `${label}.omittedCount`);
  if (value.status === 'complete' && (reasons.length > 0 || omittedCount !== 0)) {
    throw new SessionDetailValidationError(`${label} complete coverage cannot carry reasons or omissions`);
  }
  if (value.status !== 'complete' && reasons.length === 0) {
    throw new SessionDetailValidationError(`${label} incomplete coverage must name a reason`);
  }
  return { omittedCount, reasons, status: value.status };
};

const parseCoverage = (value: unknown): SessionDetailCoverage => {
  const label = 'session detail.coverage';
  if (!isRecord(value)) {
    throw new SessionDetailValidationError(`${label} must be an object`);
  }
  assertExactKeys(value, sessionDetailCoverageKeys, label);
  return {
    childDiscovery: parseCoverageFact(value.childDiscovery, `${label}.childDiscovery`),
    grouping: parseCoverageFact(value.grouping, `${label}.grouping`),
    interactionAttribution: parseCoverageFact(value.interactionAttribution, `${label}.interactionAttribution`),
    promptBodies: parseCoverageFact(value.promptBodies, `${label}.promptBodies`),
    recordedTiming: parseCoverageFact(value.recordedTiming, `${label}.recordedTiming`),
  };
};

export const parseSessionDetail = (value: unknown): SessionDetail => {
  if (!isRecord(value)) {
    throw new SessionDetailValidationError('Session detail must be an object');
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RESULT_BYTES) {
    throw new SessionDetailValidationError('Session detail exceeds its result budget');
  }
  assertExactKeys(
    value,
    [
      'activeDurationMs',
      'children',
      'coverage',
      'durationStatus',
      'efforts',
      'elapsedDurationMs',
      'endedAt',
      'idleDurationMs',
      'interactions',
      'models',
      'observedAt',
      'phases',
      'prompts',
      'promptsTruncated',
      'sourceSessionId',
      'startedAt',
      'turns',
      'turnsStatus',
    ],
    'Session detail',
  );
  if (!(Array.isArray(value.children) && value.children.length <= MAX_CHILDREN)) {
    throw new SessionDetailValidationError('Session detail.children exceeds its item budget');
  }
  if (!(Array.isArray(value.interactions) && value.interactions.length <= MAX_INTERACTIONS)) {
    throw new SessionDetailValidationError('Session detail.interactions exceeds its item budget');
  }
  if (!(Array.isArray(value.phases) && value.phases.length <= MAX_PHASES)) {
    throw new SessionDetailValidationError('Session detail.phases exceeds its item budget');
  }
  if (!(Array.isArray(value.prompts) && value.prompts.length <= MAX_PROMPTS)) {
    throw new SessionDetailValidationError('Session detail.prompts exceeds its item budget');
  }
  if (!(Array.isArray(value.turns) && value.turns.length <= MAX_TURNS)) {
    throw new SessionDetailValidationError('Session detail.turns exceeds its item budget');
  }
  if (typeof value.promptsTruncated !== 'boolean') {
    throw new SessionDetailValidationError('Session detail.promptsTruncated must be a boolean');
  }
  const detail: SessionDetail = {
    activeDurationMs: requireNullableNonNegativeNumber(value.activeDurationMs, 'Session detail.activeDurationMs'),
    children: value.children.map(parseChildLink),
    coverage: parseCoverage(value.coverage),
    durationStatus: parseTimingStatus(value.durationStatus, 'Session detail.durationStatus'),
    efforts: parseStringArray(value.efforts, 'Session detail.efforts', MAX_PHASES),
    elapsedDurationMs: requireNonNegativeNumber(value.elapsedDurationMs, 'Session detail.elapsedDurationMs'),
    endedAt: requireTimestamp(value.endedAt, 'Session detail.endedAt'),
    idleDurationMs: requireNullableNonNegativeNumber(value.idleDurationMs, 'Session detail.idleDurationMs'),
    interactions: value.interactions.map(parseInteraction),
    models: parseStringArray(value.models, 'Session detail.models', MAX_PHASES),
    observedAt: requireTimestamp(value.observedAt, 'Session detail.observedAt'),
    phases: value.phases.map(parsePhase),
    prompts: value.prompts.map(parsePrompt),
    promptsTruncated: value.promptsTruncated,
    sourceSessionId: requireString(value.sourceSessionId, 'Session detail.sourceSessionId', MAX_ID_LENGTH),
    startedAt: requireTimestamp(value.startedAt, 'Session detail.startedAt'),
    turns: value.turns.map(parseTurn),
    turnsStatus: parseCoverageStatus(value.turnsStatus, 'Session detail.turnsStatus'),
  };
  const sessionStartMs = Date.parse(detail.startedAt);
  const sessionEndMs = Date.parse(detail.endedAt);
  if (sessionEndMs < sessionStartMs) {
    throw new SessionDetailValidationError('Session detail ends before it starts');
  }
  if (detail.elapsedDurationMs !== sessionEndMs - sessionStartMs) {
    throw new SessionDetailValidationError('Session detail elapsed duration does not match its timestamps');
  }
  const promptIds = new Set(detail.prompts.map(({ id }) => id));
  if (promptIds.size !== detail.prompts.length) {
    throw new SessionDetailValidationError('Session detail.prompts must have unique identities');
  }
  const turnIndexes = new Set<number>();
  const ownedPrompts = new Set<string>();
  for (const [index, turn] of detail.turns.entries()) {
    if (turnIndexes.has(turn.index)) {
      throw new SessionDetailValidationError(`Session detail.turns[${index}] repeats a turn index`);
    }
    turnIndexes.add(turn.index);
    for (const promptId of turn.promptIds) {
      if (!promptIds.has(promptId)) {
        throw new SessionDetailValidationError(`Session detail.turns[${index}] references an unknown prompt`);
      }
      // A prompt opens exactly one round; a second owner would derive two rounds with one identity.
      if (ownedPrompts.has(promptId)) {
        throw new SessionDetailValidationError(`Session detail.turns[${index}] re-owns prompt ${promptId}`);
      }
      ownedPrompts.add(promptId);
    }
  }
  const childIds = new Set<string>();
  for (const [index, child] of detail.children.entries()) {
    if (childIds.has(child.sourceSessionId)) {
      throw new SessionDetailValidationError(`Session detail.children[${index}] repeats a child session`);
    }
    childIds.add(child.sourceSessionId);
    if (child.spawnTurnIndex !== null && !turnIndexes.has(child.spawnTurnIndex)) {
      throw new SessionDetailValidationError(`Session detail.children[${index}] names an unknown spawning turn`);
    }
  }
  for (const [index, interaction] of detail.interactions.entries()) {
    const atMs = Date.parse(interaction.at);
    if (atMs < sessionStartMs || atMs > sessionEndMs) {
      throw new SessionDetailValidationError(`Session detail.interactions[${index}] falls outside the session`);
    }
    if (interaction.turnIndex !== null && !turnIndexes.has(interaction.turnIndex)) {
      throw new SessionDetailValidationError(`Session detail.interactions[${index}] names an unknown turn`);
    }
    if (interaction.childSourceSessionId !== null && !childIds.has(interaction.childSourceSessionId)) {
      throw new SessionDetailValidationError(`Session detail.interactions[${index}] names an unlisted child`);
    }
  }
  for (const [index, phase] of detail.phases.entries()) {
    assertContainedInterval(
      phase.startAt,
      phase.endAt,
      sessionStartMs,
      sessionEndMs,
      `Session detail.phases[${index}]`,
    );
  }
  for (const [index, turn] of detail.turns.entries()) {
    assertContainedInterval(turn.startAt, turn.endAt, sessionStartMs, sessionEndMs, `Session detail.turns[${index}]`);
    const turnStartMs = Date.parse(turn.startAt);
    const turnEndMs = Date.parse(turn.endAt);
    for (const [intervalIndex, interval] of turn.intervals.entries()) {
      assertContainedInterval(
        interval.startAt,
        interval.endAt,
        turnStartMs,
        turnEndMs,
        `Session detail.turns[${index}].intervals[${intervalIndex}]`,
      );
    }
    if (turn.timingStatus === 'recorded' && intervalUnionDuration(turn.intervals) !== turn.durationMs) {
      throw new SessionDetailValidationError(`Session detail.turns[${index}] duration does not match its intervals`);
    }
  }
  const recordedTurns = detail.turns.filter((turn) => turn.timingStatus === 'recorded');
  const unavailableTurns = detail.turns.filter((turn) => turn.timingStatus === 'unavailable');
  if (detail.durationStatus === 'unavailable') {
    if (detail.activeDurationMs !== null || detail.idleDurationMs !== null || recordedTurns.length > 0) {
      throw new SessionDetailValidationError('Session detail unavailable timing must not claim active or idle time');
    }
  } else {
    if (detail.activeDurationMs === null || detail.idleDurationMs === null) {
      throw new SessionDetailValidationError('Session detail recorded or partial timing requires active and idle time');
    }
    if (
      detail.activeDurationMs > detail.elapsedDurationMs ||
      detail.idleDurationMs > detail.elapsedDurationMs ||
      detail.activeDurationMs + detail.idleDurationMs !== detail.elapsedDurationMs
    ) {
      throw new SessionDetailValidationError('Session detail active and idle durations do not match elapsed duration');
    }
    const recordedActiveDuration = intervalUnionDuration(recordedTurns.flatMap((turn) => turn.intervals));
    if (recordedActiveDuration !== detail.activeDurationMs) {
      throw new SessionDetailValidationError('Session detail active duration does not match its recorded intervals');
    }
    if (detail.durationStatus === 'recorded' && unavailableTurns.length > 0) {
      throw new SessionDetailValidationError('Session detail recorded timing requires every turn to be recorded');
    }
    if (detail.durationStatus === 'partial' && (recordedTurns.length === 0 || detail.idleDurationMs === 0)) {
      throw new SessionDetailValidationError(
        'Session detail partial timing requires recorded activity and an outside bound',
      );
    }
  }
  return detail;
};

export const parseSessionDetailResponse = (value: unknown): SessionDetailResponse => {
  if (!isRecord(value)) {
    throw new SessionDetailValidationError('Session detail response must be an object');
  }
  if (value.status === 'available') {
    assertExactKeys(value, ['consistency', 'detail', 'revision', 'status'], 'Session detail response');
    if (!isRecord(value.consistency)) {
      throw new SessionDetailValidationError('Session detail response.consistency must be an object');
    }
    const consistency = parseSessionDetailConsistency(value.consistency);
    return {
      consistency,
      detail: parseSessionDetail(value.detail),
      revision: parseServedRevision(value.revision, 'Session detail response.revision'),
      status: 'available',
    };
  }
  if (value.status === 'unavailable') {
    assertExactKeys(value, ['message', 'reason', 'status'], 'Session detail response');
    if (
      value.reason !== 'history-unavailable' &&
      value.reason !== 'not-found' &&
      value.reason !== 'not-local' &&
      value.reason !== 'report-provenance-unavailable' &&
      value.reason !== 'report-row-not-found' &&
      value.reason !== 'revision-expired' &&
      value.reason !== 'unsupported'
    ) {
      throw new SessionDetailValidationError('Session detail response.reason is invalid');
    }
    return {
      message: requireString(value.message, 'Session detail response.message', 1024),
      reason: value.reason,
      status: 'unavailable',
    };
  }
  throw new SessionDetailValidationError('Session detail response.status is invalid');
};

const parseComparableFields = (value: unknown, label: string): SessionDetailComparableField[] => {
  const fields: SessionDetailComparableField[] = [
    'calls',
    'duration',
    'model-attribution',
    'coverage',
    'tokens',
    'tools',
    'turns',
  ];
  if (!Array.isArray(value)) {
    throw new SessionDetailValidationError(`${label} must be an array`);
  }
  const parsed = value.map((field) => {
    if (typeof field !== 'string' || !fields.includes(field as SessionDetailComparableField)) {
      throw new SessionDetailValidationError(`${label} contains an invalid field`);
    }
    return field as SessionDetailComparableField;
  });
  const expected = fields.filter((field) => parsed.includes(field));
  if (new Set(parsed).size !== parsed.length || !parsed.every((field, index) => field === expected[index])) {
    throw new SessionDetailValidationError(`${label} must use deterministic field order without duplicates`);
  }
  return parsed;
};

const parseSessionDetailConsistency = (value: Record<string, unknown>): SessionDetailConsistency => {
  const checkedFields = parseComparableFields(value.checkedFields, 'Session detail consistency.checkedFields');
  if (value.status === 'matches-report') {
    assertExactKeys(value, ['checkedFields', 'status'], 'Session detail consistency');
    return { checkedFields, status: 'matches-report' };
  }
  if (value.status === 'differs-from-report') {
    assertExactKeys(value, ['checkedFields', 'differingFields', 'status'], 'Session detail consistency');
    const differingFields = parseComparableFields(value.differingFields, 'Session detail consistency.differingFields');
    if (differingFields.some((field) => !checkedFields.includes(field)) || differingFields.length === 0) {
      throw new SessionDetailValidationError('Session detail consistency has invalid differing fields');
    }
    return { checkedFields, differingFields, status: 'differs-from-report' };
  }
  if (value.status === 'cannot-compare') {
    assertExactKeys(value, ['checkedFields', 'reason', 'status'], 'Session detail consistency');
    if (value.reason !== 'insufficient-comparable-facts') {
      throw new SessionDetailValidationError('Session detail consistency.reason is invalid');
    }
    return { checkedFields, reason: value.reason, status: 'cannot-compare' };
  }
  throw new SessionDetailValidationError('Session detail consistency.status is invalid');
};
