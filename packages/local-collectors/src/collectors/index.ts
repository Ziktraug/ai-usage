import {
  HARNESS_METADATA,
  type HarnessKey,
  type HarnessMetadata,
  harnessKeys,
} from '@ai-usage/report-core/harness-metadata';
import type { Row } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { type LocalHistoryError, type LocalHistoryWarning, localHistoryWarningFromError } from '../errors';
import type { LocalHistoryStorage as LocalHistoryStorageService } from '../local-history';
import { withPerfSpan } from '../perf';
import {
  type CollectorRow,
  enrichCollectorRowsWithRtkSavingsResult,
  stripCollectorMetadata,
  stripProjectPath,
} from '../rtk-enrichment';
import { collectClaude, collectClaudeResult, collectClaudeRetentionWarnings } from './claude';
import { collectCodex, collectCodexResult } from './codex';
import { collectCursor, collectCursorResult } from './cursor';
import type { CursorCsvOptions } from './cursor-csv';
import { collectOpenCode, collectOpenCodeResult } from './opencode';

interface HarnessAdapterCollection {
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

export interface HarnessAdapter {
  collect: Effect.Effect<CollectorRow[], LocalHistoryError, LocalHistoryStorageService>;
  collectResult?: Effect.Effect<HarnessAdapterCollection, LocalHistoryError, LocalHistoryStorageService>;
  metadata: HarnessMetadata;
}

export type HarnessCollectionStatus = 'ok' | 'warning' | 'failed';

export interface HarnessCollectionResult {
  durationMs: number;
  harness: HarnessKey;
  label: string;
  rows: Row[];
  status: HarnessCollectionStatus;
  warnings: LocalHistoryWarning[];
}

export interface SelectedHarnessCollectionResult {
  durationMs: number;
  harnesses: HarnessCollectionResult[];
  rows: Row[];
  warnings: LocalHistoryWarning[];
}

export interface HarnessSelection {
  cursorCsv?: Partial<CursorCsvOptions> & { maxSessionSpanMs?: number; reconcileWindowMs?: number };
  harness: HarnessKey | null;
  includeCursor: boolean;
  keepSource?: boolean;
}

export const HARNESS_ADAPTERS: Record<HarnessKey, HarnessAdapter> = {
  claude: { metadata: HARNESS_METADATA.claude, collect: collectClaude, collectResult: collectClaudeResult },
  codex: { metadata: HARNESS_METADATA.codex, collect: collectCodex, collectResult: collectCodexResult },
  opencode: { metadata: HARNESS_METADATA.opencode, collect: collectOpenCode, collectResult: collectOpenCodeResult },
  cursor: { metadata: HARNESS_METADATA.cursor, collect: collectCursor, collectResult: collectCursorResult() },
};

const hasCursorCsvInput = (cursorCsv: HarnessSelection['cursorCsv']) =>
  Boolean(cursorCsv?.usageExportPaths?.length || cursorCsv?.usageExportDir);

export const selectedHarnessAdapters = (selection: HarnessSelection) => {
  const keys = selection.harness ? [selection.harness] : harnessKeys;
  return keys
    .filter((key) => selection.includeCursor || key !== 'cursor')
    .map((key): HarnessAdapter => {
      if (key === 'cursor' && hasCursorCsvInput(selection.cursorCsv)) {
        return {
          metadata: HARNESS_METADATA.cursor,
          collect: collectCursor,
          collectResult: collectCursorResult(selection.cursorCsv),
        };
      }
      return HARNESS_ADAPTERS[key];
    });
};

type HarnessAdapterOutcome =
  | { _tag: 'success'; rows: CollectorRow[]; warnings: LocalHistoryWarning[] }
  | { _tag: 'failure'; error: LocalHistoryError };

const collectAdapter = (
  adapter: HarnessAdapter,
): Effect.Effect<HarnessAdapterOutcome, never, LocalHistoryStorageService> => {
  const collection = adapter.collectResult ?? adapter.collect.pipe(Effect.map((rows) => ({ rows, warnings: [] })));
  return collection.pipe(
    Effect.match({
      onFailure: (error) => ({ _tag: 'failure' as const, error }),
      onSuccess: (result) => ({ _tag: 'success' as const, rows: result.rows, warnings: result.warnings }),
    }),
  );
};

interface RawHarnessCollectionResult extends Omit<HarnessCollectionResult, 'rows'> {
  rows: CollectorRow[];
}

const collectHarnessResult = (
  adapter: HarnessAdapter,
): Effect.Effect<RawHarnessCollectionResult, never, LocalHistoryStorageService> =>
  withPerfSpan(
    `aiUsage.collect.${adapter.metadata.key}`,
    Effect.gen(function* () {
      const startedAt = Date.now();
      const outcome = yield* collectAdapter(adapter);
      const durationMs = Date.now() - startedAt;
      const harness = adapter.metadata.key;
      if (outcome._tag === 'failure') {
        return {
          harness,
          label: adapter.metadata.label,
          rows: [],
          warnings: [
            localHistoryWarningFromError(outcome.error, {
              harness,
              message: `Failed to collect ${adapter.metadata.label} local history`,
            }),
          ],
          durationMs,
          status: 'failed',
        };
      }
      return {
        harness,
        label: adapter.metadata.label,
        rows: outcome.rows,
        warnings: outcome.warnings,
        durationMs,
        status: outcome.warnings.length ? 'warning' : 'ok',
      };
    }),
    (result) => ({
      rows: result.rows.length,
      status: result.status,
      warnings: result.warnings.length,
    }),
  );

export const collectSelectedHarnessResults = (selection: HarnessSelection) =>
  withPerfSpan(
    'aiUsage.collect.selectedHarnesses',
    Effect.gen(function* () {
      const startedAt = Date.now();
      const harnessResults = yield* Effect.all(selectedHarnessAdapters(selection).map(collectHarnessResult), {
        concurrency: 1,
      });
      const harnessExtraWarnings = new Map<HarnessKey, LocalHistoryWarning[]>();
      const globalWarnings: LocalHistoryWarning[] = [];
      const addHarnessWarning = (harness: HarnessKey, warning: LocalHistoryWarning) => {
        const warnings = harnessExtraWarnings.get(harness) ?? [];
        warnings.push(warning);
        harnessExtraWarnings.set(harness, warnings);
      };

      if (!selection.harness || selection.harness === 'claude') {
        for (const warning of yield* collectClaudeRetentionWarnings) {
          addHarnessWarning('claude', warning);
        }
      }

      let rows = harnessResults.flatMap((result) => result.rows);

      const enriched = yield* enrichCollectorRowsWithRtkSavingsResult(rows);
      rows = enriched.rows;
      globalWarnings.push(...enriched.warnings);

      const publicRows = rows.map(selection.keepSource ? stripProjectPath : stripCollectorMetadata);
      const publicHarnesses = harnessResults.map((result): HarnessCollectionResult => {
        const warnings = [...result.warnings, ...(harnessExtraWarnings.get(result.harness) ?? [])];
        return {
          ...result,
          rows: publicRows.filter((row) => row.harness === result.label),
          warnings,
          status: collectorStatus(result.status, warnings.length),
        };
      });
      return {
        rows: publicRows,
        harnesses: publicHarnesses,
        warnings: [...publicHarnesses.flatMap((result) => result.warnings), ...globalWarnings],
        durationMs: Date.now() - startedAt,
      };
    }),
    (result) => ({
      harnesses: result.harnesses.length,
      rows: result.rows.length,
      warnings: result.warnings.length,
    }),
  );

const collectorStatus = (status: HarnessCollectionStatus, warningCount: number) => {
  if (status === 'failed') {
    return 'failed';
  }
  return warningCount ? 'warning' : 'ok';
};

export const collectSelectedHarnessRows = (selection: HarnessSelection) =>
  collectSelectedHarnessResults(selection).pipe(Effect.map((result) => result.rows));
