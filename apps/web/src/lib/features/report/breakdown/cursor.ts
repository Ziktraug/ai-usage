import type { CursorCommitAttributionFacet } from '../../../../report-data';

export interface CursorAiPercentageSummary {
  readonly measuredCommits: number;
  readonly percentage: number | null;
  readonly totalCommits: number;
}

export const summarizeCursorAiPercentage = (
  rows: readonly CursorCommitAttributionFacet[],
): CursorAiPercentageSummary => {
  const commits = new Map<string, { lineTotals: Set<number>; percentages: Set<number> }>();
  for (const row of rows) {
    const commit = commits.get(row.commitHash) ?? { lineTotals: new Set<number>(), percentages: new Set<number>() };
    if (row.v2AiPercentage !== null) {
      commit.percentages.add(row.v2AiPercentage);
    }
    commit.lineTotals.add(row.linesAdded + row.linesDeleted);
    commits.set(row.commitHash, commit);
  }
  let measuredCommits = 0;
  let totalWeight = 0;
  let weightedPercentage = 0;
  for (const commit of commits.values()) {
    if (commit.percentages.size !== 1 || commit.lineTotals.size !== 1) {
      continue;
    }
    const percentage = commit.percentages.values().next().value;
    const weight = commit.lineTotals.values().next().value;
    if (percentage === undefined || weight === undefined || weight <= 0) {
      continue;
    }
    measuredCommits += 1;
    totalWeight += weight;
    weightedPercentage += percentage * weight;
  }
  return {
    measuredCommits,
    percentage: totalWeight > 0 ? weightedPercentage / totalWeight : null,
    totalCommits: commits.size,
  };
};

export const CURSOR_COMMIT_METRIC_KEYS = [
  'blankLinesAdded',
  'blankLinesDeleted',
  'composerLinesAdded',
  'composerLinesDeleted',
  'humanLinesAdded',
  'humanLinesDeleted',
  'linesAdded',
  'linesDeleted',
  'tabLinesAdded',
  'tabLinesDeleted',
  'v1AiPercentage',
  'v2AiPercentage',
] as const;

export type CursorCommitMetrics = Pick<CursorCommitAttributionFacet, (typeof CURSOR_COMMIT_METRIC_KEYS)[number]>;

export type CursorCommitDateSource = 'commit' | 'none' | 'scored';

export interface CursorCommitActivity {
  readonly source: CursorCommitDateSource;
  /** Epoch milliseconds, or null when the row carries no usable date at all. */
  readonly time: number | null;
}

/**
 * The one date rule for Cursor attribution: the git commit date when it parses,
 * the Cursor scoring time when it does not, and nothing when neither exists.
 * Never throws — `Date.parse` of an absent or malformed value yields NaN.
 */
export const cursorCommitActivity = (
  row: Pick<CursorCommitAttributionFacet, 'commitDate' | 'scoredAt'>,
): CursorCommitActivity => {
  const commitTime = Date.parse(row.commitDate ?? '');
  if (Number.isFinite(commitTime)) {
    return { source: 'commit', time: commitTime };
  }
  const scoredTime = Date.parse(row.scoredAt ?? '');
  if (Number.isFinite(scoredTime)) {
    return { source: 'scored', time: scoredTime };
  }
  return { source: 'none', time: null };
};

