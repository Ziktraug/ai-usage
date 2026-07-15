import type { CursorCommitAttributionRow } from '@ai-usage/report-core/datasets';
import { Effect } from 'effect';
import type { LocalHistoryError, LocalHistoryWarning } from './errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';
import { metricValidationWarning, parseOptionalNonNegativeSafeInteger } from './metric-validation';
import { firstExisting, resolvePathCandidates } from './platform-paths';

export type CursorCommitAttribution = CursorCommitAttributionRow;

export interface HarnessFacets extends Record<string, unknown> {
  cursor?: {
    commitAttribution: CursorCommitAttribution[];
  };
}

type CursorScoredCommitRow = Record<string, unknown>;

export interface CursorCommitAttributionResult {
  rows: CursorCommitAttribution[];
  warnings: LocalHistoryWarning[];
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

const PERCENTAGE_PATTERN = /^(?:100(?:\.0+)?|\d{1,2}(?:\.\d+)?)$/;

const nullablePercentage = (value: unknown) => {
  if (value == null) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
  }
  if (typeof value !== 'string' || !PERCENTAGE_PATTERN.test(value)) {
    return;
  }
  return Number(value);
};

const scoredAtIso = (timestamp: unknown) => {
  if (timestamp == null) {
    return null;
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
    return;
  }
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

const normalizeScoredCommit = (row: CursorScoredCommitRow): CursorCommitAttribution | null => {
  const metricKeys = [
    'linesAdded',
    'linesDeleted',
    'tabLinesAdded',
    'tabLinesDeleted',
    'composerLinesAdded',
    'composerLinesDeleted',
    'humanLinesAdded',
    'humanLinesDeleted',
    'blankLinesAdded',
    'blankLinesDeleted',
  ] as const;
  const metrics = Object.fromEntries(metricKeys.map((key) => [key, parseOptionalNonNegativeSafeInteger(row[key])]));
  const scoredAt = scoredAtIso(row.scoredAt);
  const v1AiPercentage = nullablePercentage(row.v1AiPercentage);
  const v2AiPercentage = nullablePercentage(row.v2AiPercentage);
  if (
    typeof row.commitHash !== 'string' ||
    row.commitHash.length === 0 ||
    typeof row.branchName !== 'string' ||
    row.branchName.length === 0 ||
    scoredAt === undefined ||
    v1AiPercentage === undefined ||
    v2AiPercentage === undefined ||
    !Object.values(metrics).every((metric) => metric.ok)
  ) {
    return null;
  }
  const value = (key: (typeof metricKeys)[number]) => {
    const metric = metrics[key];
    return metric?.ok ? metric.value : 0;
  };
  return {
    commitHash: row.commitHash,
    branchName: row.branchName,
    scoredAt,
    commitMessage: typeof row.commitMessage === 'string' ? row.commitMessage : null,
    commitDate: typeof row.commitDate === 'string' ? row.commitDate : null,
    linesAdded: value('linesAdded'),
    linesDeleted: value('linesDeleted'),
    tabLinesAdded: value('tabLinesAdded'),
    tabLinesDeleted: value('tabLinesDeleted'),
    composerLinesAdded: value('composerLinesAdded'),
    composerLinesDeleted: value('composerLinesDeleted'),
    humanLinesAdded: value('humanLinesAdded'),
    humanLinesDeleted: value('humanLinesDeleted'),
    blankLinesAdded: value('blankLinesAdded'),
    blankLinesDeleted: value('blankLinesDeleted'),
    v1AiPercentage,
    v2AiPercentage,
  };
};

export const collectCursorCommitAttributionResult = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const dbPath = yield* firstExisting(storage, ...resolvePathCandidates(storage).cursor.aiTrackingDb);
  if (!dbPath) {
    return { rows: [], warnings: [] };
  }

  return yield* Effect.acquireUseRelease(
    storage.openDatabase(dbPath),
    (db) =>
      Effect.gen(function* () {
        const rows = yield* db.all<CursorScoredCommitRow>(CURSOR_COMMIT_ATTRIBUTION_SQL);
        const normalized = rows.map(normalizeScoredCommit);
        const rejected = normalized.filter((row) => row === null).length;
        const warning = metricValidationWarning('cursor', rejected);
        return {
          rows: normalized.filter((row): row is CursorCommitAttribution => row !== null),
          warnings: warning ? [warning] : [],
        };
      }),
    (db) => db.close,
  );
});

export const collectCursorCommitAttribution = collectCursorCommitAttributionResult.pipe(
  Effect.map((result) => result.rows),
);

export interface HarnessFacetSelection {
  includeCursor: boolean;
}

export const collectHarnessFacets = (
  selection: HarnessFacetSelection,
): Effect.Effect<HarnessFacets, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const facets: HarnessFacets = {};
    if (selection.includeCursor) {
      const commitAttribution = yield* collectCursorCommitAttribution;
      if (commitAttribution.length) {
        facets.cursor = { commitAttribution };
      }
    }
    return facets;
  });
