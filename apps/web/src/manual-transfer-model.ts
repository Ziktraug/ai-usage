import type { ManualMergeImportResult } from '@ai-usage/usage-merge';

const BYTES_PER_UNIT = 1024;
const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

export const formatTransferBytes = (bytes: number): string => {
  if (bytes < BYTES_PER_UNIT) {
    return `${bytes} B`;
  }

  let value = bytes / BYTES_PER_UNIT;
  let unitIndex = 0;
  while (value >= BYTES_PER_UNIT && unitIndex < SIZE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unitIndex += 1;
  }

  return `${value.toFixed(1)} ${SIZE_UNITS[unitIndex]}`;
};

export const formatManualImportSummary = (result: ManualMergeImportResult): string => {
  const changed = result.result.inserted + result.result.updated + result.result.superseded + result.result.deleted;
  return `Imported ${result.machine.label}: ${changed.toLocaleString()} changed, ${result.result.unchanged.toLocaleString()} unchanged.`;
};
