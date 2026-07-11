import { describe, expect, test } from 'bun:test';
import { serializedRowsToCSV, usageRowCsvColumns } from './csv';
import { serializeUsageRow } from './report-data';
import type { UsageRow } from './types';

const baseRow: UsageRow = {
  date: new Date('2026-06-01T10:00:00.000Z'),
  endDate: new Date('2026-06-01T10:30:00.000Z'),
  harness: 'Claude Code',
  provider: 'Claude API',
  name: 'session-1',
  model: 'claude-opus',
  project: 'ai-usage',
  tokIn: 100,
  tokOut: 50,
  tokCr: 10,
  tokCw: 5,
  costActual: null,
  costApprox: 1.234_56,
  costKnown: true,
  calls: 3,
  durationMs: null,
  turns: 7,
  tools: 2,
  linesAdded: 12,
  linesDeleted: 4,
};

describe('usage row CSV projection', () => {
  test('is the single column source: header has every column once', () => {
    const csv = serializedRowsToCSV([serializeUsageRow(baseRow)]);
    const header = csv.split('\n')[0]?.split(',');
    expect(header).toEqual(usageRowCsvColumns.map((column) => column.header));
    expect(header).toContain('fresh_tokens');
    expect(header).toContain('line_delta');
  });

  test('escapes commas, quotes, and newlines in cell values', () => {
    const csv = serializedRowsToCSV([serializeUsageRow({ ...baseRow, name: 'a, "quoted"\nsession' })]);
    const body = csv.split('\n').slice(1).join('\n');
    expect(body).toContain('"a, ""quoted""\nsession"');
  });

  test('formats cost and renders nullable cells as empty strings', () => {
    const csv = serializedRowsToCSV([serializeUsageRow(baseRow)]);
    const cells = csv.split('\n')[1]?.split(',') ?? [];
    const approxIndex = usageRowCsvColumns.findIndex((column) => column.header === 'cost_approx_api');
    const durationIndex = usageRowCsvColumns.findIndex((column) => column.header === 'duration_ms');
    expect(cells[approxIndex]).toBe('1.2346');
    expect(cells[durationIndex]).toBe('');
  });

  test('neutralizes spreadsheet formulas in textual cells without changing numeric cells', () => {
    const serialized = serializeUsageRow({
      ...baseRow,
      costActual: -1,
      costApprox: -1,
      harness: '-dangerous-harness',
      models: ['@SUM(A1:A2)'],
      name: '=HYPERLINK("https://example.test")',
      project: '+cmd',
    });
    const cells = serializedRowsToCSV([serialized]).split('\n')[1]?.split(',') ?? [];
    const cellFor = (header: (typeof usageRowCsvColumns)[number]['header']) =>
      cells[usageRowCsvColumns.findIndex((column) => column.header === header)];

    expect(cellFor('harness')).toBe("'-dangerous-harness");
    expect(cellFor('models')).toBe("'@SUM(A1:A2)");
    expect(cellFor('project')).toBe("'+cmd");
    expect(cellFor('session')).toStartWith('"\'=HYPERLINK');
    expect(cellFor('cost_actual')).toBe('-1');
    expect(cellFor('cost_approx_api')).toBe('-1.0000');
  });
});
