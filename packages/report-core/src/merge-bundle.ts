import { createHash } from 'node:crypto';
import { type SerializedUsageRow, serializeUsageRow, type UsageReportWarning } from './report-data';
import type { UsageMachine } from './snapshot';
import type { CollectedUsageRow, UsageRowSource, UsageRowWithOptionalSource } from './types';

export const USAGE_MERGE_BUNDLE_VERSION = 1 as const;

export type UsageRowStatus = 'active' | 'superseded' | 'deleted';
export type StableUsageRowKey = string;
export type UsageRowContentHash = string;

export interface MergeRowIdentity {
  rowKey: StableUsageRowKey;
  sourceFingerprint: string;
}

export interface SerializedMergeRow extends SerializedUsageRow {
  contentHash: UsageRowContentHash;
  rowKey: StableUsageRowKey;
  source: UsageRowSource & {
    machineId: string;
    machineLabel: string;
  };
  sourceFingerprint: string;
  status: UsageRowStatus;
}

export interface UsageMergeBundle {
  generatedAt: string;
  machine: UsageMachine;
  rows: SerializedMergeRow[];
  version: typeof USAGE_MERGE_BUNDLE_VERSION;
  warnings: UsageReportWarning[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>) =>
  Object.keys(value).every((key) => keys.has(key));

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isNonNegativeFiniteNumber = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;

const isNonNegativeSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

const isNullableNonNegativeFiniteNumber = (value: unknown): value is number | null =>
  value === null || isNonNegativeFiniteNumber(value);

const isNullableNonNegativeSafeInteger = (value: unknown): value is number | null =>
  value === null || isNonNegativeSafeInteger(value);

const isOptionalNonNegativeSafeInteger = (value: unknown) => value === undefined || isNonNegativeSafeInteger(value);

const isOptionalNullableNonNegativeFiniteNumber = (value: unknown) =>
  value === undefined || isNullableNonNegativeFiniteNumber(value);

const isOptionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean';

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const isNullableIsoTimestamp = (value: unknown): value is string | null => value === null || isIsoTimestamp(value);

const SHA_256_HEX = /^[0-9a-f]{64}$/;

const MACHINE_KEYS = new Set(['id', 'label']);
const MERGE_SOURCE_KEYS = new Set([
  'artifactPath',
  'harnessKey',
  'machineId',
  'machineLabel',
  'parentSourceSessionId',
  'rootSourceSessionId',
  'sourcePath',
  'sourceSessionId',
]);
const MERGE_ROW_KEYS = new Set([
  'activeDate',
  'ambiguous',
  'calls',
  'contentHash',
  'costActual',
  'costApprox',
  'costKnown',
  'costQuota',
  'date',
  'durationMs',
  'endDate',
  'freshTokens',
  'harness',
  'lineDelta',
  'linesAdded',
  'linesDeleted',
  'model',
  'models',
  'name',
  'partial',
  'project',
  'projectGroupId',
  'projectSourceId',
  'provider',
  'rawProject',
  'rowKey',
  'rtkCommandCount',
  'rtkInputTokens',
  'rtkOutputTokens',
  'rtkSavedTokens',
  'sessionLabel',
  'source',
  'sourceFingerprint',
  'status',
  'subagent',
  'titleSource',
  'tokCr',
  'tokCw',
  'tokIn',
  'tokOut',
  'tokenTotal',
  'tools',
  'turns',
  'usageUnavailable',
]);
const WARNING_KEYS = new Set([
  'groupId',
  'groupName',
  'harness',
  'message',
  'operation',
  'path',
  'reason',
  'selectors',
  'sql',
]);
const PROJECT_SOURCE_SELECTOR_KEYS = new Set(['gitRemote', 'machineId', 'project', 'sourcePath']);
const BUNDLE_KEYS = new Set(['generatedAt', 'machine', 'rows', 'version', 'warnings']);

const normalizeJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (!isRecord(value)) {
    return null;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, normalizeJsonValue(value[key])]),
  );
};

export const stableUsageJson = (value: unknown) => JSON.stringify(normalizeJsonValue(value));

export const usageContentHash = (value: unknown): UsageRowContentHash =>
  createHash('sha256').update(stableUsageJson(value)).digest('hex');

const identityParts = (row: SerializedUsageRow, source: SerializedMergeRow['source']) => ({
  activeDate: row.activeDate,
  date: row.date,
  endDate: row.endDate,
  harness: row.harness,
  model: row.model,
  models: row.models ?? [],
  name: row.name,
  project: row.project,
  provider: row.provider,
  sourcePath: source.sourcePath ?? source.artifactPath ?? null,
  tokenTotal: row.tokenTotal,
});

