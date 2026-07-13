import os from 'node:os';
import { isCursorCommitAttributionRow, parseReportDatasets, type ReportDatasets } from './datasets';
import { assertPortableUsageByteLength, assertPortableUsageRowCount, MAX_PORTABLE_USAGE_BYTES } from './portable-usage';
import { mergeProviderStatusDatasets, type ProviderStatusDataset, parseProviderStatusDataset } from './provider-status';
import { type SerializedUsageRow, serializeUsageRow, type UsageReportWarning } from './report-data';
import {
  hasOnlyKeys,
  isJsonSafeObject,
  isRecord,
  isSerializedUsageRowWithSource,
  isStrictIsoTimestamp,
  isUsageMachine,
  isUsageReportWarnings,
} from './serialized-usage-validation';
import type { CollectedUsageRow, UsageRow, UsageRowSource, UsageRowWithOptionalSource } from './types';
import { usageRowActiveDate, usageRowTokenTotal } from './usage-row';

export const USAGE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
// Manual merge is measured and supported through 50,000 rows. Keeping the file
// format at that same boundary bounds validation work without truncating history.

const SNAPSHOT_KEYS = new Set([
  'datasets',
  'facets',
  'generatedAt',
  'machine',
  'rows',
  'schemaVersion',
  'snapshotId',
  'source',
  'warnings',
]);
const SNAPSHOT_SOURCE_KEYS = new Set(['appVersion', 'hostname', 'platform']);

export interface UsageMachine {
  id: string;
  label: string;
}

export interface UsageSnapshotSource {
  appVersion: string | null;
  hostname?: string;
  platform: 'macos' | 'linux' | 'windows';
}

export interface SnapshotUsageRow extends SerializedUsageRow {
  source: UsageRowSource & {
    machineId: string;
    machineLabel: string;
  };
}

export interface UsageSnapshot {
  datasets?: ReportDatasets;
  facets?: Record<string, unknown>;
  generatedAt: string;
  machine: UsageMachine;
  rows: SnapshotUsageRow[];
  schemaVersion: typeof USAGE_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  source: UsageSnapshotSource;
  warnings?: UsageReportWarning[];
}

export interface SnapshotMergeWarning extends UsageReportWarning {
  key?: string;
  message: string;
}

export interface SnapshotMergeResult {
  datasets?: ReportDatasets;
  duplicatesDropped: number;
  rows: CollectedUsageRow[];
  warnings: SnapshotMergeWarning[];
}

export const snapshotPlatform = (): UsageSnapshotSource['platform'] => {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
};

export const createUsageSnapshot = (input: {
  machine: UsageMachine;
  rows: UsageRowWithOptionalSource[];
  generatedAt?: Date;
  appVersion?: string | null;
  warnings?: UsageReportWarning[];
  facets?: Record<string, unknown>;
  datasets?: ReportDatasets;
}): UsageSnapshot => {
  assertPortableUsageRowCount(input.rows, 'Snapshot');
  const generatedAt = input.generatedAt ?? new Date();
  return {
    schemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: crypto.randomUUID(),
    generatedAt: generatedAt.toISOString(),
    machine: input.machine,
    source: {
      appVersion: input.appVersion ?? null,
      platform: snapshotPlatform(),
      hostname: os.hostname(),
    },
    rows: input.rows.map((row) => toSnapshotRow(row, input.machine)),
    ...(input.warnings?.length ? { warnings: input.warnings } : {}),
    ...(input.datasets && Object.keys(input.datasets).length ? { datasets: input.datasets } : {}),
    ...(input.facets && Object.keys(input.facets).length ? { facets: input.facets } : {}),
  };
};

