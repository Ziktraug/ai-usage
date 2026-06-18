import { harnessLabel } from '@ai-usage/core/harness-metadata';
import type { SourcedRow } from '@ai-usage/core/types';
import { actualCost, normalizeUsageRow, usageRowTokenTotal } from '@ai-usage/core/usage-row';
import type { CollectorRow } from '../rtk-enrichment';
import { withSource } from '../rtk-enrichment';
import { type CursorCsvCluster, type CursorCsvTurn, clusterFromTurns, clusterTurns } from './cursor-csv';

export interface CursorReconcileOptions {
  clusterGapMs: number;
  maxSessionSpanMs: number;
  reconcileWindowMs: number;
}

const cursorHarness = harnessLabel('cursor');

const sourceFromRow = (row: CollectorRow) => (row as Partial<SourcedRow>).source;

const isCursorRow = (row: CollectorRow) => row.harness === cursorHarness;

const turnDistance = (row: CollectorRow, turn: CursorCsvTurn) => {
  if (!row.date) return Number.POSITIVE_INFINITY;
  return Math.abs(row.date.getTime() - turn.date.getTime());
};

const cursorSessionWindows = (rows: CollectorRow[], options: CursorReconcileOptions) => {
  const sorted = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.date)
    .sort((a, b) => (a.row.date?.getTime() ?? 0) - (b.row.date?.getTime() ?? 0));
  return sorted.map((entry, sortedIndex) => {
    const start = entry.row.date?.getTime() ?? 0;
    const nextStart = sorted[sortedIndex + 1]?.row.date?.getTime();
    const maxEnd = start + options.maxSessionSpanMs;
    return {
      ...entry,
      startMs: start - options.reconcileWindowMs,
      endMs: Math.min(nextStart ? nextStart - 1 : maxEnd, maxEnd),
    };
  });
};

const modelList = (cluster: CursorCsvCluster) => (cluster.models.length > 1 ? cluster.models : undefined);

const mergeClusterIntoRow = (row: CollectorRow, cluster: CursorCsvCluster, ambiguous: boolean): CollectorRow => {
  const source = sourceFromRow(row);
  const models = modelList(cluster);
  const merged = normalizeUsageRow({
    date: row.date ?? cluster.startDate,
    endDate: cluster.endDate,
    harness: row.harness,
    provider: row.provider,
    name: row.name,
    model: cluster.dominantModel,
    ...(models ? { models } : {}),
    project: row.project,
    tokens: cluster.tokens,
    cost: actualCost(cluster.costActual),
    costQuota: cluster.costQuota,
    costApprox: cluster.costApprox,
    costKnown: cluster.costKnown,
    calls: cluster.calls,
    turns: row.turns || cluster.calls,
    tools: row.tools,
    linesAdded: row.linesAdded,
    linesDeleted: row.linesDeleted,
    ...(ambiguous ? { ambiguous: true } : {}),
  });
  const withMetadata: CollectorRow = {
    ...merged,
    ...(row.projectPath ? { projectPath: row.projectPath } : {}),
  };
  return source ? withSource(withMetadata, source) : withMetadata;
};

const rowFromCluster = (cluster: CursorCsvCluster): CollectorRow =>
  withSource(
    normalizeUsageRow({
      date: cluster.startDate,
      endDate: cluster.endDate,
      harness: cursorHarness,
      provider: 'Cursor sub',
      name: `Cursor export ${cluster.startDate.toISOString()}`,
      model: cluster.dominantModel,
      ...(modelList(cluster) ? { models: modelList(cluster) as string[] } : {}),
      project: '',
      tokens: cluster.tokens,
      cost: actualCost(cluster.costActual),
      costQuota: cluster.costQuota,
      costApprox: cluster.costApprox,
      costKnown: cluster.costKnown,
      calls: cluster.calls,
      turns: cluster.calls,
      tools: 0,
      linesAdded: null,
      linesDeleted: null,
    }),
    { harnessKey: 'cursor', sourceSessionId: null, sourcePath: cluster.sourcePath },
  );

export const reconcileCursorRows = (
  rows: CollectorRow[],
  turns: CursorCsvTurn[],
  options: CursorReconcileOptions,
): CollectorRow[] => {
  if (!turns.length) return rows;
  const cursorRows = rows.filter(isCursorRow);
  const otherRows = rows.filter((row) => !isCursorRow(row));
  const windows = cursorSessionWindows(cursorRows, options);
  const assignments = new Map<number, { turns: CursorCsvTurn[]; ambiguous: boolean }>();
  const orphanTurns: CursorCsvTurn[] = [];

  turns.forEach((turn) => {
    const candidates = windows
      .filter((window) => {
        const time = turn.date.getTime();
        return time >= window.startMs && time <= window.endMs;
      })
      .map((window) => ({ row: window.row, index: window.index, distance: turnDistance(window.row, turn) }))
      .sort((a, b) => a.distance - b.distance || usageRowTokenTotal(a.row) - usageRowTokenTotal(b.row));
    const nearbyCandidateCount = cursorRows.filter(
      (row) => turnDistance(row, turn) <= options.reconcileWindowMs,
    ).length;

    const best = candidates[0];
    if (!best) {
      orphanTurns.push(turn);
      return;
    }

    const assignment = assignments.get(best.index) ?? { turns: [], ambiguous: false };
    assignment.turns.push(turn);
    assignment.ambiguous = assignment.ambiguous || candidates.length > 1 || nearbyCandidateCount > 1;
    assignments.set(best.index, assignment);
  });

  const reconciledCursorRows = new Map<number, CollectorRow>();
  for (const [index, assignment] of assignments) {
    const row = cursorRows[index];
    if (!row) continue;
    reconciledCursorRows.set(index, mergeClusterIntoRow(row, clusterFromTurns(assignment.turns), assignment.ambiguous));
  }

  const cursorOutput = cursorRows.map((row, index) => reconciledCursorRows.get(index) ?? row);
  const newRows = clusterTurns(orphanTurns, options.clusterGapMs).map(rowFromCluster);
  return [...otherRows, ...cursorOutput, ...newRows];
};