// Stable identity for rows without a `sourceSessionId` (e.g. Cursor CSV-reconciled daily rows).
// Excludes volatile fields (`tokenTotal`, `date`, `endDate`) that grow as a session/day accumulates,
// so the same logical row keeps the same `rowKey` across re-collection and is updated rather than
// duplicated. `identityParts`/`sourceFingerprint` stays content-based for provenance.
const stableIdentityParts = (row: SerializedUsageRow, source: SerializedMergeRow['source']) => ({
  activeDate: row.activeDate,
  harness: row.harness,
  model: row.model,
  models: row.models ?? [],
  name: row.name,
  project: row.project,
  provider: row.provider,
  sourcePath: source.sourcePath ?? source.artifactPath ?? null,
});

export const mergeRowIdentity = (row: SerializedUsageRow, source: SerializedMergeRow['source']): MergeRowIdentity => {
  const sourceFingerprint = usageContentHash(identityParts(row, source));
  const sourceId = source.sourceSessionId ?? usageContentHash(stableIdentityParts(row, source));
  return {
    sourceFingerprint,
    rowKey: ['v1', source.machineId, source.harnessKey, sourceId].join(':'),
  };
};

export const toSerializedMergeRow = (
  row: UsageRowWithOptionalSource,
  machine: UsageMachine,
  status: UsageRowStatus = 'active',
): SerializedMergeRow => {
  const serialized = serializeUsageRow(row);
  const source = serialized.source;
  const mergeSource = {
    harnessKey: source?.harnessKey ?? row.harness.toLowerCase(),
    sourceSessionId: source?.sourceSessionId ?? null,
    ...(source?.parentSourceSessionId === undefined ? {} : { parentSourceSessionId: source.parentSourceSessionId }),
    ...(source?.rootSourceSessionId === undefined ? {} : { rootSourceSessionId: source.rootSourceSessionId }),
    ...(source?.sourcePath === undefined ? {} : { sourcePath: source.sourcePath }),
    ...(source?.artifactPath === undefined ? {} : { artifactPath: source.artifactPath }),
    machineId: machine.id,
    machineLabel: machine.label,
  };
  const identity = mergeRowIdentity(serialized, mergeSource);
  return {
    ...serialized,
    source: mergeSource,
    ...identity,
    contentHash: usageContentHash({
      ...serialized,
      source: mergeSource,
      rowKey: identity.rowKey,
      sourceFingerprint: identity.sourceFingerprint,
      status,
    }),
    status,
  };
};

export const createUsageMergeBundle = (input: {
  machine: UsageMachine;
  rows: UsageRowWithOptionalSource[];
  generatedAt?: Date;
  warnings?: UsageReportWarning[];
}): UsageMergeBundle => ({
  version: USAGE_MERGE_BUNDLE_VERSION,
  machine: input.machine,
  generatedAt: (input.generatedAt ?? new Date()).toISOString(),
  rows: input.rows.map((row) => toSerializedMergeRow(row, input.machine)),
  warnings: input.warnings ?? [],
});

const isMachine = (value: unknown): value is UsageMachine => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, MACHINE_KEYS) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.label === 'string'
  );
};

const isMergeRowSource = (value: unknown): value is SerializedMergeRow['source'] => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, MERGE_SOURCE_KEYS) &&
    (value.artifactPath === undefined || value.artifactPath === null || typeof value.artifactPath === 'string') &&
    typeof value.harnessKey === 'string' &&
    value.harnessKey.length > 0 &&
    (value.sourceSessionId === null || typeof value.sourceSessionId === 'string') &&
    (value.parentSourceSessionId === undefined ||
      value.parentSourceSessionId === null ||
      typeof value.parentSourceSessionId === 'string') &&
    (value.rootSourceSessionId === undefined ||
      value.rootSourceSessionId === null ||
      typeof value.rootSourceSessionId === 'string') &&
    (value.sourcePath === undefined || value.sourcePath === null || typeof value.sourcePath === 'string') &&
    typeof value.machineId === 'string' &&
    value.machineId.length > 0 &&
    typeof value.machineLabel === 'string'
  );
};

const isProjectSourceSelector = (value: unknown) =>
  isRecord(value) &&
  hasOnlyKeys(value, PROJECT_SOURCE_SELECTOR_KEYS) &&
  ['gitRemote', 'machineId', 'project', 'sourcePath'].every(
    (key) => value[key] === undefined || (typeof value[key] === 'string' && value[key].length > 0),
  ) &&
  Object.keys(value).length > 0;

const PROJECT_GROUPING_WARNING_REASONS = new Set([
  'broad-selector',
  'legacy-alias',
  'partial-group',
  'unmatched-group',
]);

