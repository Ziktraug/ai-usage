import type { ProviderStatusDataset } from './provider-status';
import type { CollectionSourceId } from './source-control';

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

export const normalizedDatasetKeys = ['cursor.commit-attribution'] as const;

export type NormalizedDatasetKey = (typeof normalizedDatasetKeys)[number];

export interface CursorCommitAttributionDatasetItem {
  readonly datasetKey: 'cursor.commit-attribution';
  readonly itemKey: string;
  readonly machineId: string;
  readonly payload: CursorCommitAttributionRow;
  readonly schemaVersion: 1;
  readonly sourceId: 'cursor.commit-attribution';
}

export type NormalizedDatasetItem = CursorCommitAttributionDatasetItem;

const normalizedDatasetItemKeys = new Set([
  'datasetKey',
  'itemKey',
  'machineId',
  'payload',
  'schemaVersion',
  'sourceId',
]);

const maxDatasetIdentityLength = 256;

const isBoundedIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxDatasetIdentityLength;

export const isNormalizedDatasetItem = (value: unknown): value is NormalizedDatasetItem => {
  if (!(isRecord(value) && hasOnlyKeys(value, normalizedDatasetItemKeys))) {
    return false;
  }
  return (
    value.sourceId === 'cursor.commit-attribution' &&
    value.datasetKey === 'cursor.commit-attribution' &&
    value.schemaVersion === 1 &&
    isBoundedIdentity(value.machineId) &&
    isBoundedIdentity(value.itemKey) &&
    isCursorCommitAttributionRow(value.payload)
  );
};

export const isNormalizedDatasetIdentity = (input: {
  datasetKey: unknown;
  schemaVersion: unknown;
  sourceId: unknown;
}): input is {
  datasetKey: NormalizedDatasetKey;
  schemaVersion: 1;
  sourceId: CollectionSourceId;
} =>
  input.sourceId === 'cursor.commit-attribution' &&
  input.datasetKey === 'cursor.commit-attribution' &&
  input.schemaVersion === 1;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const CURSOR_COMMIT_ATTRIBUTION_KEYS = new Set([
  'blankLinesAdded',
  'blankLinesDeleted',
  'branchName',
  'commitDate',
  'commitHash',
  'commitMessage',
  'composerLinesAdded',
  'composerLinesDeleted',
  'humanLinesAdded',
  'humanLinesDeleted',
  'linesAdded',
  'linesDeleted',
  'scoredAt',
  'tabLinesAdded',
  'tabLinesDeleted',
  'v1AiPercentage',
  'v2AiPercentage',
]);

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isNullablePercentage = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
const isNonNegativeSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isStrictIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};
const isNullableStrictIsoTimestamp = (value: unknown): value is string | null =>
  value === null || isStrictIsoTimestamp(value);
const isNullableParseableTimestamp = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)));
const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

export const isCursorCommitAttributionRow = (value: unknown): value is CursorCommitAttributionRow => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasOnlyKeys(value, CURSOR_COMMIT_ATTRIBUTION_KEYS) &&
    typeof value.commitHash === 'string' &&
    value.commitHash.length > 0 &&
    typeof value.branchName === 'string' &&
    value.branchName.length > 0 &&
    isNullableStrictIsoTimestamp(value.scoredAt) &&
    isNullableString(value.commitMessage) &&
    isNullableParseableTimestamp(value.commitDate) &&
    isNonNegativeSafeInteger(value.linesAdded) &&
    isNonNegativeSafeInteger(value.linesDeleted) &&
    isNonNegativeSafeInteger(value.tabLinesAdded) &&
    isNonNegativeSafeInteger(value.tabLinesDeleted) &&
    isNonNegativeSafeInteger(value.composerLinesAdded) &&
    isNonNegativeSafeInteger(value.composerLinesDeleted) &&
    isNonNegativeSafeInteger(value.humanLinesAdded) &&
    isNonNegativeSafeInteger(value.humanLinesDeleted) &&
    isNonNegativeSafeInteger(value.blankLinesAdded) &&
    isNonNegativeSafeInteger(value.blankLinesDeleted) &&
    isNullablePercentage(value.v1AiPercentage) &&
    isNullablePercentage(value.v2AiPercentage)
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
