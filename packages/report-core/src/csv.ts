import type { AnalyticsGroup } from './analytics';
import type { SerializedRow } from './report-data';

const CSV_ESCAPE_REQUIRED = /[",\r\n]/;
const CSV_QUOTE = /"/g;
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

const csvEscape = (value: string) => (CSV_ESCAPE_REQUIRED.test(value) ? `"${value.replace(CSV_QUOTE, '""')}"` : value);

const csvCell = (value: unknown, textual: boolean) => {
  const text = String(value);
  return csvEscape(textual && CSV_FORMULA_PREFIX.test(text) ? `'${text}` : text);
};

export const rtkSavingsPct = (row: Pick<SerializedRow, 'rtkInputTokens' | 'rtkSavedTokens'>) =>
  row.rtkSavedTokens && row.rtkInputTokens ? (row.rtkSavedTokens / row.rtkInputTokens) * 100 : null;

/**
 * The single source of truth for the usage row → CSV projection. Both the CLI
 * and raw-row consumers feed it serialized rows. Campaign aggregates deliberately
 * do not use this projection: a campaign display row is not a real usage row.
 */
export const usageRowCsvColumns = [
  { header: 'date', textual: true, value: (row) => row.date },
  { header: 'end_date', textual: true, value: (row) => row.endDate },
  { header: 'active_date', textual: true, value: (row) => row.activeDate },
  { header: 'harness', textual: true, value: (row) => row.harness },
  { header: 'machine', textual: true, value: (row) => row.source?.machineLabel },
  { header: 'machine_id', textual: true, value: (row) => row.source?.machineId },
  { header: 'provider', textual: true, value: (row) => row.provider },
  { header: 'session', textual: true, value: (row) => row.name },
  { header: 'model', textual: true, value: (row) => row.model },
  { header: 'models', textual: true, value: (row) => row.models?.join('|') },
  { header: 'project', textual: true, value: (row) => row.project },
  { header: 'input', value: (row) => row.tokIn },
  { header: 'output', value: (row) => row.tokOut },
  { header: 'cache_read', value: (row) => row.tokCr },
  { header: 'cache_write', value: (row) => row.tokCw },
  { header: 'fresh_tokens', value: (row) => row.freshTokens },
  { header: 'total_tokens', value: (row) => row.tokenTotal },
  { header: 'cost_actual', value: (row) => row.costActual },
  { header: 'cost_quota', value: (row) => row.costQuota },
  { header: 'cost_approx_api', value: (row) => row.costApprox.toFixed(4) },
  { header: 'cost_known', value: (row) => row.costKnown },
  { header: 'calls', value: (row) => row.calls },
  { header: 'duration_ms', value: (row) => row.durationMs },
  { header: 'turns', value: (row) => row.turns },
  { header: 'tools', value: (row) => row.tools },
  { header: 'lines_added', value: (row) => row.linesAdded },
  { header: 'lines_deleted', value: (row) => row.linesDeleted },
  { header: 'line_delta', value: (row) => row.lineDelta },
  { header: 'rtk_saved_tokens', value: (row) => row.rtkSavedTokens },
  { header: 'rtk_input_tokens', value: (row) => row.rtkInputTokens },
  { header: 'rtk_output_tokens', value: (row) => row.rtkOutputTokens },
  { header: 'rtk_savings_pct', value: (row) => rtkSavingsPct(row)?.toFixed(2) },
  { header: 'rtk_command_count', value: (row) => row.rtkCommandCount },
  { header: 'subagent', value: (row) => row.subagent ?? false },
  { header: 'partial', value: (row) => row.partial ?? false },
  { header: 'usage_unavailable', value: (row) => row.usageUnavailable ?? false },
  { header: 'ambiguous', value: (row) => row.ambiguous ?? false },
] as const satisfies readonly { header: string; textual?: boolean; value: (row: SerializedRow) => unknown }[];

export const serializedRowsToCSV = (rows: SerializedRow[]): string => {
  const head = usageRowCsvColumns.map((column) => column.header);
  const body = rows.map((row) =>
    usageRowCsvColumns
      .map((column) => csvCell(column.value(row) ?? '', 'textual' in column && column.textual))
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
};

/**
 * The slug that names a downloaded CSV. `sessions` names the Sessions-view export;
 * that export is campaign-aware and does not claim its aggregate rows are raw sessions.
 */
export type ReportCsvDimension = 'harnesses' | 'models' | 'projects' | 'providers' | 'sessions';

export interface AnalyticsExportRow {
  group: AnalyticsGroup;
  label: string;
}

export interface ProjectBreakdownExportGroup {
  cache: number;
  cost: number;
  fresh: number;
  label: string;
  lineMeasurement: {
    measuredSessions: number;
    totalSessions: number;
  };
  linesAdded: number;
  linesDeleted: number;
  priced: number;
  sessions: number;
  tools: number;
  turns: number;
}

/**
 * One top-level Sessions row. Identity-like fields such as harness, model, machine,
 * provider and project are intentionally absent: a filtered campaign row can aggregate
 * child metrics while its presentation label comes from the root, so exporting those
 * root fields would manufacture a usage row that never existed.
 *
 * Nullable metrics stay nullable: a harness that reports no RTK counters or no quota cost is not
 * the same claim as one that reported zero, and the serializer writes an empty cell for absence.
 */
export interface SessionCampaignExportRow {
  ambiguous: boolean;
  calls: number;
  campaignKey: string;
  campaignLabel: string;
  campaignSessions: number;
  costActual: number | null;
  costApprox: number | null;
  costKnown: boolean;
  costQuota: number | null;
  durationMs: number | null;
  freshTokens: number;
  lineDelta: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  partial: boolean;
  rtkCommandCount: number | null;
  rtkInputTokens: number | null;
  rtkOutputTokens: number | null;
  rtkSavedTokens: number | null;
  tokCr: number;
  tokCw: number;
  tokenTotal: number;
  tokIn: number;
  tokOut: number;
  tools: number;
  turns: number;
  usageUnavailable: boolean;
  visibleSessions: number;
}

type ApiValueMeasurement = 'complete' | 'partial' | 'unavailable';
type ReportCsvValue = boolean | null | number | string | undefined;

const ANALYTICS_BREAKDOWN_COLUMNS = [
  'label',
  'sessions',
  'fresh_tokens',
  'cache_read_tokens',
  'cache_hit_percent',
  'api_value_known',
  'api_value_display',
  'api_value_measurement',
  'fully_priced_sessions',
  'total_sessions',
  'unpriced_fresh_tokens',
  'turns',
  'tools',
] as const;

const PROJECT_BREAKDOWN_COLUMNS = [
  'label',
  'sessions',
  'fresh_tokens',
  'cache_read_tokens',
  'api_value_known',
  'api_value_display',
  'api_value_measurement',
  'fully_priced_sessions',
  'total_sessions',
  'lines_added',
  'lines_deleted',
  'line_measured_sessions',
  'line_total_sessions',
  'turns',
  'tools',
] as const;

export const SESSION_CAMPAIGN_EXPORT_COLUMNS = [
  'row_kind',
  'campaign_key',
  'campaign_label',
  'visible_sessions',
  'campaign_sessions',
  'input',
  'output',
  'cache_read',
  'cache_write',
  'fresh_tokens',
  'total_tokens',
  'cost_actual',
  'cost_quota',
  'cost_approx_api',
  'cost_known',
  'calls',
  'duration_ms',
  'turns',
  'tools',
  'lines_added',
  'lines_deleted',
  'line_delta',
  'rtk_saved_tokens',
  'rtk_input_tokens',
  'rtk_output_tokens',
  'rtk_command_count',
  'partial',
  'usage_unavailable',
  'ambiguous',
] as const;

const ASCII_SPACE_CODE_POINT = 32;
const SPREADSHEET_FORMULA_MARKERS = new Set(['=', '+', '-', '@']);

const startsSpreadsheetFormula = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const isLeadingControlOrWhitespace =
      (codePoint !== undefined && codePoint <= ASCII_SPACE_CODE_POINT) || character.trim() === '';
    if (isLeadingControlOrWhitespace) {
      continue;
    }
    return SPREADSHEET_FORMULA_MARKERS.has(character);
  }
  return false;
};

