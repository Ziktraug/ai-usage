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
  source: UsageRowSource & {
    machineId: string;
    machineLabel: string;
  };
  sourceFingerprint: string;
  rowKey: StableUsageRowKey;
  contentHash: UsageRowContentHash;
  status: UsageRowStatus;
}

export interface UsageMergeBundle {
  version: typeof USAGE_MERGE_BUNDLE_VERSION;
  machine: UsageMachine;
  generatedAt: string;
  rows: SerializedMergeRow[];
  warnings: UsageReportWarning[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (!isRecord(value)) return null;
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
  sourcePath: source.sourcePath ?? null,
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
  sourcePath: source.sourcePath ?? null,
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
    ...(source?.sourcePath === undefined ? {} : { sourcePath: source.sourcePath }),
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
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0 && typeof value.label === 'string';
};

const isMergeRowSource = (value: unknown): value is SerializedMergeRow['source'] => {
  if (!isRecord(value)) return false;
  return (
    typeof value.harnessKey === 'string' &&
    value.harnessKey.length > 0 &&
    (value.sourceSessionId === null || typeof value.sourceSessionId === 'string') &&
    (value.sourcePath === undefined || value.sourcePath === null || typeof value.sourcePath === 'string') &&
    typeof value.machineId === 'string' &&
    value.machineId.length > 0 &&
    typeof value.machineLabel === 'string'
  );
};

const isUsageReportWarnings = (value: unknown): value is UsageReportWarning[] =>
  Array.isArray(value) &&
  value.every(
    (warning) =>
      isRecord(warning) &&
      typeof warning.message === 'string' &&
      (warning.harness === undefined || typeof warning.harness === 'string') &&
      (warning.operation === undefined || typeof warning.operation === 'string') &&
      (warning.path === undefined || typeof warning.path === 'string') &&
      (warning.sql === undefined || typeof warning.sql === 'string'),
  );

export const isSerializedMergeRow = (value: unknown): value is SerializedMergeRow => {
  if (!isRecord(value)) return false;
  return (
    typeof value.harness === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.name === 'string' &&
    typeof value.model === 'string' &&
    typeof value.rowKey === 'string' &&
    value.rowKey.length > 0 &&
    typeof value.sourceFingerprint === 'string' &&
    typeof value.contentHash === 'string' &&
    (value.status === 'active' || value.status === 'superseded' || value.status === 'deleted') &&
    isMergeRowSource(value.source)
  );
};

export const parseSerializedMergeRow = (value: unknown): SerializedMergeRow => {
  if (!isSerializedMergeRow(value)) throw new Error('Usage merge bundle contains an invalid row');
  return value;
};

export const parseUsageMergeBundle = (text: string): UsageMergeBundle => {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) throw new Error('Usage merge bundle must be an object');
  if (value.version !== USAGE_MERGE_BUNDLE_VERSION) throw new Error('Unsupported usage merge bundle version');
  if (!isMachine(value.machine)) throw new Error('Usage merge bundle missing machine');
  if (typeof value.generatedAt !== 'string') throw new Error('Usage merge bundle missing generatedAt');
  if (!Array.isArray(value.rows) || !value.rows.every(isSerializedMergeRow)) {
    throw new Error('Usage merge bundle contains invalid rows');
  }
  if (!isUsageReportWarnings(value.warnings)) throw new Error('Usage merge bundle contains invalid warnings');
  return {
    version: value.version,
    machine: value.machine,
    generatedAt: value.generatedAt,
    rows: value.rows,
    warnings: value.warnings,
  };
};

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