const toSnapshotRow = (row: UsageRowWithOptionalSource, machine: UsageMachine): SnapshotUsageRow => {
  const source = row.source;
  return {
    ...serializeUsageRow(row),
    source: {
      ...(source?.artifactPath === undefined ? {} : { artifactPath: source.artifactPath }),
      harnessKey: source?.harnessKey ?? row.harness.toLowerCase(),
      sourceSessionId: source?.sourceSessionId ?? null,
      ...(source?.parentSourceSessionId === undefined ? {} : { parentSourceSessionId: source.parentSourceSessionId }),
      ...(source?.rootSourceSessionId === undefined ? {} : { rootSourceSessionId: source.rootSourceSessionId }),
      ...(source?.sourcePath === undefined ? {} : { sourcePath: source.sourcePath }),
      machineId: machine.id,
      machineLabel: machine.label,
    },
  };
};

export const parseUsageSnapshot = (text: string): UsageSnapshot => {
  assertPortableUsageByteLength(text, 'Snapshot');
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) {
    throw new Error('Snapshot must be an object');
  }
  if (!hasOnlyKeys(value, SNAPSHOT_KEYS)) {
    throw new Error('Snapshot contains unknown fields');
  }
  if (value.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('Unsupported snapshot schemaVersion');
  }
  if (typeof value.snapshotId !== 'string' || value.snapshotId.length === 0) {
    throw new Error('Snapshot missing snapshotId');
  }
  if (!isStrictIsoTimestamp(value.generatedAt)) {
    throw new Error('Snapshot contains an invalid generatedAt');
  }
  if (!isUsageMachine(value.machine)) {
    throw new Error('Snapshot missing machine');
  }
  if (!isUsageSnapshotSource(value.source)) {
    throw new Error('Snapshot contains an invalid source');
  }
  if (!Array.isArray(value.rows)) {
    throw new Error('Snapshot missing rows');
  }
  assertPortableUsageRowCount(value.rows, 'Snapshot');
  if (!value.rows.every(isSnapshotRow)) {
    throw new Error('Snapshot contains invalid row');
  }
  for (const row of value.rows) {
    if (row.source.machineId !== value.machine.id) {
      throw new Error('Snapshot row machineId does not match snapshot machine');
    }
    if (row.source.machineLabel !== value.machine.label) {
      throw new Error('Snapshot row machineLabel does not match snapshot machine');
    }
  }
  if (value.warnings !== undefined && !isUsageReportWarnings(value.warnings)) {
    throw new Error('Snapshot contains invalid warnings');
  }
  if (value.datasets !== undefined && !isUsageSnapshotDatasets(value.datasets)) {
    throw new Error('Snapshot contains invalid datasets');
  }
  if (value.facets !== undefined && !isJsonSafeObject(value.facets)) {
    throw new Error('Snapshot contains invalid facets');
  }
  return {
    schemaVersion: value.schemaVersion,
    snapshotId: value.snapshotId,
    generatedAt: value.generatedAt,
    machine: value.machine,
    source: value.source,
    rows: value.rows,
    ...(value.warnings === undefined ? {} : { warnings: value.warnings }),
    ...(value.datasets === undefined ? {} : { datasets: value.datasets }),
    ...(value.facets === undefined ? {} : { facets: value.facets }),
  };
};

export const serializeUsageSnapshot = (snapshot: UsageSnapshot, maxBytes = MAX_PORTABLE_USAGE_BYTES): string => {
  const validated = parseUsageSnapshot(JSON.stringify(snapshot));
  const text = `${JSON.stringify(validated, null, 2)}\n`;
  assertPortableUsageByteLength(text, 'Snapshot', maxBytes);
  return text;
};

const isUsageSnapshotSource = (value: unknown): value is UsageSnapshotSource => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, SNAPSHOT_SOURCE_KEYS) &&
    (value.appVersion === null || (typeof value.appVersion === 'string' && value.appVersion.length > 0)) &&
    (value.hostname === undefined || typeof value.hostname === 'string') &&
    (value.platform === 'macos' || value.platform === 'linux' || value.platform === 'windows')
  );
};

const isSnapshotRow = (value: unknown): value is SnapshotUsageRow => isSerializedUsageRowWithSource(value);

