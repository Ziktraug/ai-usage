import path from 'node:path';
import type { UsageRow, UsageRowSource, UsageRowWithOptionalSource } from '@ai-usage/core/types';
import { Effect } from 'effect';
import type { LocalHistoryError } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';
import { firstExisting, resolvePathCandidates } from './platform-paths';

export type CollectorRow = UsageRowWithOptionalSource & {
  readonly projectPath?: string | null;
};

type RtkCommandRow = {
  timestamp: string;
  project_path: string;
  input_tokens: number;
  output_tokens: number;
  saved_tokens: number;
};

type RtkCandidate = {
  index: number;
  projectPath: string;
  startMs: number;
  endMs: number;
};

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

const rowActiveEnd = (row: UsageRow) => row.endDate ?? row.date;

const candidatesForRows = (rows: CollectorRow[]): RtkCandidate[] =>
  rows.flatMap((row, index) => {
    const projectPath = normalizeProjectPath(row.projectPath);
    const start = row.date;
    const end = rowActiveEnd(row);
    if (!projectPath || !start || !end) return [];
    const startMs = start.getTime();
    const endMs = end.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    return [
      {
        index,
        projectPath,
        startMs: Math.min(startMs, endMs) - MATCH_PADDING_MS,
        endMs: Math.max(startMs, endMs) + MATCH_PADDING_MS,
      },
    ];
  });

const commandTime = (timestamp: string) => {
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? time : null;
};

const bestCandidateForCommand = (command: RtkCommandRow, candidates: RtkCandidate[]) => {
  const time = commandTime(command.timestamp);
  const projectPath = normalizeProjectPath(command.project_path);
  if (time == null || !projectPath) return null;

  const matches = candidates.filter(
    (candidate) =>
      time >= candidate.startMs && time <= candidate.endMs && isSameOrNestedPath(projectPath, candidate.projectPath),
  );
  return matches.sort((a, b) => a.endMs - a.startMs - (b.endMs - b.startMs))[0] ?? null;
};

export const enrichCollectorRowsWithRtkSavings = (
  rows: CollectorRow[],
): Effect.Effect<CollectorRow[], never, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    if (!rows.length) return rows;
    const storage = yield* LocalHistoryStorage;
    const dbPath = yield* firstExisting(storage, ...resolvePathCandidates(storage).rtk.historyDb);
    if (!dbPath) return rows;

    const candidates = candidatesForRows(rows);
    if (!candidates.length) return rows;

    const totals = new Map<number, { saved: number; input: number; output: number; commands: number }>();
    yield* Effect.acquireUseRelease(
      storage.openDatabase(dbPath),
      (db) =>
        Effect.gen(function* () {
          for (const command of yield* db.all<RtkCommandRow>(RTK_COMMANDS_SQL)) {
            const candidate = bestCandidateForCommand(command, candidates);
            if (!candidate) continue;
            const current = totals.get(candidate.index) ?? { saved: 0, input: 0, output: 0, commands: 0 };
            current.saved += Number(command.saved_tokens) || 0;
            current.input += Number(command.input_tokens) || 0;
            current.output += Number(command.output_tokens) || 0;
            current.commands++;
            totals.set(candidate.index, current);
          }
        }),
      (db) => db.close,
    ).pipe(Effect.catchAll((_error: LocalHistoryError) => Effect.void));

    if (!totals.size) return rows;
    return rows.map((row, index) => {
      const total = totals.get(index);
      if (!total || total.saved <= 0) return row;
      return {
        ...row,
        rtkSavedTokens: total.saved,
        rtkInputTokens: total.input,
        rtkOutputTokens: total.output,
        rtkCommandCount: total.commands,
      };
    });
  }).pipe(Effect.catchAll(() => Effect.succeed(rows)));