const apiValueDisplay = (knownValue: number, measurement: ApiValueMeasurement): string => {
  if (measurement === 'unavailable' || (measurement === 'partial' && knownValue === 0)) {
    return '—';
  }
  const formattedValue = `$${knownValue.toFixed(2)}`;
  return measurement === 'partial' ? `≥ ${formattedValue}` : formattedValue;
};

const analyticsMeasurement = (group: AnalyticsGroup): ApiValueMeasurement => {
  if (group.usageUnavailable === group.sessions) {
    return 'unavailable';
  }
  return group.unpriced > 0 ? 'partial' : 'complete';
};

const projectMeasurement = (group: ProjectBreakdownExportGroup): ApiValueMeasurement => {
  if (group.priced === 0) {
    return 'unavailable';
  }
  return group.priced < group.sessions ? 'partial' : 'complete';
};

const serializeReportCsvValue = (value: ReportCsvValue): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const neutralizedValue = startsSpreadsheetFormula(value) ? `'${value}` : value;
  return csvEscape(neutralizedValue);
};

const serializeReportCsv = (header: readonly string[], rows: readonly (readonly ReportCsvValue[])[]): string => {
  const serializedRows = [header, ...rows].map((row) => row.map(serializeReportCsvValue).join(','));
  return `${serializedRows.join('\r\n')}\r\n`;
};

