import { createHash } from 'node:crypto';
import { assertPortableUsageByteLength, assertPortableUsageRowCount, MAX_PORTABLE_USAGE_BYTES } from './portable-usage';
import { type SerializedUsageRow, serializeUsageRow, type UsageReportWarning } from './report-data';
import {
  hasOnlyKeys,
  isRecord,
  isSerializedUsageRowWithSource,
  isStrictIsoTimestamp,
  isUsageMachine,
  isUsageReportWarnings,
  SERIALIZED_USAGE_ROW_KEYS,
} from './serialized-usage-validation';
import type { UsageMachine } from './snapshot';
import type { CollectedUsageRow, UsageRowSource, UsageRowWithOptionalSource } from './types';

const LEGACY_USAGE_MERGE_BUNDLE_VERSION = 1 as const;
const LEGACY_USAGE_MERGE_BUNDLE_VERSION_V2 = 2 as const;
export const USAGE_MERGE_BUNDLE_VERSION = 3 as const;

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

const SHA_256_HEX = /^[0-9a-f]{64}$/;

const MERGE_ROW_KEYS = new Set([...SERIALIZED_USAGE_ROW_KEYS, 'contentHash', 'rowKey', 'sourceFingerprint', 'status']);
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
  vcs: source.vcs ?? null,
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
    ...(source?.vcs === undefined ? {} : { vcs: source.vcs }),
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
}): UsageMergeBundle => {
  assertPortableUsageRowCount(input.rows, 'Usage merge bundle');
  return {
    version: USAGE_MERGE_BUNDLE_VERSION,
    machine: input.machine,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    rows: input.rows.map((row) => toSerializedMergeRow(row, input.machine)),
    warnings: input.warnings ?? [],
  };
};

export const isSerializedMergeRow = (value: unknown): value is SerializedMergeRow => {
  if (!isSerializedUsageRowWithSource(value, MERGE_ROW_KEYS)) {
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
  if (
    value.version !== LEGACY_USAGE_MERGE_BUNDLE_VERSION &&
    value.version !== LEGACY_USAGE_MERGE_BUNDLE_VERSION_V2 &&
    value.version !== USAGE_MERGE_BUNDLE_VERSION
  ) {
    throw new Error('Unsupported usage merge bundle version');
  }
  if (!isUsageMachine(value.machine)) {
    throw new Error('Usage merge bundle missing machine');
  }
  if (!isStrictIsoTimestamp(value.generatedAt)) {
    throw new Error('Usage merge bundle contains an invalid generatedAt');
  }
  if (!Array.isArray(value.rows)) {
    throw new Error('Usage merge bundle contains invalid rows');
  }
  assertPortableUsageRowCount(value.rows, 'Usage merge bundle');
  if (!value.rows.every(isSerializedMergeRow)) {
    throw new Error('Usage merge bundle contains invalid rows');
  }
  if (
    value.version === LEGACY_USAGE_MERGE_BUNDLE_VERSION &&
    value.rows.some((row) => row.modelSegments !== undefined)
  ) {
    throw new Error('Usage merge bundle legacy v1 rows cannot contain modelSegments');
  }
  if (
    (value.version === LEGACY_USAGE_MERGE_BUNDLE_VERSION || value.version === LEGACY_USAGE_MERGE_BUNDLE_VERSION_V2) &&
    value.rows.some((row) => row.source.vcs !== undefined)
  ) {
    throw new Error(`Usage merge bundle legacy v${value.version} rows cannot contain source.vcs`);
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
    version: USAGE_MERGE_BUNDLE_VERSION,
    machine: value.machine,
    generatedAt: value.generatedAt,
    rows: value.rows,
    warnings: value.warnings,
  };
};

export const parseUsageMergeBundle = (text: string): UsageMergeBundle => {
  assertPortableUsageByteLength(text, 'Usage merge bundle');
  return parseUsageMergeBundleValue(JSON.parse(text) as unknown);
};

export const serializeUsageMergeBundle = (bundle: UsageMergeBundle, maxBytes = MAX_PORTABLE_USAGE_BYTES): string => {
  const validated = parseUsageMergeBundleValue(bundle);
  const text = `${JSON.stringify(validated, null, 2)}\n`;
  assertPortableUsageByteLength(text, 'Usage merge bundle', maxBytes);
  return text;
};

export const deserializeMergeRow = (row: SerializedMergeRow): CollectedUsageRow => ({
  date: row.date ? new Date(row.date) : null,
  endDate: row.endDate ? new Date(row.endDate) : null,
  harness: row.harness,
  provider: row.provider,
  name: row.name,
  model: row.model,
  ...(row.modelSegments === undefined ? {} : { modelSegments: row.modelSegments }),
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
  ...(row.titleSource === undefined ? {} : { titleSource: row.titleSource }),
  source: row.source,
});
