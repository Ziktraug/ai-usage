import type { CursorCommitAttributionRow } from '@ai-usage/report-core/datasets';
import { Effect } from 'effect';
import type { LocalHistoryError } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';
import { firstExisting, resolvePathCandidates } from './platform-paths';

export type CursorCommitAttribution = CursorCommitAttributionRow;

export interface HarnessFacets extends Record<string, unknown> {
  cursor?: {
    commitAttribution: CursorCommitAttribution[];
  };
}

interface CursorScoredCommitRow {
  blankLinesAdded: number | null;
  blankLinesDeleted: number | null;
  branchName: string;
  commitDate: string | null;
  commitHash: string;
  commitMessage: string | null;
  composerLinesAdded: number | null;
  composerLinesDeleted: number | null;
  humanLinesAdded: number | null;
  humanLinesDeleted: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  scoredAt: number | null;
  tabLinesAdded: number | null;
  tabLinesDeleted: number | null;
  v1AiPercentage: string | null;
  v2AiPercentage: string | null;
}

export const CURSOR_COMMIT_ATTRIBUTION_SQL = `
SELECT
  commitHash,
  branchName,
  scoredAt,
  linesAdded,
  linesDeleted,
  tabLinesAdded,
  tabLinesDeleted,
  composerLinesAdded,
  composerLinesDeleted,
  humanLinesAdded,
  humanLinesDeleted,
  blankLinesAdded,
  blankLinesDeleted,
  commitMessage,
  commitDate,
  v1AiPercentage,
  v2AiPercentage
FROM scored_commits
WHERE linesAdded IS NOT NULL
ORDER BY scoredAt DESC
`;

const nullableNumber = (value: string | null) => {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const scoredAtIso = (timestamp: number | null) => {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const normalizeScoredCommit = (row: CursorScoredCommitRow): CursorCommitAttribution => ({
  commitHash: row.commitHash,
  branchName: row.branchName,
  scoredAt: scoredAtIso(row.scoredAt),
  commitMessage: row.commitMessage,
  commitDate: row.commitDate,
  linesAdded: row.linesAdded ?? 0,
  linesDeleted: row.linesDeleted ?? 0,
  tabLinesAdded: row.tabLinesAdded ?? 0,
  tabLinesDeleted: row.tabLinesDeleted ?? 0,
  composerLinesAdded: row.composerLinesAdded ?? 0,
  composerLinesDeleted: row.composerLinesDeleted ?? 0,
  humanLinesAdded: row.humanLinesAdded ?? 0,
  humanLinesDeleted: row.humanLinesDeleted ?? 0,
  blankLinesAdded: row.blankLinesAdded ?? 0,
  blankLinesDeleted: row.blankLinesDeleted ?? 0,
  v1AiPercentage: nullableNumber(row.v1AiPercentage),
  v2AiPercentage: nullableNumber(row.v2AiPercentage),
});

export const collectCursorCommitAttribution = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const dbPath = yield* firstExisting(storage, ...resolvePathCandidates(storage).cursor.aiTrackingDb);
  if (!dbPath) {
    return [];
  }

  return yield* Effect.acquireUseRelease(
    storage.openDatabase(dbPath),
    (db) =>
      Effect.gen(function* () {
        const rows = yield* db.all<CursorScoredCommitRow>(CURSOR_COMMIT_ATTRIBUTION_SQL);
        return rows.map(normalizeScoredCommit);
      }),
    (db) => db.close,
  );
});

export interface HarnessFacetSelection {
  includeCursor: boolean;
}

export const collectHarnessFacets = (
  selection: HarnessFacetSelection,
): Effect.Effect<HarnessFacets, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const facets: HarnessFacets = {};
    if (selection.includeCursor) {
      const commitAttribution = yield* collectCursorCommitAttribution.pipe(Effect.catchAll(() => Effect.succeed([])));
      if (commitAttribution.length) {
        facets.cursor = { commitAttribution };
      }
    }
    return facets;
  });
