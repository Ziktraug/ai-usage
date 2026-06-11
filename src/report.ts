import type { Args, SortKey } from './cli';
import { lineTrackingHarnessLabels, nonLineTrackingHarnessLabels, reportHarnessNotes } from './harness-metadata';
import { renderAnalytics } from './render/analytics';
import { clr } from './render/colors';
import { renderCSV } from './render/csv';
import { renderTable } from './render/table';
import type { Row } from './types';
import { usageRowActiveDate, usageRowTokenTotal } from './usage-row';

export interface PreparedUsageReport {
  rows: Row[];
  tableRows: Row[];
  omittedRows: number;
}

export const compareUsageRows = (sort: SortKey) =>
  ({
    date: (a: Row, b: Row) => (usageRowActiveDate(b)?.getTime() ?? 0) - (usageRowActiveDate(a)?.getTime() ?? 0),
    tokens: (a: Row, b: Row) => usageRowTokenTotal(b) - usageRowTokenTotal(a),
    cost: (a: Row, b: Row) => b.costApprox - a.costApprox,
  })[sort];

export const filterUsageRows = (rows: Row[], args: Args) =>
  rows.filter((row) => {
    const activeAt = usageRowActiveDate(row);
    if (usageRowTokenTotal(row) < args.minTokens) return false;
    if (args.since && (!activeAt || activeAt < args.since)) return false;
    if (args.project && !row.project.toLowerCase().includes(args.project)) return false;
    return true;
  });

export const prepareUsageReport = (rows: Row[], args: Args): PreparedUsageReport => {
  const filteredRows = filterUsageRows(rows, args).sort(compareUsageRows(args.sort));
  const tableRows = args.limit ? filteredRows.slice(0, args.limit) : filteredRows;
  return {
    rows: filteredRows,
    tableRows,
    omittedRows: filteredRows.length - tableRows.length,
  };
};

const renderReportNotes = () => {
  const lineHarnesses = lineTrackingHarnessLabels().join('/');
  const nonLineHarnesses = nonLineTrackingHarnessLabels().join('/');
  const notes = [
    ...reportHarnessNotes(),
    '↳ = contains sub-agents.',
    `Tracked lines: ${lineHarnesses} only (${nonLineHarnesses} expose none locally).`,
    '$API = hypothetical cost at current API rates (subscriptions bill differently); ? = no public rate.',
  ];

  return clr.dim(`\nNotes: ${notes.join(' ')}`);
};

export const renderUsageReport = (rows: Row[], args: Args) => {
  const report = prepareUsageReport(rows, args);

  if (args.json) return JSON.stringify(report.rows, null, 2);
  if (args.csv) return renderCSV(report.rows);

  const output = [renderTable(report.tableRows, args.wide)];
  if (report.omittedRows > 0) {
    output.push(clr.dim(`  … ${report.omittedRows} more rows (analytics below cover all ${report.rows.length})`));
  }
  output.push(renderAnalytics(report.rows));
  output.push(renderReportNotes());
  return output.join('\n');
};
