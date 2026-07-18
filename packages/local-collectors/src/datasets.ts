import { createHash } from 'node:crypto';
import type { CursorCommitAttributionRow, NormalizedDatasetItem, ReportDatasets } from '@ai-usage/report-core/datasets';
import {
  createProviderStatusDataset,
  type ProviderStatus,
  type ProviderStatusDataset,
} from '@ai-usage/report-core/provider-status';
import { Effect } from 'effect';
import { findLatestCodexProviderStatus } from './codex-history';
import { type LocalHistoryError, type LocalHistoryWarning, localHistoryWarningFromError } from './errors';
import { collectCursorCommitAttributionResult, type HarnessFacets } from './facets';
import type { LocalHistoryStorage as LocalHistoryStorageService } from './local-history';

export interface HarnessDatasetSelection {
  includeCursor: boolean;
  includeProviderStatus?: boolean;
  machineId?: string;
  machineLabel?: string;
}

export interface HarnessDatasets extends ReportDatasets {
  cursorCommitAttribution?: CursorCommitAttributionRow[];
  providerStatus?: ProviderStatusDataset;
}

export interface HarnessDatasetsResult {
  datasets: HarnessDatasets;
  warnings: LocalHistoryWarning[];
}

export const cursorCommitAttributionItemKey = (row: Pick<CursorCommitAttributionRow, 'branchName' | 'commitHash'>) =>
  createHash('sha256')
    .update(JSON.stringify([row.commitHash, row.branchName]))
    .digest('hex');

export const normalizeCursorCommitAttributionItems = (
  machineId: string,
  rows: readonly CursorCommitAttributionRow[],
): NormalizedDatasetItem[] =>
  rows.map((payload) => ({
    datasetKey: 'cursor.commit-attribution',
    itemKey: cursorCommitAttributionItemKey(payload),
    machineId,
    payload,
    schemaVersion: 1,
    sourceId: 'cursor.commit-attribution',
  }));

export const mirrorDatasetsToLegacyFacets = (datasets: ReportDatasets | undefined): HarnessFacets | undefined => {
  if (!datasets?.cursorCommitAttribution?.length) {
    return;
  }
  return {
    cursor: {
      commitAttribution: datasets.cursorCommitAttribution,
    },
  };
};

const codexCollectionErrorStatus = (selection: HarnessDatasetSelection): ProviderStatus => ({
  generatedAt: new Date().toISOString(),
  key: 'codex',
  label: 'Codex',
  ...(selection.machineId === undefined ? {} : { machineId: selection.machineId }),
  ...(selection.machineLabel === undefined ? {} : { machineLabel: selection.machineLabel }),
  source: 'local-history',
  state: 'error',
  warnings: ['Codex provider status could not be collected from local history.'],
  windows: [],
});

export const collectHarnessDatasetsResult = (
  selection: HarnessDatasetSelection,
): Effect.Effect<HarnessDatasetsResult, never, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const datasets: HarnessDatasets = {};
    const warnings: LocalHistoryWarning[] = [];
    if (selection.includeCursor) {
      const result = yield* collectCursorCommitAttributionResult.pipe(
        Effect.catchAll((error: LocalHistoryError) =>
          Effect.succeed({
            rows: [],
            warnings: [
              localHistoryWarningFromError(error, {
                harness: 'cursor',
                message: 'Failed to collect Cursor commit attribution',
              }),
            ],
          }),
        ),
      );
      warnings.push(...result.warnings);
      if (result.rows.length) {
        datasets.cursorCommitAttribution = result.rows;
      }
    }
    if (selection.includeProviderStatus) {
      const codex = yield* findLatestCodexProviderStatus({
        ...(selection.machineId === undefined ? {} : { machineId: selection.machineId }),
        ...(selection.machineLabel === undefined ? {} : { machineLabel: selection.machineLabel }),
      }).pipe(Effect.catchAll(() => Effect.succeed(codexCollectionErrorStatus(selection))));
      if (codex) {
        datasets.providerStatus = createProviderStatusDataset([codex]);
      }
    }
    return { datasets, warnings };
  });

export const collectHarnessDatasets = (
  selection: HarnessDatasetSelection,
): Effect.Effect<HarnessDatasets, never, LocalHistoryStorageService> =>
  collectHarnessDatasetsResult(selection).pipe(Effect.map((result) => result.datasets));
