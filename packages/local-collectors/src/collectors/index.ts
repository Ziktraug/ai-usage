import { HARNESS_METADATA, type HarnessKey, type HarnessMetadata, harnessKeys } from '@ai-usage/report-core/harness-metadata';
import type { Row } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { type LocalHistoryError, type LocalHistoryWarning, localHistoryWarningFromError } from '../errors';
import type { LocalHistoryStorage as LocalHistoryStorageService } from '../local-history';
import {
  type CollectorRow,
  enrichCollectorRowsWithRtkSavingsResult,
  stripCollectorMetadata,
  stripProjectPath,
} from '../rtk-enrichment';
import { collectClaude } from './claude';
import { collectCodex } from './codex';
import { collectCursor } from './cursor';
import type { CursorCsvOptions } from './cursor-csv';
import { collectCursorCsvTurns } from './cursor-csv';
import { reconcileCursorRows } from './cursor-reconcile';
import { collectOpenCode, collectOpenCodeResult } from './opencode';

interface HarnessAdapterCollection {
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

export interface HarnessAdapter {
  metadata: HarnessMetadata;
  collect: Effect.Effect<CollectorRow[], LocalHistoryError, LocalHistoryStorageService>;
  collectResult?: Effect.Effect<HarnessAdapterCollection, never, LocalHistoryStorageService>;
}

export type HarnessCollectionStatus = 'ok' | 'warning' | 'failed';

export interface HarnessCollectionResult {
  harness: HarnessKey;
  label: string;
  rows: Row[];
  warnings: LocalHistoryWarning[];
  durationMs: number;
  status: HarnessCollectionStatus;
}

export interface SelectedHarnessCollectionResult {
  rows: Row[];
  harnesses: HarnessCollectionResult[];
  warnings: LocalHistoryWarning[];
  durationMs: number;
}

export interface HarnessSelection {
  harness: HarnessKey | null;
  includeCursor: boolean;
  keepSource?: boolean;
  cursorCsv?: Partial<CursorCsvOptions> & { maxSessionSpanMs?: number; reconcileWindowMs?: number };
}

export const HARNESS_ADAPTERS: Record<HarnessKey, HarnessAdapter> = {
  claude: { metadata: HARNESS_METADATA.claude, collect: collectClaude },
  codex: { metadata: HARNESS_METADATA.codex, collect: collectCodex },
  opencode: { metadata: HARNESS_METADATA.opencode, collect: collectOpenCode, collectResult: collectOpenCodeResult },
  cursor: { metadata: HARNESS_METADATA.cursor, collect: collectCursor },
};

export const selectedHarnessAdapters = (selection: HarnessSelection) => {
  const keys = selection.harness ? [selection.harness] : harnessKeys;
  return keys.filter((key) => selection.includeCursor || key !== 'cursor').map((key) => HARNESS_ADAPTERS[key]);
};

type HarnessAdapterOutcome =
  | { _tag: 'success'; rows: CollectorRow[]; warnings: LocalHistoryWarning[] }
  | { _tag: 'failure'; error: LocalHistoryError };

const collectAdapter = (
  adapter: HarnessAdapter,
): Effect.Effect<HarnessAdapterOutcome, never, LocalHistoryStorageService> => {
  if (adapter.collectResult) {
    return adapter.collectResult.pipe(
      Effect.map((result) => ({ _tag: 'success' as const, rows: result.rows, warnings: result.warnings })),
    );
  }
  return adapter.collect.pipe(
    Effect.match({
      onFailure: (error) => ({ _tag: 'failure' as const, error }),
      onSuccess: (rows) => ({ _tag: 'success' as const, rows, warnings: [] }),
    }),
  );
};

interface RawHarnessCollectionResult extends Omit<HarnessCollectionResult, 'rows'> {
  rows: CollectorRow[];
}

const collectHarnessResult = (
  adapter: HarnessAdapter,
): Effect.Effect<RawHarnessCollectionResult, never, LocalHistoryStorageService> =>
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
  });

export const collectSelectedHarnessResults = (selection: HarnessSelection) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const harnessResults = yield* Effect.all(selectedHarnessAdapters(selection).map(collectHarnessResult), {
      concurrency: 'unbounded',
    });
    const harnessExtraWarnings = new Map<HarnessKey, LocalHistoryWarning[]>();
    const globalWarnings: LocalHistoryWarning[] = [];
    const addHarnessWarning = (harness: HarnessKey, warning: LocalHistoryWarning) => {
      const warnings = harnessExtraWarnings.get(harness) ?? [];
      warnings.push(warning);
      harnessExtraWarnings.set(harness, warnings);
    };

    let rows = harnessResults.flatMap((result) => result.rows);
    const cursorCsv = selection.cursorCsv;
    if (
      selection.includeCursor &&
      (!selection.harness || selection.harness === 'cursor') &&
      (cursorCsv?.usageExportPaths?.length || cursorCsv?.usageExportDir)
    ) {
      const turnsResult = yield* collectCursorCsvTurns({
        usageExportPaths: cursorCsv.usageExportPaths ?? [],
        ...(cursorCsv.usageExportDir ? { usageExportDir: cursorCsv.usageExportDir } : {}),
        clusterGapMs: cursorCsv.clusterGapMs ?? 5 * 60_000,
        ...(cursorCsv.user ? { user: cursorCsv.user } : {}),
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: 'failure' as const, error }),
          onSuccess: (turns) => ({ _tag: 'success' as const, turns }),
        }),
      );
      if (turnsResult._tag === 'failure') {
        addHarnessWarning(
          'cursor',
          localHistoryWarningFromError(turnsResult.error, {
            harness: 'cursor',
            message: 'Failed to import Cursor CSV usage export',
          }),
        );
      } else {
        rows = reconcileCursorRows(rows, turnsResult.turns, {
          clusterGapMs: cursorCsv.clusterGapMs ?? 5 * 60_000,
          maxSessionSpanMs: cursorCsv.maxSessionSpanMs ?? 60 * 60_000,
          reconcileWindowMs: cursorCsv.reconcileWindowMs ?? 3 * 60_000,
        });
      }
    }

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
        status: result.status === 'failed' ? 'failed' : warnings.length ? 'warning' : 'ok',
      };
    });
    return {
      rows: publicRows,
      harnesses: publicHarnesses,
      warnings: [...publicHarnesses.flatMap((result) => result.warnings), ...globalWarnings],
      durationMs: Date.now() - startedAt,
    };
  });

export const collectSelectedHarnessRows = (selection: HarnessSelection) =>
  collectSelectedHarnessResults(selection).pipe(Effect.map((result) => result.rows));