const isUsageReportWarnings = (value: unknown): value is UsageReportWarning[] =>
  Array.isArray(value) &&
  value.every(
    (warning) =>
      isRecord(warning) &&
      hasOnlyKeys(warning, WARNING_KEYS) &&
      typeof warning.message === 'string' &&
      isOptionalString(warning.groupId) &&
      isOptionalString(warning.groupName) &&
      isOptionalString(warning.harness) &&
      isOptionalString(warning.operation) &&
      isOptionalString(warning.path) &&
      (warning.reason === undefined ||
        (typeof warning.reason === 'string' && PROJECT_GROUPING_WARNING_REASONS.has(warning.reason))) &&
      (warning.selectors === undefined ||
        (Array.isArray(warning.selectors) && warning.selectors.every(isProjectSourceSelector))) &&
      isOptionalString(warning.sql),
  );

const isOptionalStringArray = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));

const isTitleSource = (value: unknown) =>
  value === undefined || value === 'ai' || value === 'first-prompt' || value === 'agent-role' || value === 'id';

const hasValidSerializedUsageFields = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & SerializedUsageRow & { source: SerializedMergeRow['source'] } =>
  isNullableIsoTimestamp(value.activeDate) &&
  isOptionalBoolean(value.ambiguous) &&
  isNonNegativeSafeInteger(value.calls) &&
  isNullableNonNegativeFiniteNumber(value.costActual) &&
  isNonNegativeFiniteNumber(value.costApprox) &&
  typeof value.costKnown === 'boolean' &&
  isOptionalNullableNonNegativeFiniteNumber(value.costQuota) &&
  isNullableIsoTimestamp(value.date) &&
  isNullableNonNegativeFiniteNumber(value.durationMs) &&
  isNullableIsoTimestamp(value.endDate) &&
  isNonNegativeSafeInteger(value.freshTokens) &&
  typeof value.harness === 'string' &&
  isNullableNonNegativeSafeInteger(value.lineDelta) &&
  isNullableNonNegativeSafeInteger(value.linesAdded) &&
  isNullableNonNegativeSafeInteger(value.linesDeleted) &&
  typeof value.model === 'string' &&
  isOptionalStringArray(value.models) &&
  typeof value.name === 'string' &&
  isOptionalBoolean(value.partial) &&
  typeof value.project === 'string' &&
  isOptionalString(value.projectGroupId) &&
  isOptionalString(value.projectSourceId) &&
  typeof value.provider === 'string' &&
  isOptionalString(value.rawProject) &&
  isOptionalNonNegativeSafeInteger(value.rtkCommandCount) &&
  isOptionalNonNegativeSafeInteger(value.rtkInputTokens) &&
  isOptionalNonNegativeSafeInteger(value.rtkOutputTokens) &&
  isOptionalNonNegativeSafeInteger(value.rtkSavedTokens) &&
  typeof value.sessionLabel === 'string' &&
  isOptionalBoolean(value.subagent) &&
  isTitleSource(value.titleSource) &&
  isNonNegativeSafeInteger(value.tokCr) &&
  isNonNegativeSafeInteger(value.tokCw) &&
  isNonNegativeSafeInteger(value.tokIn) &&
  isNonNegativeSafeInteger(value.tokOut) &&
  isNonNegativeSafeInteger(value.tokenTotal) &&
  isNonNegativeSafeInteger(value.tools) &&
  isNonNegativeSafeInteger(value.turns) &&
  isOptionalBoolean(value.usageUnavailable) &&
  isMergeRowSource(value.source);

const expectedSessionLabel = (value: Record<string, unknown>) =>
  `${String(value.name)}${value.partial === true ? ' ~' : ''}${value.subagent === true ? ' ↳' : ''}${
    value.ambiguous === true ? ' ?' : ''
  }${value.usageUnavailable === true ? ' (usage unavailable)' : ''}`;

const hasValidDerivedFields = (value: Record<string, unknown>) => {
  const expectedLineDelta =
    value.linesAdded === null && value.linesDeleted === null
      ? null
      : Number(value.linesAdded ?? 0) + Number(value.linesDeleted ?? 0);
  return (
    value.activeDate === (value.endDate ?? value.date) &&
    value.freshTokens === Number(value.tokIn) + Number(value.tokOut) + Number(value.tokCw) &&
    value.lineDelta === expectedLineDelta &&
    value.sessionLabel === expectedSessionLabel(value) &&
    value.tokenTotal === Number(value.tokIn) + Number(value.tokOut) + Number(value.tokCr) + Number(value.tokCw)
  );
};

