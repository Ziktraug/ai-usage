import os from 'node:os';
import { type SerializedUsageRow, serializeUsageRow, type UsageReportWarning } from './report-data';
import type { CollectedUsageRow, UsageRow, UsageRowSource, UsageRowWithOptionalSource } from './types';
import { usageRowActiveDate, usageRowTokenTotal } from './usage-row';

export const USAGE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface UsageMachine {
  id: string;
  label: string;
}

export interface UsageSnapshotSource {
  appVersion: string | null;
  platform: 'macos' | 'linux' | 'windows';
  hostname?: string;
}

export interface SnapshotUsageRow extends SerializedUsageRow {
  source: UsageRowSource & {
    machineId: string;
    machineLabel: string;
  };
}

export interface UsageSnapshot {
  schemaVersion: typeof USAGE_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  generatedAt: string;
  machine: UsageMachine;
  source: UsageSnapshotSource;
  rows: SnapshotUsageRow[];
  warnings?: UsageReportWarning[];
  facets?: Record<string, unknown>;
}

export interface SnapshotMergeWarning extends UsageReportWarning {
  message: string;
  key?: string;
}

export interface SnapshotMergeResult {
  rows: CollectedUsageRow[];
  warnings: SnapshotMergeWarning[];
  duplicatesDropped: number;
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
}): UsageSnapshot => {
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
    ...(input.facets && Object.keys(input.facets).length ? { facets: input.facets } : {}),
  };
};

const toSnapshotRow = (row: UsageRowWithOptionalSource, machine: UsageMachine): SnapshotUsageRow => {
  const source = row.source;
  return {
    ...serializeUsageRow(row),
    source: {
      harnessKey: source?.harnessKey ?? row.harness.toLowerCase(),
      sourceSessionId: source?.sourceSessionId ?? null,
      ...(source?.sourcePath === undefined ? {} : { sourcePath: source.sourcePath }),
      machineId: machine.id,
      machineLabel: machine.label,
    },
  };
};

export const parseUsageSnapshot = (text: string): UsageSnapshot => {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Snapshot must be an object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== USAGE_SNAPSHOT_SCHEMA_VERSION) throw new Error('Unsupported snapshot schemaVersion');
  if (typeof record.snapshotId !== 'string') throw new Error('Snapshot missing snapshotId');
  if (typeof record.generatedAt !== 'string') throw new Error('Snapshot missing generatedAt');
  if (!isMachine(record.machine)) throw new Error('Snapshot missing machine');
  if (!Array.isArray(record.rows)) throw new Error('Snapshot missing rows');
  for (const row of record.rows) {
    if (!isSnapshotRow(row)) throw new Error('Snapshot contains invalid row');
  }
  if (record.warnings !== undefined && !isUsageReportWarnings(record.warnings)) {
    throw new Error('Snapshot contains invalid warnings');
  }
  return value as UsageSnapshot;
};

const isMachine = (value: unknown): value is UsageMachine => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.label === 'string';
};

const isSnapshotRow = (value: unknown): value is SnapshotUsageRow => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (typeof record.harness !== 'string' || typeof record.provider !== 'string' || typeof record.name !== 'string') {
    return false;
  }
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return false;
  const sourceRecord = source as Record<string, unknown>;
  return typeof sourceRecord.machineId === 'string' && typeof sourceRecord.machineLabel === 'string';
};

const optionalString = (value: unknown) => value === undefined || typeof value === 'string';

const isUsageReportWarnings = (value: unknown): value is UsageReportWarning[] =>
  Array.isArray(value) &&
  value.every((warning) => {
    if (typeof warning !== 'object' || warning === null || Array.isArray(warning)) return false;
    const record = warning as Record<string, unknown>;
    return (
      typeof record.message === 'string' &&
      optionalString(record.harness) &&
      optionalString(record.operation) &&
      optionalString(record.path) &&
      optionalString(record.sql)
    );
  });

export const mergeUsageSnapshots = (snapshots: UsageSnapshot[]): SnapshotMergeResult => {
  const byKey = new Map<string, { snapshot: UsageSnapshot; row: SnapshotUsageRow }>();
  const warnings: SnapshotMergeWarning[] = [];
  let duplicatesDropped = 0;

  for (const snapshot of snapshots) {
    if (snapshot.warnings?.length) warnings.push(...snapshot.warnings);
    for (const row of snapshot.rows) {
      const key = dedupeKey(row);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { snapshot, row });
        continue;
      }

      duplicatesDropped++;
      if (JSON.stringify(existing.row) !== JSON.stringify(row)) {
        warnings.push({ operation: 'mergeUsageSnapshots', message: 'Duplicate source row differs; kept newest snapshot row', key });
      }
      if (new Date(snapshot.generatedAt).getTime() >= new Date(existing.snapshot.generatedAt).getTime()) {
        byKey.set(key, { snapshot, row });
      }
    }
  }

  return {
    rows: [...byKey.values()].map(({ row }) => deserializeSnapshotRow(row)),
    warnings,
    duplicatesDropped,
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
  if (sessionId) return [row.source.machineId, row.source.harnessKey, sessionId].join('|');
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
): UsageSnapshot =>
  createUsageSnapshot({ machine, rows, generatedAt });

export const sourceLabel = (row: UsageRowWithOptionalSource) => row.source?.machineLabel ?? '';

export const rowActiveTime = (row: UsageRow) => usageRowActiveDate(row)?.getTime() ?? 0;
export const rowTokenTotal = usageRowTokenTotal;
