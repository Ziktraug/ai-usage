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
