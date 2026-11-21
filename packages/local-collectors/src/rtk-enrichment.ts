import path from 'node:path';
import {
  type LocalHistoryError,
  type LocalHistoryWarning,
  localHistoryWarningFromError,
} from '@ai-usage/local-machine/errors';
import {
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-machine/local-history';
import { firstExisting, resolvePathCandidates } from '@ai-usage/local-machine/platform-paths';
import type { UsageRow, UsageRowSource, UsageRowWithOptionalSource } from '@ai-usage/report-core/types';
import { Effect } from 'effect';
import { addNonNegativeSafeIntegers, parseNonNegativeSafeInteger } from './metric-validation';
import { withPerfSpan } from './perf';

export type CollectorRow = UsageRowWithOptionalSource & {
  readonly projectPath?: string | null;
};

interface RtkCommandRow {
  input_tokens: number;
  output_tokens: number;
  project_path: string;
  saved_tokens: number;
  timestamp: string;
}

interface RtkCandidate {
  endMs: number;
  index: number;
  projectPath: string;
  startMs: number;
}

export interface CollectorRowsWithWarnings {
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

export const RTK_COMMANDS_SQL =
  'SELECT timestamp, project_path, input_tokens, output_tokens, saved_tokens FROM commands WHERE saved_tokens > 0';

const MATCH_PADDING_MS = 2 * 60_000;

export const withProjectPath = (row: UsageRow, projectPath: string | null | undefined): CollectorRow =>
  projectPath ? { ...row, projectPath } : row;

export const withSource = (row: CollectorRow, source: UsageRowSource): CollectorRow => ({
  ...row,
  source: {
    ...source,
    ...(row.projectPath && source.sourcePath === undefined ? { sourcePath: row.projectPath } : {}),
  },
});

export const stripCollectorMetadata = (row: CollectorRow): UsageRow => {
  const { projectPath: _projectPath, source: _source, ...publicRow } = row;
  return publicRow;
};

export const stripProjectPath = (row: CollectorRow): UsageRowWithOptionalSource => {
  const { projectPath: _projectPath, ...publicRow } = row;
  return publicRow;
};

const normalizeProjectPath = (projectPath: string | null | undefined) =>
  projectPath ? path.normalize(projectPath) : null;

const isSameOrNestedPath = (left: string, right: string) =>
  left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);

const rowActiveEnd = (row: Pick<UsageRow, 'date' | 'endDate'>) => row.endDate ?? row.date;

/** The part of a row the RTK match reads: where the session ran and when, padded on both sides. */
export interface RtkRowWindow {
  readonly endMs: number;
  readonly projectPath: string;
  readonly startMs: number;
}

/** Null when the row has no project path or no usable dates: no RTK command can be matched to it. */
export const rtkRowWindow = (row: Pick<CollectorRow, 'date' | 'endDate' | 'projectPath'>): RtkRowWindow | null => {
  const projectPath = normalizeProjectPath(row.projectPath);
  const start = row.date;
  const end = rowActiveEnd(row);
  if (!(projectPath && start && end)) {
    return null;
  }
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs))) {
    return null;
  }
  return {
    projectPath,
    startMs: Math.min(startMs, endMs) - MATCH_PADDING_MS,
    endMs: Math.max(startMs, endMs) + MATCH_PADDING_MS,
  };
};

const commandTime = (timestamp: string) => {
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? time : null;
};

const bestCandidateForCommand = (command: RtkCommandRow, candidates: RtkCandidate[]) => {
  const time = commandTime(command.timestamp);
  const projectPath = normalizeProjectPath(command.project_path);
  if (time == null || !projectPath) {
    return null;
  }

  const matches = candidates.filter(
    (candidate) =>
      time >= candidate.startMs && time <= candidate.endMs && isSameOrNestedPath(projectPath, candidate.projectPath),
  );
  return matches.sort((a, b) => a.endMs - a.startMs - (b.endMs - b.startMs))[0] ?? null;
};

export interface RtkSavingsTotals {
  commands: number;
  input: number;
  output: number;
  saved: number;
}

export interface RtkSavingsMatch {
  /** Totals by index into the windows given; an index without a matched command is absent. */
  totals: Map<number, RtkSavingsTotals>;
  warnings: LocalHistoryWarning[];
}

const rtkReadFailureWarning = (error: LocalHistoryError): LocalHistoryWarning =>
  localHistoryWarningFromError(error, { harness: 'rtk', message: 'Failed to read RTK enrichment history' });

/**
 * Assigns every RTK command to the narrowest window that contains it. The windows' order breaks
 * ties, so callers must pass them in the order of the rows they stand for. This is the whole
 * match: `enrichCollectorRowsWithRtkSavingsResult` only adds the totals back onto rows.
 */