export const analyticsBreakdownCsv = (rows: readonly AnalyticsExportRow[]): string =>
  serializeReportCsv(
    ANALYTICS_BREAKDOWN_COLUMNS,
    rows.map(({ group, label }) => {
      const measurement = analyticsMeasurement(group);
      return [
        label,
        group.sessions,
        group.fresh,
        group.cache,
        group.cacheHitPct,
        group.costSum,
        apiValueDisplay(group.costSum, measurement),
        measurement,
        group.priced,
        group.sessions,
        group.unpricedFreshTokens,
        group.turns,
        group.tools,
      ];
    }),
  );

export const projectBreakdownCsv = (groups: readonly ProjectBreakdownExportGroup[]): string =>
  serializeReportCsv(
    PROJECT_BREAKDOWN_COLUMNS,
    groups.map((group) => {
      const measurement = projectMeasurement(group);
      return [
        group.label,
        group.sessions,
        group.fresh,
        group.cache,
        group.cost,
        apiValueDisplay(group.cost, measurement),
        measurement,
        group.priced,
        group.sessions,
        group.linesAdded,
        group.linesDeleted,
        group.lineMeasurement.measuredSessions,
        group.lineMeasurement.totalSessions,
        group.turns,
        group.tools,
      ];
    }),
  );

export const sessionCampaignCsv = (rows: readonly SessionCampaignExportRow[]): string =>
  serializeReportCsv(
    SESSION_CAMPAIGN_EXPORT_COLUMNS,
    rows.map((row) => [
      'campaign_aggregate',
      row.campaignKey,
      row.campaignLabel,
      row.visibleSessions,
      row.campaignSessions,
      row.tokIn,
      row.tokOut,
      row.tokCr,
      row.tokCw,
      row.freshTokens,
      row.tokenTotal,
      row.costActual,
      row.costQuota,
      row.costApprox === null ? null : row.costApprox.toFixed(4),
      row.costKnown,
      row.calls,
      row.durationMs,
      row.turns,
      row.tools,
      row.linesAdded,
      row.linesDeleted,
      row.lineDelta,
      row.rtkSavedTokens,
      row.rtkInputTokens,
      row.rtkOutputTokens,
      row.rtkCommandCount,
      row.partial,
      row.usageUnavailable,
      row.ambiguous,
    ]),
  );

export const reportCsvFilename = (dimension: ReportCsvDimension, generatedAt: string): string =>
  `ai-usage-${dimension}-${new Date(generatedAt).toISOString().slice(0, 10)}.csv`;