const isUsageSnapshotDatasets = (value: unknown): value is ReportDatasets => {
  if (!isJsonSafeObject(value)) {
    return false;
  }
  if (
    value.cursorCommitAttribution !== undefined &&
    !(Array.isArray(value.cursorCommitAttribution) && value.cursorCommitAttribution.every(isCursorCommitAttributionRow))
  ) {
    return false;
  }
  return value.providerStatus === undefined || parseProviderStatusDataset(value.providerStatus) !== null;
};

export const mergeUsageSnapshots = (snapshots: UsageSnapshot[]): SnapshotMergeResult => {
  const byKey = new Map<string, { snapshot: UsageSnapshot; row: SnapshotUsageRow }>();
  const warnings: SnapshotMergeWarning[] = [];
  const datasetsByKey = new Map<string, { generatedAt: string; value: unknown }>();
  const providerStatusDatasets: ProviderStatusDataset[] = [];
  let duplicatesDropped = 0;

  for (const snapshot of snapshots) {
    const snapshotDatasets = parseReportDatasets(snapshot.datasets);
    const providerStatus = parseProviderStatusDataset(snapshotDatasets?.providerStatus);
    if (providerStatus) {
      providerStatusDatasets.push(providerStatus);
    }
    for (const [key, value] of Object.entries(snapshotDatasets ?? {})) {
      if (key === 'providerStatus') {
        continue;
      }
      const existing = datasetsByKey.get(key);
      if (!existing || new Date(snapshot.generatedAt).getTime() >= new Date(existing.generatedAt).getTime()) {
        datasetsByKey.set(key, { generatedAt: snapshot.generatedAt, value });
      }
    }
    if (snapshot.warnings?.length) {
      warnings.push(...snapshot.warnings);
    }
    for (const row of snapshot.rows) {
      const key = dedupeKey(row);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { snapshot, row });
        continue;
      }

      duplicatesDropped++;
      if (JSON.stringify(existing.row) !== JSON.stringify(row)) {
        warnings.push({
          operation: 'mergeUsageSnapshots',
          message: 'Duplicate source row differs; kept newest snapshot row',
          key,
        });
      }
      if (new Date(snapshot.generatedAt).getTime() >= new Date(existing.snapshot.generatedAt).getTime()) {
        byKey.set(key, { snapshot, row });
      }
    }
  }

  const datasets: ReportDatasets = {};
  for (const [key, { value }] of datasetsByKey) {
    datasets[key] = value;
  }
  const providerStatus = mergeProviderStatusDatasets(providerStatusDatasets);
  if (providerStatus) {
    datasets.providerStatus = providerStatus;
  }
  return {
    rows: [...byKey.values()].map(({ row }) => deserializeSnapshotRow(row)),
    warnings,
    duplicatesDropped,
    ...(Object.keys(datasets).length ? { datasets } : {}),
  };
};

export const deserializeSnapshotRow = (row: SnapshotUsageRow): CollectedUsageRow => ({
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

const dedupeKey = (row: SnapshotUsageRow) => {
  const sessionId = row.source.sourceSessionId;
  if (sessionId) {
    return [row.source.machineId, row.source.harnessKey, sessionId].join('|');
  }
  return [
    row.source.machineId,
    row.harness,
    row.activeDate ?? row.date ?? '',
    row.model,
    row.models?.join('+') ?? '',
    row.project,
    row.name,
    row.tokenTotal,
  ].join('|');
};

export const localRowsToSnapshot = (
  machine: UsageMachine,
  rows: UsageRowWithOptionalSource[],
  generatedAt = new Date(),
): UsageSnapshot => createUsageSnapshot({ machine, rows, generatedAt });

export const sourceLabel = (row: UsageRowWithOptionalSource) => row.source?.machineLabel ?? '';

export const rowActiveTime = (row: UsageRow) => usageRowActiveDate(row)?.getTime() ?? 0;
export const rowTokenTotal = usageRowTokenTotal;
