import type { SerializedUsageRow } from './report-data';
import { isSerializedUsageRow } from './serialized-usage-validation';

const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;
const MAX_PHASES = 256;
const MAX_PROMPTS = 256;
const MAX_PROMPT_TEXT_LENGTH = 32 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TURNS = 1024;
const MAX_TURN_INTERVALS = 2048;

export const sessionDetailHarnessKeys = ['codex', 'opencode'] as const;
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

export interface SessionDetailReportAnchor {
  harnessKey: string | null;
  machineId: string | null;
  projection: SessionProjectionFacts;
  sourceSessionId: string | null;
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
  durationMs: number;
  effort: string | null;
  effortKind: SessionDetailEffortKind;
  endAt: string;
  index: number;
  intervals: SessionDetailInterval[];
  model: string;
  promptIds: string[];
  startAt: string;
  tokens: SessionDetailTokenCounts;
  tools: number;
}

export interface SessionDetail {
  activeDurationMs: number;
  durationStatus: SessionDetailCoverageStatus;
  efforts: string[];
  elapsedDurationMs: number;
  endedAt: string;
  idleDurationMs: number;
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
  return {
    id: requireString(value.id, `${label}.id`, MAX_ID_LENGTH),
    text: requireString(value.text, `${label}.text`, MAX_PROMPT_TEXT_LENGTH),
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
      'durationMs',
      'effort',
      'effortKind',
      'endAt',
      'index',
      'intervals',
      'model',
      'promptIds',
      'startAt',
      'tokens',
      'tools',
    ],
    label,
  );
  if (!(Array.isArray(value.intervals) && value.intervals.length > 0 && value.intervals.length <= MAX_TURN_INTERVALS)) {
    throw new SessionDetailValidationError(`${label}.intervals must be a non-empty bounded array`);
  }
  const effort = requireNullableString(value.effort, `${label}.effort`);
  const effortKind = parseEffortKind(value.effortKind, `${label}.effortKind`);
  if ((effortKind === 'recorded') !== (effort !== null)) {
    throw new SessionDetailValidationError(`${label}.effort must be present exactly when it was recorded`);
  }
  return {
    durationMs: requireNonNegativeNumber(value.durationMs, `${label}.durationMs`),
    effort,
    effortKind,
    endAt: requireTimestamp(value.endAt, `${label}.endAt`),
    index: requireNonNegativeInteger(value.index, `${label}.index`),
    intervals: value.intervals.map((interval, intervalIndex) => parseInterval(interval, intervalIndex, index)),
    model: requireString(value.model, `${label}.model`),
    promptIds: parseStringArray(value.promptIds, `${label}.promptIds`, MAX_PROMPTS),
    startAt: requireTimestamp(value.startAt, `${label}.startAt`),
    tokens: parseTokenCounts(value.tokens, `${label}.tokens`),
    tools: requireNonNegativeInteger(value.tools, `${label}.tools`),
  };
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
    revision: requireString(value.revision, 'Session detail request.revision', MAX_ID_LENGTH),
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
  assertExactKeys(
    value.anchor,
    ['harnessKey', 'machineId', 'projection', 'sourceSessionId'],
    'Session detail anchor result.anchor',
  );
  return {
    anchor: {
      harnessKey: requireNullableString(value.anchor.harnessKey, 'Session detail anchor result.anchor.harnessKey'),
      machineId: requireNullableString(
        value.anchor.machineId,
        'Session detail anchor result.anchor.machineId',
        MAX_ID_LENGTH,
      ),
      projection: parseProjectionFacts(value.anchor.projection, 'Session detail anchor result.anchor.projection'),
      sourceSessionId: requireNullableString(
        value.anchor.sourceSessionId,
        'Session detail anchor result.anchor.sourceSessionId',
        MAX_ID_LENGTH,
      ),
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
      'durationStatus',
      'efforts',
      'elapsedDurationMs',
      'endedAt',
      'idleDurationMs',
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
    activeDurationMs: requireNonNegativeNumber(value.activeDurationMs, 'Session detail.activeDurationMs'),
    durationStatus: parseCoverageStatus(value.durationStatus, 'Session detail.durationStatus'),
    efforts: parseStringArray(value.efforts, 'Session detail.efforts', MAX_PHASES),
    elapsedDurationMs: requireNonNegativeNumber(value.elapsedDurationMs, 'Session detail.elapsedDurationMs'),
    endedAt: requireTimestamp(value.endedAt, 'Session detail.endedAt'),
    idleDurationMs: requireNonNegativeNumber(value.idleDurationMs, 'Session detail.idleDurationMs'),
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
  if (detail.activeDurationMs > detail.elapsedDurationMs || detail.idleDurationMs > detail.elapsedDurationMs) {
    throw new SessionDetailValidationError('Session detail duration parts exceed elapsed duration');
  }
  const sessionStartMs = Date.parse(detail.startedAt);
  const sessionEndMs = Date.parse(detail.endedAt);
  if (sessionEndMs < sessionStartMs) {
    throw new SessionDetailValidationError('Session detail ends before it starts');
  }
  if (detail.elapsedDurationMs !== sessionEndMs - sessionStartMs) {
    throw new SessionDetailValidationError('Session detail elapsed duration does not match its timestamps');
  }
  if (detail.activeDurationMs + detail.idleDurationMs !== detail.elapsedDurationMs) {
    throw new SessionDetailValidationError('Session detail active and idle durations do not match elapsed duration');
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
      revision: requireString(value.revision, 'Session detail response.revision', MAX_ID_LENGTH),
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