export const matchRtkSavingsWindows = (
  windows: readonly (RtkRowWindow | null)[],
): Effect.Effect<RtkSavingsMatch, never, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const totals = new Map<number, RtkSavingsTotals>();
    const candidates: RtkCandidate[] = windows.flatMap((window, index) => (window ? [{ ...window, index }] : []));
    if (!candidates.length) {
      return { totals, warnings: [] };
    }
    const storage = yield* LocalHistoryStorage;
    const dbPath = yield* firstExisting(storage, ...resolvePathCandidates(storage).rtk.historyDb);
    if (!dbPath) {
      return { totals, warnings: [] };
    }

    let rejectedMetricRecords = 0;
    const readResult = yield* Effect.acquireUseRelease(
      storage.openDatabase(dbPath),
      (db) =>
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
        Effect.gen(function* () {
          for (const command of yield* db.all<RtkCommandRow>(RTK_COMMANDS_SQL)) {
            const saved = parseNonNegativeSafeInteger(command.saved_tokens);
            const input = parseNonNegativeSafeInteger(command.input_tokens);
            const output = parseNonNegativeSafeInteger(command.output_tokens);
            if (!(saved.ok && input.ok && output.ok)) {
              rejectedMetricRecords++;
              continue;
            }
            const candidate = bestCandidateForCommand(command, candidates);
            if (!candidate) {
              continue;
            }
            const current = totals.get(candidate.index) ?? { saved: 0, input: 0, output: 0, commands: 0 };
            const nextSaved = addNonNegativeSafeIntegers(current.saved, saved.value);
            const nextInput = addNonNegativeSafeIntegers(current.input, input.value);
            const nextOutput = addNonNegativeSafeIntegers(current.output, output.value);
            const nextCommands = addNonNegativeSafeIntegers(current.commands, 1);
            if (!(nextSaved.ok && nextInput.ok && nextOutput.ok && nextCommands.ok)) {
              rejectedMetricRecords++;
              continue;
            }
            current.saved = nextSaved.value;
            current.input = nextInput.value;
            current.output = nextOutput.value;
            current.commands = nextCommands.value;
            totals.set(candidate.index, current);
          }
        }),
      (db) => db.close,
    ).pipe(
      Effect.match({
        onFailure: (error: LocalHistoryError) => ({ _tag: 'failure' as const, error }),
        onSuccess: () => ({ _tag: 'success' as const }),
      }),
    );

    if (readResult._tag === 'failure') {
      // A failed read reports nothing matched, as before: partial totals are never applied.
      return { totals: new Map<number, RtkSavingsTotals>(), warnings: [rtkReadFailureWarning(readResult.error)] };
    }
    return {
      totals,
      warnings: rejectedMetricRecords
        ? [
            {
              harness: 'rtk',
              operation: 'metricValidation',
              message: `Rejected ${rejectedMetricRecords} malformed RTK metric record(s).`,
            },
          ]
        : [],
    };
  }).pipe(
    Effect.catch((error: LocalHistoryError) =>
      Effect.succeed({ totals: new Map<number, RtkSavingsTotals>(), warnings: [rtkReadFailureWarning(error)] }),
    ),
  );

export const enrichCollectorRowsWithRtkSavingsResult = (
  rows: CollectorRow[],
): Effect.Effect<CollectorRowsWithWarnings, never, LocalHistoryStorageService> =>
  withPerfSpan(
    'aiUsage.enrich.rtk',
    Effect.gen(function* () {
      if (!rows.length) {
        return { rows, warnings: [] };
      }
      const { totals, warnings } = yield* matchRtkSavingsWindows(rows.map(rtkRowWindow));
      if (!totals.size) {
        return { rows, warnings };
      }
      return {
        rows: rows.map((row, index) => {
          const total = totals.get(index);
          if (!total || total.saved <= 0) {
            return row;
          }
          return {
            ...row,
            rtkSavedTokens: total.saved,
            rtkInputTokens: total.input,
            rtkOutputTokens: total.output,
            rtkCommandCount: total.commands,
          };
        }),
        warnings,
      };
    }),
    (result) => ({
      matchedRows: result.rows.filter((row) => row.rtkSavedTokens).length,
      rows: result.rows.length,
      warnings: result.warnings.length,
    }),
  );

export const enrichCollectorRowsWithRtkSavings = (
  rows: CollectorRow[],
): Effect.Effect<CollectorRow[], never, LocalHistoryStorageService> =>
  enrichCollectorRowsWithRtkSavingsResult(rows).pipe(Effect.map((result) => result.rows));
