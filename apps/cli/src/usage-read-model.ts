import type { ReportDatasets } from '@ai-usage/report-core/datasets';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { type HarnessKey, isHarnessKey } from '@ai-usage/report-core/harness-metadata';
import { projectProviderQuotaObservation } from '@ai-usage/report-core/provider-quota';
import {
  createUsageReportPayload,
  deserializeProjectedUsageRow,
  deserializeUsageRow,
  type SerializedRow,
  type UsageReportPayload,
  type UsageReportProjectGroup,
  type UsageReportWarning,
} from '@ai-usage/report-core/report-data';
import { createUsageSnapshot, type UsageMachine, type UsageSnapshot } from '@ai-usage/report-core/snapshot';
import type { CollectionSourceId, SourceControlEntryView } from '@ai-usage/report-core/source-control';
import type { Row } from '@ai-usage/report-core/types';
import { usageRowLineDelta, usageRowPricedCost, usageRowTokenTotal } from '@ai-usage/report-core/usage-row';
import { usageEngineReportSourceIdsFor } from '@ai-usage/usage-engine-control';
import {
  queryLatestLocalProviderQuotaObservations,
  queryServedReportRevisionLocalSnapshot,
  queryServedReportRevisionPortableConfig,
  queryServedReportRevisionSlices,
  queryServedReportRevisionSupport,
  queryUsageLocalMachine,
} from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';
import type { Args } from './cli';
import { prepareUsageReport } from './report';

export interface UsageSelection {
  readonly harness: HarnessKey | null;
  readonly includeCursor: boolean;
}

export interface ServedUsageReport {
  readonly payload: UsageReportPayload;
  readonly revision: string;
  readonly rows: Row[];
  readonly warnings: UsageReportWarning[];
}

export interface CliSourceExecutionOutcome {
  readonly result?: { readonly unavailable?: SourceControlEntryView['reason'] };
  readonly sourceId: CollectionSourceId;
  readonly status: 'failed' | 'paused' | 'skipped' | 'success' | 'timed-out' | 'unavailable' | 'warning';
  readonly warnings: readonly SourceControlEntryView['warnings'][number][];
}

const cursorSelected = (selection: UsageSelection): boolean =>
  selection.includeCursor && (selection.harness === null || selection.harness === 'cursor');

const rowMatchesSelection = (row: SerializedRow, selection: UsageSelection): boolean => {
  const harnessKey = row.source?.harnessKey;
  if (selection.harness !== null && harnessKey !== selection.harness) {
    return false;
  }
  return selection.includeCursor || harnessKey !== 'cursor';
};

export const selectServedRows = (rows: readonly SerializedRow[], selection: UsageSelection): SerializedRow[] =>
  rows.filter((row) => rowMatchesSelection(row, selection));

const selectDatasets = (
  datasets: FocusedReportSupport['datasets'],
  selection: UsageSelection,
): ReportDatasets | undefined => {
  if (!datasets) {
    return;
  }
  const { cursorCommitAttribution: _cursorCommitAttribution, ...datasetsWithoutCursor } = datasets;
  const selected: ReportDatasets = cursorSelected(selection) ? { ...datasets } : datasetsWithoutCursor;
  return Object.keys(selected).length > 0 ? selected : undefined;
};

