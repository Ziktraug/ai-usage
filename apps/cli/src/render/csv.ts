import { sourceLabel } from '@ai-usage/core/snapshot';
import type { Row, SourcedRow } from '@ai-usage/core/types';

const csvEscape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const rtkSavingsPct = (row: Row) =>
  row.rtkSavedTokens && row.rtkInputTokens ? (row.rtkSavedTokens / row.rtkInputTokens) * 100 : null;
const sourceMachineId = (row: Row) => (row as Partial<SourcedRow>).source?.machineId ?? '';

export const renderCSV = (rows: Row[]) => {
  const head = [
    'date',
    'end_date',
    'harness',
    'machine',
    'machine_id',
    'provider',
    'session',
    'model',
    'project',
    'input',
    'output',
    'cache_read',
    'cache_write',
    'cost_actual',
    'cost_approx_api',
    'cost_known',
    'calls',
    'duration_ms',
    'turns',
    'tools',
    'lines_added',
    'lines_deleted',
    'rtk_saved_tokens',
    'rtk_input_tokens',
    'rtk_output_tokens',
    'rtk_savings_pct',
    'rtk_command_count',
    'subagent',
    'partial',
    'usage_unavailable',
  ];
  const body = rows.map((r) =>
    [
      r.date?.toISOString() ?? '',
      r.endDate?.toISOString() ?? '',
      r.harness,
      sourceLabel(r),
      sourceMachineId(r),
      r.provider,
      r.name,
      r.model,
      r.project,
      r.tokIn,
      r.tokOut,
      r.tokCr,
      r.tokCw,
      r.costActual ?? '',
      r.costApprox.toFixed(4),
      r.costKnown,
      r.calls,
      r.durationMs ?? '',
      r.turns,
      r.tools,
      r.linesAdded ?? '',
      r.linesDeleted ?? '',
      r.rtkSavedTokens ?? '',
      r.rtkInputTokens ?? '',
      r.rtkOutputTokens ?? '',
      rtkSavingsPct(r)?.toFixed(2) ?? '',
      r.rtkCommandCount ?? '',
      r.subagent ?? false,
      r.partial ?? false,
      r.usageUnavailable ?? false,
    ]
      .map((x) => csvEscape(String(x)))
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
};
