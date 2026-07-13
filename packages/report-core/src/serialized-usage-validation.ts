import type { SerializedUsageRow, UsageReportWarning } from './report-data';
import type { UsageRowSource } from './types';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SerializedUsageRowSource = UsageRowSource & {
  machineId: string;
  machineLabel: string;
};

export type SerializedUsageRowWithSource = SerializedUsageRow & {
  source: SerializedUsageRowSource;
};

export const SERIALIZED_USAGE_ROW_KEYS: ReadonlySet<string> = new Set([
  'activeDate',
  'ambiguous',
  'calls',
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
  'rtkCommandCount',
  'rtkInputTokens',
  'rtkOutputTokens',
  'rtkSavedTokens',
  'sessionLabel',
  'source',
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

const MACHINE_KEYS = new Set(['id', 'label']);
const SERIALIZED_SOURCE_KEYS = new Set([
  'artifactPath',
  'harnessKey',
  'machineId',
  'machineLabel',
  'parentSourceSessionId',
  'rootSourceSessionId',
  'sourcePath',
  'sourceSessionId',
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
const PROJECT_GROUPING_WARNING_REASONS = new Set([
  'broad-selector',
  'legacy-alias',
  'partial-group',
  'unmatched-group',
]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isNonNegativeFiniteNumber = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;

const isNonNegativeSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

const isNullableNonNegativeFiniteNumber = (value: unknown): value is number | null =>
  value === null || isNonNegativeFiniteNumber(value);

const isNullableNonNegativeSafeInteger = (value: unknown): value is number | null =>
  value === null || isNonNegativeSafeInteger(value);

const isOptionalNonNegativeSafeInteger = (value: unknown): boolean =>
  value === undefined || isNonNegativeSafeInteger(value);

const isOptionalNullableNonNegativeFiniteNumber = (value: unknown): boolean =>
  value === undefined || isNullableNonNegativeFiniteNumber(value);

const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean';

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

export const isStrictIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const isNullableIsoTimestamp = (value: unknown): value is string | null =>
  value === null || isStrictIsoTimestamp(value);

export const isUsageMachine = (value: unknown): value is { id: string; label: string } => {
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

export const isSerializedUsageRowSource = (value: unknown): value is SerializedUsageRowSource => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, SERIALIZED_SOURCE_KEYS) &&
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

const isProjectSourceSelector = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, PROJECT_SOURCE_SELECTOR_KEYS) &&
  ['gitRemote', 'machineId', 'project', 'sourcePath'].every(
    (key) => value[key] === undefined || (typeof value[key] === 'string' && value[key].length > 0),
  ) &&
  Object.keys(value).length > 0;

export const isUsageReportWarnings = (value: unknown): value is UsageReportWarning[] =>
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

const isOptionalStringArray = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));

const isTitleSource = (value: unknown): boolean =>
  value === undefined || value === 'ai' || value === 'first-prompt' || value === 'agent-role' || value === 'id';

const hasValidSerializedUsageFields = (
  value: Record<string, unknown>,
  requireSource: boolean,
): value is Record<string, unknown> & SerializedUsageRowWithSource =>
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
  (value.source === undefined ? !requireSource : isSerializedUsageRowSource(value.source));

const expectedSessionLabel = (value: Record<string, unknown>): string =>
  `${String(value.name)}${value.partial === true ? ' ~' : ''}${value.subagent === true ? ' ↳' : ''}${
    value.ambiguous === true ? ' ?' : ''
  }${value.usageUnavailable === true ? ' (usage unavailable)' : ''}`;

const hasValidDerivedFields = (value: Record<string, unknown>): boolean => {
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

export const isSerializedUsageRowWithSource = (
  value: unknown,
  allowedKeys: ReadonlySet<string> = SERIALIZED_USAGE_ROW_KEYS,
): value is Record<string, unknown> & SerializedUsageRowWithSource =>
  isRecord(value) &&
  hasOnlyKeys(value, allowedKeys) &&
  hasValidSerializedUsageFields(value, true) &&
  hasValidDerivedFields(value);

export const isSerializedUsageRowShape = (
  value: unknown,
  allowedKeys: ReadonlySet<string> = SERIALIZED_USAGE_ROW_KEYS,
): boolean => isRecord(value) && hasOnlyKeys(value, allowedKeys) && hasValidSerializedUsageFields(value, false);

export const isJsonSafeValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonSafeValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonSafeValue);
};

export const isJsonSafeObject = (value: unknown): value is Record<string, JsonValue> =>
  isRecord(value) && Object.values(value).every(isJsonSafeValue);
