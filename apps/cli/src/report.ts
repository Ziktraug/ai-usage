import {
  lineTrackingHarnessLabels,
  nonLineTrackingHarnessLabels,
  reportHarnessNotes,
} from '@ai-usage/core/harness-metadata';
import {
  createUsageReportPayload,
  type PreparedUsageReport,
  prepareUsageReport,
  type UsageReportPayload,
} from '@ai-usage/core/report-data';
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
    '↳ = sub-agent session or parent with child sub-agents.',
    '? = Cursor CSV reconciliation was ambiguous; totals are best-effort.',
    'usage unavailable = session found in prompt history, but detailed local token counters are missing.',
    `Tracked lines: ${lineHarnesses} only (${nonLineHarnesses} expose none locally).`,
    'RTK = saved-token percentage from RTK commands matched by project path and session time window.',
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

export const renderUsageReport = (rows: Row[], args: Args, facets?: Record<string, unknown>) => {
  const report = prepareUsageReport(rows, args);

  if (args.format === 'json') return JSON.stringify(report.rows, null, 2);
  if (args.format === 'csv') return renderCSV(report.rows);
  if (args.format === 'html') return renderTerminalReport(report, args);
  if (args.format === 'payload') return JSON.stringify(createUsageReportPayload(report, args, new Date(), facets));

  return renderTerminalReport(report, args);
};

export const renderUsageReportForCli = async (rows: Row[], args: Args, facets?: Record<string, unknown>) => {
  const report = prepareUsageReport(rows, args);
  if (args.format === 'html') return renderReportAppHTML(createUsageReportPayload(report, args, new Date(), facets));
  return renderUsageReport(rows, args, facets);
};

export const renderUsagePayloadForCli = async (payload: UsageReportPayload, args: Args) => {
  if (args.format === 'html') return renderReportAppHTML(payload);
  return JSON.stringify(payload);
};

export { prepareUsageReport };
