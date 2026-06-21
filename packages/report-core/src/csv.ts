import type { SerializedRow } from './report-data';

const csvEscape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export const rtkSavingsPct = (row: Pick<SerializedRow, 'rtkInputTokens' | 'rtkSavedTokens'>) =>
  row.rtkSavedTokens && row.rtkInputTokens ? (row.rtkSavedTokens / row.rtkInputTokens) * 100 : null;

/**
 * The single source of truth for the usage row → CSV projection. Both the CLI
 * and the web export adapter feed it serialized rows so the emitted schema can
 * never drift between outputs.
 */
export const usageRowCsvColumns = [
  { header: 'date', value: (row) => row.date },
  { header: 'end_date', value: (row) => row.endDate },
  { header: 'active_date', value: (row) => row.activeDate },
  { header: 'harness', value: (row) => row.harness },
  { header: 'machine', value: (row) => row.source?.machineLabel },
  { header: 'machine_id', value: (row) => row.source?.machineId },
  { header: 'provider', value: (row) => row.provider },
  { header: 'session', value: (row) => row.name },
  { header: 'model', value: (row) => row.model },
  { header: 'models', value: (row) => row.models?.join('|') },
  { header: 'project', value: (row) => row.project },
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
] as const satisfies readonly { header: string; value: (row: SerializedRow) => unknown }[];

export const serializedRowsToCSV = (rows: SerializedRow[]): string => {
  const head = usageRowCsvColumns.map((column) => column.header);
  const body = rows.map((row) =>
    usageRowCsvColumns
      .map((column) => column.value(row) ?? '')
      .map((item) => csvEscape(String(item)))
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
};
