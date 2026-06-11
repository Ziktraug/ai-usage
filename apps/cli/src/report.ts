import {
  lineTrackingHarnessLabels,
  nonLineTrackingHarnessLabels,
  reportHarnessNotes,
} from '@ai-usage/core/harness-metadata';
import { createUsageReportPayload, type PreparedUsageReport, prepareUsageReport } from '@ai-usage/core/report-data';
import type { Row } from '@ai-usage/core/types';
import type { Args } from './cli';
import { renderAnalytics } from './render/analytics';
import { clr } from './render/colors';
import { renderCSV } from './render/csv';
import { renderReportAppHTML } from './render/html';
import { renderTable } from './render/table';

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

const renderTerminalReport = (report: PreparedUsageReport, args: Args) => {
  const output = [renderTable(report.tableRows, args.wide)];
  if (report.omittedRows > 0) {
    output.push(clr.dim(`  … ${report.omittedRows} more rows (analytics below cover all ${report.rows.length})`));
  }
  output.push(renderAnalytics(report.rows));
  output.push(renderReportNotes());
  return output.join('\n');
};

export const renderUsageReport = (rows: Row[], args: Args) => {
  const report = prepareUsageReport(rows, args);

  if (args.format === 'json') return JSON.stringify(report.rows, null, 2);
  if (args.format === 'csv') return renderCSV(report.rows);
  if (args.format === 'html') return renderReportAppHTML(createUsageReportPayload(report, args));

  return renderTerminalReport(report, args);
};

export { prepareUsageReport };
