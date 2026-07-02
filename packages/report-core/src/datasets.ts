import type { ProviderStatusDataset } from './provider-status';

export interface CursorCommitAttributionRow {
  blankLinesAdded: number;
  blankLinesDeleted: number;
  branchName: string;
  commitDate: string | null;
  commitHash: string;
  commitMessage: string | null;
  composerLinesAdded: number;
  composerLinesDeleted: number;
  humanLinesAdded: number;
  humanLinesDeleted: number;
  linesAdded: number;
  linesDeleted: number;
  scoredAt: string | null;
  tabLinesAdded: number;
  tabLinesDeleted: number;
  v1AiPercentage: number | null;
  v2AiPercentage: number | null;
}

export interface ReportDatasets extends Record<string, unknown> {
  cursorCommitAttribution?: CursorCommitAttributionRow[];
  providerStatus?: ProviderStatusDataset;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isNullableNumber = (value: unknown): value is number | null => value === null || typeof value === 'number';

export const isCursorCommitAttributionRow = (value: unknown): value is CursorCommitAttributionRow => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.commitHash === 'string' &&
    typeof value.branchName === 'string' &&
    isNullableString(value.scoredAt) &&
    isNullableString(value.commitMessage) &&
    isNullableString(value.commitDate) &&
    typeof value.linesAdded === 'number' &&
    typeof value.linesDeleted === 'number' &&
    typeof value.tabLinesAdded === 'number' &&
    typeof value.tabLinesDeleted === 'number' &&
    typeof value.composerLinesAdded === 'number' &&
    typeof value.composerLinesDeleted === 'number' &&
    typeof value.humanLinesAdded === 'number' &&
    typeof value.humanLinesDeleted === 'number' &&
    typeof value.blankLinesAdded === 'number' &&
    typeof value.blankLinesDeleted === 'number' &&
    isNullableNumber(value.v1AiPercentage) &&
    isNullableNumber(value.v2AiPercentage)
  );
};

export const parseReportDatasets = (value: unknown): ReportDatasets | undefined => {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const datasets: ReportDatasets = { ...value };
  const cursorCommitAttribution = value.cursorCommitAttribution;
  if (cursorCommitAttribution !== undefined) {
    datasets.cursorCommitAttribution = Array.isArray(cursorCommitAttribution)
      ? cursorCommitAttribution.filter(isCursorCommitAttributionRow)
      : [];
  }
  return datasets;
};
