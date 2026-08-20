import { describe, expect, test } from 'bun:test';
import { usageRowCsvColumns } from '@ai-usage/report-core/csv';
import { createSessionsExport, sessionsExportScopeLabel } from './dashboard-breakdown-export';
import { syntheticSessionRow } from './lib/features/sessions/table/session-table.fixtures';

const GENERATED_AT = '2026-08-20T18:45:00.000Z';
const sharedHeader = usageRowCsvColumns.map((column) => column.header).join(',');

describe('sessions CSV export adapter', () => {
  test('emits the shared usage-row header and one line per loaded row', async () => {
    const rows = [syntheticSessionRow(1), syntheticSessionRow(2)];
    const { csv, filename } = await createSessionsExport(GENERATED_AT, rows);
    const lines = csv.split('\n');

    expect(lines[0]).toBe(sharedHeader);
    expect(lines).toHaveLength(3);
    expect(filename).toBe('ai-usage-sessions-2026-08-20.csv');
  });

  test('exports a header-only file when no rows are loaded', async () => {
    const { csv } = await createSessionsExport(GENERATED_AT, []);

    expect(csv).toBe(sharedHeader);
  });

  test('keeps the shared projection formula neutralization instead of forking escaping', async () => {
    const dangerous = { ...syntheticSessionRow(3), name: '=HYPERLINK("https://example.test")', project: '+cmd' };
    const { csv } = await createSessionsExport(GENERATED_AT, [dangerous]);
    const cells = csv.split('\n')[1]?.split(',') ?? [];
    const cellFor = (header: (typeof usageRowCsvColumns)[number]['header']): string | undefined =>
      cells[usageRowCsvColumns.findIndex((column) => column.header === header)];

    expect(cellFor('session')).toStartWith('"\'=HYPERLINK');
    expect(cellFor('project')).toBe("'+cmd");
  });

  test('states the loaded bound, the filtered total, and the campaign aggregation in one sentence', () => {
    expect(sessionsExportScopeLabel(1234, 56_789)).toBe(
      `Exports the ${(1234).toLocaleString()} loaded of ${(56_789).toLocaleString()} filtered sessions, campaigns as one aggregated row`,
    );
    expect(sessionsExportScopeLabel(0, 0)).toContain('0 loaded of 0 filtered sessions');
  });
});
