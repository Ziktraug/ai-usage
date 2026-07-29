import type { AnalyticsGroup } from '@ai-usage/report-core/analytics';
import type { ProjectGroup } from './dashboard-analytics';

export type ReportCsvDimension = 'harnesses' | 'models' | 'projects' | 'providers';

export interface AnalyticsExportRow {
  group: AnalyticsGroup;
  label: string;
}

type ApiValueMeasurement = 'complete' | 'partial' | 'unavailable';
type CsvValue = number | string;

const ANALYTICS_COLUMNS = [
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

const PROJECT_COLUMNS = [
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

const ASCII_SPACE_CODE_POINT = 32;
const SPREADSHEET_FORMULA_MARKERS = new Set(['=', '+', '-', '@']);
const RFC_4180_SPECIAL_CHARACTER = /[",\r\n]/;

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

const projectMeasurement = (group: ProjectGroup): ApiValueMeasurement => {
  if (group.priced === 0) {
    return 'unavailable';
  }
  return group.priced < group.sessions ? 'partial' : 'complete';
};

const serializeCsvValue = (value: CsvValue): string => {
  if (typeof value === 'number') {
    return String(value);
  }
  const neutralizedValue = startsSpreadsheetFormula(value) ? `'${value}` : value;
  return RFC_4180_SPECIAL_CHARACTER.test(neutralizedValue)
    ? `"${neutralizedValue.replaceAll('"', '""')}"`
    : neutralizedValue;
};

const serializeCsv = (header: readonly string[], rows: readonly (readonly CsvValue[])[]): string => {
  const serializedRows = [header, ...rows].map((row) => row.map(serializeCsvValue).join(','));
  return `${serializedRows.join('\r\n')}\r\n`;
};

export const analyticsBreakdownCsv = (rows: readonly AnalyticsExportRow[]): string =>
  serializeCsv(
    ANALYTICS_COLUMNS,
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

export const projectBreakdownCsv = (groups: readonly ProjectGroup[]): string =>
  serializeCsv(
    PROJECT_COLUMNS,
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

export const reportCsvFilename = (dimension: ReportCsvDimension, generatedAt: string): string =>
  `ai-usage-${dimension}-${new Date(generatedAt).toISOString().slice(0, 10)}.csv`;

export const downloadReportCsv = (filename: string, csv: string): void => {
  const objectUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.download = filename;
  anchor.href = objectUrl;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }
};
