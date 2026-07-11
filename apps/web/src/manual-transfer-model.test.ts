import { expect, test } from 'bun:test';
import type { ManualMergeImportResult } from '@ai-usage/usage-merge';
import { formatManualImportSummary, formatTransferBytes } from './manual-transfer-model';

test('formats manual transfer sizes for upload progress', () => {
  expect(formatTransferBytes(0)).toBe('0 B');
  expect(formatTransferBytes(1023)).toBe('1023 B');
  expect(formatTransferBytes(1024)).toBe('1.0 KB');
  expect(formatTransferBytes(1_572_864)).toBe('1.5 MB');
});

test('summarizes changed and unchanged usage rows after a manual import', () => {
  const result: ManualMergeImportResult = {
    generatedAt: '2026-07-11T12:00:00.000Z',
    machine: { id: 'studio-mac', label: 'Studio Mac' },
    result: {
      deleted: 5,
      inserted: 2,
      superseded: 4,
      unchanged: 6,
      updated: 3,
      warnings: 0,
    },
    rows: 20,
    warnings: 0,
  };

  expect(formatManualImportSummary(result)).toBe('Imported Studio Mac: 14 changed, 6 unchanged.');
});