export interface CursorCommitRange {
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Inclusive on both bounds, exactly like the session range predicate. Rows with
 * no usable date are kept under every range — a filter default never excludes
 * "unknown".
 */
export const cursorRowsInRange = <Row extends Pick<CursorCommitAttributionFacet, 'commitDate' | 'scoredAt'>>(
  rows: readonly Row[],
  range: CursorCommitRange,
): Row[] => {
  const from = range.from === null ? null : Date.parse(range.from);
  const to = range.to === null ? null : Date.parse(range.to);
  const withinRange = (row: Row): boolean => {
    const { time } = cursorCommitActivity(row);
    if (time === null) {
      return true;
    }
    return (from === null || time >= from) && (to === null || time <= to);
  };
  return rows.filter(withinRange);
};

export interface CursorCommitGroup {
  /** Distinct branch names the merged rows were observed on, ascending. */
  readonly branches: readonly string[];
  readonly commitHash: string;
  readonly commitMessage: string | null;
  /**
   * ISO instant of the group's activity: the earliest commit date among the
   * merged rows, or the earliest scoring time when none of them stored a commit
   * date, or null when neither exists.
   */
  readonly date: string | null;
  readonly dateSource: CursorCommitDateSource;
  /**
   * Render identity: `${commitHash}:${branches}:${metric signature}`. The metric
   * signature belongs in the key because it is part of the group identity: the
   * same commit on the same branch can be stored twice with different numbers
   * (the store's primary key includes `machine_id`, the collector's item key
   * does not), and those two groups must not collide in a keyed `{#each}`.
   */
  readonly key: string;
  readonly metrics: CursorCommitMetrics;
  /** Branch rows merged into this group. */
  readonly rowCount: number;
  /** Distinct Cursor scoring instants, ascending. */
  readonly scoredAt: readonly string[];
}

interface CursorCommitGroupDraft {
  readonly branches: Set<string>;
  readonly commitHash: string;
  commitMessage: string | null;
  readonly metrics: CursorCommitMetrics;
  rowCount: number;
  readonly scoredAt: Set<string>;
  readonly signature: string;
  source: CursorCommitDateSource;
  time: number | null;
}

const cursorCommitMetrics = (row: CursorCommitAttributionFacet): CursorCommitMetrics => ({
  blankLinesAdded: row.blankLinesAdded,
  blankLinesDeleted: row.blankLinesDeleted,
  composerLinesAdded: row.composerLinesAdded,
  composerLinesDeleted: row.composerLinesDeleted,
  humanLinesAdded: row.humanLinesAdded,
  humanLinesDeleted: row.humanLinesDeleted,
  linesAdded: row.linesAdded,
  linesDeleted: row.linesDeleted,
  tabLinesAdded: row.tabLinesAdded,
  tabLinesDeleted: row.tabLinesDeleted,
  v1AiPercentage: row.v1AiPercentage,
  v2AiPercentage: row.v2AiPercentage,
});

const cursorCommitMetricSignature = (row: CursorCommitAttributionFacet): string =>
  JSON.stringify(CURSOR_COMMIT_METRIC_KEYS.map((key) => row[key]));

const cursorCommitGroupKey = (row: CursorCommitAttributionFacet, signature: string): string =>
  `${row.commitHash} ${signature}`;

const draftFromRow = (row: CursorCommitAttributionFacet, signature: string): CursorCommitGroupDraft => ({
  branches: new Set<string>(),
  commitHash: row.commitHash,
  commitMessage: null,
  metrics: cursorCommitMetrics(row),
  rowCount: 0,
  scoredAt: new Set<string>(),
  signature,
  source: 'none',
  time: null,
});

const groupFromDraft = (draft: CursorCommitGroupDraft): CursorCommitGroup => {
  const branches = [...draft.branches].sort();
  return {
    branches,
    commitHash: draft.commitHash,
    commitMessage: draft.commitMessage,
    date: draft.time === null ? null : new Date(draft.time).toISOString(),
    dateSource: draft.source,
    key: `${draft.commitHash}:${branches.join(',')}:${draft.signature}`,
    metrics: draft.metrics,
    rowCount: draft.rowCount,
    scoredAt: [...draft.scoredAt].sort(),
  };
};

/**
 * Higher wins. A real git commit date from ANY merged row outranks a scoring
 * fallback from any other row: the group's date rule must be the same rule the
 * panel states to the reader ("the scoring time is shown when Cursor stored no
 * commit date"), and that claim is about the whole group, not about whichever
 * branch row happened to be earliest.
 */
const cursorDateSourceRank: Record<CursorCommitDateSource, number> = { commit: 2, none: 0, scored: 1 };

const outranksDraftActivity = (draft: CursorCommitGroupDraft, activity: CursorCommitActivity): boolean => {
  const draftRank = cursorDateSourceRank[draft.source];
  const activityRank = cursorDateSourceRank[activity.source];
  if (activityRank !== draftRank) {
    return activityRank > draftRank;
  }
  return activity.time !== null && draft.time !== null && activity.time < draft.time;
};

const compareCursorCommitGroups = (left: CursorCommitGroup, right: CursorCommitGroup): number => {
  const leftTime = left.date === null ? null : Date.parse(left.date);
  const rightTime = right.date === null ? null : Date.parse(right.date);
  if (leftTime === null && rightTime !== null) {
    return 1;
  }
  if (leftTime !== null && rightTime === null) {
    return -1;
  }
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (left.commitHash !== right.commitHash) {
    return left.commitHash < right.commitHash ? -1 : 1;
  }
  if (left.key === right.key) {
    return 0;
  }
  return left.key < right.key ? -1 : 1;
};

/**
 * Folds Cursor's per-branch rows into one row per commit. Branch rows of the
 * same commit that disagree on any metric stay apart — never average, never
 * pick one. The group's date is the earliest git commit date among the merged
 * rows, and only falls back to the earliest scoring time when NO merged row
 * carries a commit date. Order is commit date descending, undated last, then
 * commit hash, then the joined branch list.
 */
export const groupCursorCommits = (rows: readonly CursorCommitAttributionFacet[]): CursorCommitGroup[] => {
  const drafts = new Map<string, CursorCommitGroupDraft>();
  for (const row of rows) {
    const signature = cursorCommitMetricSignature(row);
    const key = cursorCommitGroupKey(row, signature);
    const draft = drafts.get(key) ?? draftFromRow(row, signature);
    draft.branches.add(row.branchName);
    draft.rowCount += 1;
    // The message is a property of the commit hash, so merged rows are expected to agree; a row
    // that stored none contributes nothing. Should two rows genuinely disagree, the smallest string
    // wins so the render is stable — stored rows arrive in SHA-256 item-key order, so "first
    // non-null" would pick a different message on different reads.
    if (row.commitMessage !== null && (draft.commitMessage === null || row.commitMessage < draft.commitMessage)) {
      draft.commitMessage = row.commitMessage;
    }
    if (row.scoredAt !== null) {
      draft.scoredAt.add(row.scoredAt);
    }
    const activity = cursorCommitActivity(row);
    if (outranksDraftActivity(draft, activity)) {
      draft.source = activity.source;
      draft.time = activity.time;
    }
    drafts.set(key, draft);
  }
  const groups: CursorCommitGroup[] = [];
  for (const draft of drafts.values()) {
    groups.push(groupFromDraft(draft));
  }
  groups.sort(compareCursorCommitGroups);
  return groups;
};
