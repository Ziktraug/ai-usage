import type { UsageRowWithOptionalSource } from './types';

const lineageGroupKey = (row: UsageRowWithOptionalSource) =>
  `${row.source?.machineId ?? ''}\0${row.source?.harnessKey ?? ''}`;

const resolveRootSourceSessionId = (
  row: UsageRowWithOptionalSource,
  rowsBySourceId: Map<string, UsageRowWithOptionalSource>,
) => {
  const sourceSessionId = row.source?.sourceSessionId ?? null;
  if (!sourceSessionId) {
    return null;
  }

  let current = row;
  const seen = new Set<string>();

  while (true) {
    const currentSourceId = current.source?.sourceSessionId ?? null;
    if (!currentSourceId) {
      return sourceSessionId;
    }
    if (seen.has(currentSourceId)) {
      return sourceSessionId;
    }
    seen.add(currentSourceId);

    const parentSourceId = current.source?.parentSourceSessionId ?? null;
    if (!parentSourceId || parentSourceId === currentSourceId) {
      return currentSourceId;
    }

    const parent = rowsBySourceId.get(parentSourceId);
    if (!parent) {
      return sourceSessionId;
    }
    current = parent;
  }
};

export const normalizeSessionLineage = <T extends UsageRowWithOptionalSource>(rows: readonly T[]): T[] => {
  const groupedRows = new Map<string, Map<string, UsageRowWithOptionalSource>>();

  for (const row of rows) {
    const sourceSessionId = row.source?.sourceSessionId ?? null;
    if (!sourceSessionId) {
      continue;
    }

    const groupKey = lineageGroupKey(row);
    const group = groupedRows.get(groupKey) ?? new Map<string, UsageRowWithOptionalSource>();
    group.set(sourceSessionId, row);
    groupedRows.set(groupKey, group);
  }

  return rows.map((row) => {
    if (!row.source) {
      return { ...row };
    }

    const rowsBySourceId = groupedRows.get(lineageGroupKey(row)) ?? new Map<string, UsageRowWithOptionalSource>();
    const rootSourceSessionId = resolveRootSourceSessionId(row, rowsBySourceId);

    return {
      ...row,
      source: {
        ...row.source,
        rootSourceSessionId,
      },
    };
  });
};
