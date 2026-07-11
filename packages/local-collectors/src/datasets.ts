import type { CursorCommitAttributionRow, ReportDatasets } from '@ai-usage/report-core/datasets';
import {
  createProviderStatusDataset,
  type ProviderStatus,
  type ProviderStatusDataset,
} from '@ai-usage/report-core/provider-status';
import { Effect } from 'effect';
import { findLatestCodexProviderStatus } from './codex-history';
import type { LocalHistoryError } from './errors';
import { collectCursorCommitAttribution, type HarnessFacets } from './facets';
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

export const collectHarnessDatasets = (
  selection: HarnessDatasetSelection,
): Effect.Effect<HarnessDatasets, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const datasets: HarnessDatasets = {};
    if (selection.includeCursor) {
      const commitAttribution = yield* collectCursorCommitAttribution.pipe(Effect.catchAll(() => Effect.succeed([])));
      if (commitAttribution.length) {
        datasets.cursorCommitAttribution = commitAttribution;
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
    return datasets;
  });
