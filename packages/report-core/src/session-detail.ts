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
  harnessKey: string;
  machineId: string;
  sourceSessionId: string;
}

export interface SessionDetailTokenCounts {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  total: number;
}

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

export type SessionDetailUnavailableReason = 'history-unavailable' | 'not-found' | 'not-local' | 'unsupported';

export type SessionDetailResponse =
  | { detail: SessionDetail; status: 'available' }
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

const requireNullableString = (value: unknown, label: string): string | null =>
  value === null ? null : requireString(value, label);

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
  assertExactKeys(value, ['harnessKey', 'machineId', 'sourceSessionId'], 'Session detail request');
  return {
    harnessKey: requireString(value.harnessKey, 'Session detail request.harnessKey'),
    machineId: requireString(value.machineId, 'Session detail request.machineId', MAX_ID_LENGTH),
    sourceSessionId: requireString(value.sourceSessionId, 'Session detail request.sourceSessionId', MAX_ID_LENGTH),
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
    assertExactKeys(value, ['detail', 'status'], 'Session detail response');
    return { detail: parseSessionDetail(value.detail), status: 'available' };
  }
  if (value.status === 'unavailable') {
    assertExactKeys(value, ['message', 'reason', 'status'], 'Session detail response');
    if (
      value.reason !== 'history-unavailable' &&
      value.reason !== 'not-found' &&
      value.reason !== 'not-local' &&
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