const selectFacets = (
  support: FocusedReportSupport,
  datasets: ReportDatasets | undefined,
  selection: UsageSelection,
): Record<string, unknown> | undefined => {
  const { cursor: _cursor, ...facetsWithoutCursor } = support.facets ?? {};
  const selected: Record<string, unknown> = cursorSelected(selection)
    ? { ...(support.facets ?? {}) }
    : facetsWithoutCursor;
  if (datasets?.cursorCommitAttribution?.length) {
    const cursorFacet =
      typeof selected.cursor === 'object' && selected.cursor !== null && !Array.isArray(selected.cursor)
        ? selected.cursor
        : {};
    selected.cursor = { ...cursorFacet, commitAttribution: datasets.cursorCommitAttribution };
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
};

const selectWarnings = (warnings: readonly UsageReportWarning[], selection: UsageSelection): UsageReportWarning[] =>
  warnings.filter((warning) => {
    const warningHarness = warning.harness?.toLowerCase();
    if (!(warningHarness && isHarnessKey(warningHarness))) {
      return true;
    }
    if (warningHarness === 'cursor' && !selection.includeCursor) {
      return false;
    }
    return selection.harness === null || warningHarness === selection.harness;
  });

const filteredProjectGroups = (
  groups: readonly UsageReportProjectGroup[] | undefined,
  rows: readonly Row[],
): UsageReportProjectGroup[] | undefined => {
  if (!groups) {
    return;
  }
  const rowsByGroup = new Map<string, Row[]>();
  for (const row of rows) {
    const groupId = (row as Row & { readonly projectGroupId?: string }).projectGroupId;
    if (!groupId) {
      continue;
    }
    const groupRows = rowsByGroup.get(groupId) ?? [];
    groupRows.push(row);
    rowsByGroup.set(groupId, groupRows);
  }
  return groups
    .flatMap((group): UsageReportProjectGroup[] => {
      const groupRows = rowsByGroup.get(group.id) ?? [];
      if (groupRows.length === 0) {
        return [];
      }
      const sourceRows = new Map<string, Row[]>();
      for (const row of groupRows) {
        const sourceId = (row as Row & { readonly projectSourceId?: string }).projectSourceId;
        if (!sourceId) {
          continue;
        }
        const rowsForSource = sourceRows.get(sourceId) ?? [];
        rowsForSource.push(row);
        sourceRows.set(sourceId, rowsForSource);
      }
      const lineDelta = groupRows.reduce(
        (total, row) => {
          const delta = usageRowLineDelta(row);
          total.added += delta.added;
          total.deleted += delta.deleted;
          return total;
        },
        { added: 0, deleted: 0 },
      );
      return [
        {
          ...group,
          cache: groupRows.reduce((total, row) => total + row.tokCr, 0),
          cost: groupRows.reduce((total, row) => total + (usageRowPricedCost(row) ?? 0), 0),
          fresh: groupRows.reduce((total, row) => total + row.tokIn + row.tokOut + row.tokCw, 0),
          linesAdded: lineDelta.added,
          linesDeleted: lineDelta.deleted,
          priced: groupRows.filter((row) => usageRowPricedCost(row) !== null).length,
          sessions: groupRows.length,
          sources: group.sources.flatMap((source) => {
            const rowsForSource = sourceRows.get(source.id) ?? [];
            return rowsForSource.length === 0
              ? []
              : [
                  {
                    ...source,
                    sessions: rowsForSource.length,
                    tokens: rowsForSource.reduce((total, row) => total + usageRowTokenTotal(row), 0),
                  },
                ];
          }),
          tokens: groupRows.reduce((total, row) => total + usageRowTokenTotal(row), 0),
          tools: groupRows.reduce((total, row) => total + row.tools, 0),
          turns: groupRows.reduce((total, row) => total + row.turns, 0),
        },
      ];
    })
    .sort((left, right) => right.cost - left.cost || right.fresh - left.fresh);
};

export const createServedUsageReport = (input: {
  readonly args: Args;
  readonly rows: readonly SerializedRow[];
  readonly selection: UsageSelection;
  readonly support: FocusedReportSupport;
  readonly warnings?: readonly UsageReportWarning[];
}): Omit<ServedUsageReport, 'revision'> => {
  const selectedRows = selectServedRows(input.rows, input.selection).map(deserializeProjectedUsageRow);
  const report = prepareUsageReport(selectedRows, input.args);
  const datasets = selectDatasets(input.support.datasets, input.selection);
  const facets = selectFacets(input.support, datasets, input.selection);
  const warnings = selectWarnings([...(input.support.warnings ?? []), ...(input.warnings ?? [])], input.selection);
  return {
    payload: createUsageReportPayload(
      report,
      input.args,
      new Date(input.support.generatedAt),
      facets,
      warnings,
      filteredProjectGroups(input.support.projectGroups, selectedRows),
      input.support.projectGroupConfigs,
      datasets,
    ),
    rows: report.rows,
    warnings,
  };
};

export const createServedUsageSnapshot = (input: {
  readonly machine: UsageMachine;
  readonly rows: readonly SerializedRow[];
  readonly selection: UsageSelection;
  readonly support: FocusedReportSupport;
  readonly warnings?: readonly UsageReportWarning[];
}): UsageSnapshot => {
  const datasets = selectDatasets(input.support.datasets, input.selection);
  const facets = selectFacets(input.support, datasets, input.selection);
  const warnings = selectWarnings([...(input.support.warnings ?? []), ...(input.warnings ?? [])], input.selection);
  const rows = selectServedRows(input.rows, input.selection).map((row) => {
    const deserialized = deserializeUsageRow(row);
    return { ...deserialized, project: row.rawProject ?? deserialized.project };
  });
  return createUsageSnapshot({
    generatedAt: new Date(input.support.generatedAt),
    machine: input.machine,
    rows,
    warnings,
    ...(datasets === undefined ? {} : { datasets }),
    ...(facets === undefined ? {} : { facets }),
  });
};

export const readServedUsageReport = async (input: {
  readonly args: Args;
  readonly dbPath: string;
  readonly revision?: string;
  readonly warnings?: readonly UsageReportWarning[];
}): Promise<ServedUsageReport> => {
  const slices = await Effect.runPromise(
    queryServedReportRevisionSlices({
      dbPath: input.dbPath,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    }),
  );
  return {
    ...createServedUsageReport({
      args: input.args,
      rows: slices.rows,
      selection: { harness: input.args.harness, includeCursor: input.args.cursor },
      support: slices.support,
      ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
    }),
    revision: slices.manifest.revision,
  };
};

export interface ServedLocalUsageSnapshot {
  readonly snapshot: UsageSnapshot;
  readonly support: FocusedReportSupport;
}

export const readServedLocalUsageSnapshot = async (input: {
  readonly dbPath: string;
  readonly revision: string;
  readonly selection: UsageSelection;
  readonly warnings?: readonly UsageReportWarning[];
}): Promise<ServedLocalUsageSnapshot> => {
  const served = await Effect.runPromise(
    queryServedReportRevisionLocalSnapshot({ dbPath: input.dbPath, revision: input.revision }),
  );
  return {
    snapshot: createServedUsageSnapshot({
      machine: served.machine,
      rows: served.rows,
      selection: input.selection,
      support: served.support,
      ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
    }),
    support: served.support,
  };
};

export const readServedUsageSupport = async (dbPath: string, revision: string): Promise<FocusedReportSupport> =>
  (await Effect.runPromise(queryServedReportRevisionSupport({ dbPath, revision }))).support;

export const readServedPortableConfig = async (dbPath: string, revision?: string) => {
  const result = await Effect.runPromise(
    Effect.either(
      queryServedReportRevisionPortableConfig({
        dbPath,
        ...(revision === undefined ? {} : { revision }),
      }),
    ),
  );
  if (result._tag === 'Left') {
    throw result.left;
  }
  return result.right;
};

export const readUsageMachine = async (dbPath: string): Promise<UsageMachine> => {
  const result = await Effect.runPromise(Effect.either(queryUsageLocalMachine({ dbPath })));
  if (result._tag === 'Left') {
    throw result.left;
  }
  return result.right;
};

export const readLatestProviderQuotas = async (dbPath: string) => {
  const latest = await Effect.runPromise(queryLatestLocalProviderQuotaObservations({ dbPath, providerKey: 'codex' }));
  return latest.observations.map(({ observation }) => projectProviderQuotaObservation(observation));
};

export const reportSourceIdsFor = usageEngineReportSourceIdsFor;

const sourceOutcome = (source: SourceControlEntryView): CliSourceExecutionOutcome['status'] => {
  if (source.policy === 'disabled') {
    return 'paused';
  }
  return source.lastOutcome === 'not-run' ? 'unavailable' : source.lastOutcome;
};

export const sourceExecutionOutcomes = (
  sources: readonly SourceControlEntryView[],
  sourceIds: readonly CollectionSourceId[],
): CliSourceExecutionOutcome[] => {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return sourceIds.map((sourceId) => {
    const source = byId.get(sourceId);
    if (!source) {
      return { sourceId, status: 'unavailable', warnings: [] };
    }
    const outcome = sourceOutcome(source);
    return {
      sourceId,
      status: outcome,
      warnings: source.warnings,
      ...(source.reason.code === 'none' ? {} : { result: { unavailable: source.reason } }),
    };
  });
};

export const sourceExecutionWarnings = (outcomes: readonly CliSourceExecutionOutcome[]): UsageReportWarning[] =>
  outcomes.flatMap((outcome) => {
    const harness = outcome.sourceId.split('.')[0];
    const warnings = outcome.warnings.map((warning) => ({
      ...(harness === undefined ? {} : { harness }),
      message: warning.message ?? 'The source reported a warning.',
      operation: outcome.sourceId,
    }));
    if (outcome.status === 'paused') {
      warnings.push({
        ...(harness === undefined ? {} : { harness }),
        message: 'The source is paused by user policy.',
        operation: outcome.sourceId,
      });
    } else if (
      warnings.length === 0 &&
      (outcome.status === 'failed' || outcome.status === 'timed-out' || outcome.status === 'unavailable')
    ) {
      warnings.push({
        ...(harness === undefined ? {} : { harness }),
        message:
          outcome.result?.unavailable?.message ??
          (outcome.status === 'timed-out'
            ? 'The source run timed out; stored history was preserved.'
            : 'The source run failed; stored history was preserved.'),
        operation: outcome.sourceId,
      });
    }
    return warnings;
  });