export const isSerializedMergeRow = (value: unknown): value is SerializedMergeRow => {
  if (!isRecord(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, MERGE_ROW_KEYS)) {
    return false;
  }
  if (!(hasValidSerializedUsageFields(value) && hasValidDerivedFields(value))) {
    return false;
  }
  const hasValidMergeFields =
    typeof value.rowKey === 'string' &&
    typeof value.sourceFingerprint === 'string' &&
    SHA_256_HEX.test(value.sourceFingerprint) &&
    typeof value.contentHash === 'string' &&
    SHA_256_HEX.test(value.contentHash) &&
    (value.status === 'active' || value.status === 'superseded' || value.status === 'deleted');
  if (!hasValidMergeFields) {
    return false;
  }

  const identity = mergeRowIdentity(value, value.source);
  if (value.rowKey !== identity.rowKey || value.sourceFingerprint !== identity.sourceFingerprint) {
    return false;
  }
  const { contentHash, ...content } = value;
  return contentHash === usageContentHash(content);
};

export const parseSerializedMergeRow = (value: unknown): SerializedMergeRow => {
  if (!isSerializedMergeRow(value)) {
    throw new Error('Usage merge bundle contains an invalid row');
  }
  return value;
};

export const parseUsageMergeBundleValue = (value: unknown): UsageMergeBundle => {
  if (!isRecord(value)) {
    throw new Error('Usage merge bundle must be an object');
  }
  if (!hasOnlyKeys(value, BUNDLE_KEYS)) {
    throw new Error('Usage merge bundle contains unknown fields');
  }
  if (value.version !== USAGE_MERGE_BUNDLE_VERSION) {
    throw new Error('Unsupported usage merge bundle version');
  }
  if (!isMachine(value.machine)) {
    throw new Error('Usage merge bundle missing machine');
  }
  if (!isIsoTimestamp(value.generatedAt)) {
    throw new Error('Usage merge bundle contains an invalid generatedAt');
  }
  if (!(Array.isArray(value.rows) && value.rows.every(isSerializedMergeRow))) {
    throw new Error('Usage merge bundle contains invalid rows');
  }
  if (!isUsageReportWarnings(value.warnings)) {
    throw new Error('Usage merge bundle contains invalid warnings');
  }
  for (const row of value.rows) {
    if (row.source.machineId !== value.machine.id) {
      throw new Error('Usage merge bundle row machineId does not match bundle machine');
    }
    if (row.source.machineLabel !== value.machine.label) {
      throw new Error('Usage merge bundle row machineLabel does not match bundle machine');
    }
  }
  return {
    version: value.version,
    machine: value.machine,
    generatedAt: value.generatedAt,
    rows: value.rows,
    warnings: value.warnings,
  };
};

export const parseUsageMergeBundle = (text: string): UsageMergeBundle =>
  parseUsageMergeBundleValue(JSON.parse(text) as unknown);

export const deserializeMergeRow = (row: SerializedMergeRow): CollectedUsageRow => ({
  date: row.date ? new Date(row.date) : null,
  endDate: row.endDate ? new Date(row.endDate) : null,
  harness: row.harness,
  provider: row.provider,
  name: row.name,
  model: row.model,
  ...(row.models === undefined ? {} : { models: row.models }),
  project: row.project,
  tokIn: row.tokIn,
  tokOut: row.tokOut,
  tokCr: row.tokCr,
  tokCw: row.tokCw,
  costActual: row.costActual,
  ...(row.costQuota === undefined ? {} : { costQuota: row.costQuota }),
  costApprox: row.costApprox,
  costKnown: row.costKnown,
  calls: row.calls,
  durationMs: row.durationMs,
  turns: row.turns,
  tools: row.tools,
  linesAdded: row.linesAdded,
  linesDeleted: row.linesDeleted,
  ...(row.rtkSavedTokens === undefined ? {} : { rtkSavedTokens: row.rtkSavedTokens }),
  ...(row.rtkInputTokens === undefined ? {} : { rtkInputTokens: row.rtkInputTokens }),
  ...(row.rtkOutputTokens === undefined ? {} : { rtkOutputTokens: row.rtkOutputTokens }),
  ...(row.rtkCommandCount === undefined ? {} : { rtkCommandCount: row.rtkCommandCount }),
  ...(row.subagent === undefined ? {} : { subagent: row.subagent }),
  ...(row.partial === undefined ? {} : { partial: row.partial }),
  ...(row.usageUnavailable === undefined ? {} : { usageUnavailable: row.usageUnavailable }),
  ...(row.ambiguous === undefined ? {} : { ambiguous: row.ambiguous }),
  source: row.source,
});
