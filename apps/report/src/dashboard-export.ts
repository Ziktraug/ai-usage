import { inlineReportHTML } from '@ai-usage/core/html-export';
import type { SerializedRow, UsageReportPayload } from '@ai-usage/core/report-data';
import { rtkSavingsPct } from './dashboard-sort';

const csvEscape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

const reportRowsToCSV = (rows: SerializedRow[]) => {
  const head = [
    'date',
    'end_date',
    'active_date',
    'harness',
    'machine',
    'machine_id',
    'provider',
    'session',
    'model',
    'models',
    'project',
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
    'rtk_savings_pct',
    'rtk_command_count',
    'subagent',
    'partial',
    'usage_unavailable',
    'ambiguous',
  ];
  const body = rows.map((row) =>
    [
      row.date ?? '',
      row.endDate ?? '',
      row.activeDate ?? '',
      row.harness,
      row.source?.machineLabel ?? '',
      row.source?.machineId ?? '',
      row.provider,
      row.name,
      row.model,
      row.models?.join('|') ?? '',
      row.project,
      row.tokIn,
      row.tokOut,
      row.tokCr,
      row.tokCw,
      row.freshTokens,
      row.tokenTotal,
      row.costActual ?? '',
      row.costQuota ?? '',
      row.costApprox.toFixed(4),
      row.costKnown,
      row.calls,
      row.durationMs ?? '',
      row.turns,
      row.tools,
      row.linesAdded ?? '',
      row.linesDeleted ?? '',
      row.lineDelta ?? '',
      row.rtkSavedTokens ?? '',
      row.rtkInputTokens ?? '',
      row.rtkOutputTokens ?? '',
      rtkSavingsPct(row)?.toFixed(2) ?? '',
      row.rtkCommandCount ?? '',
      row.subagent ?? false,
      row.partial ?? false,
      row.usageUnavailable ?? false,
      row.ambiguous ?? false,
    ]
      .map((item) => csvEscape(String(item)))
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
};

export const downloadCSV = (rows: SerializedRow[], generatedAt: string) => {
  const blob = new Blob([reportRowsToCSV(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ai-usage-report-${generatedAt.slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
};

export const downloadHTML = async (payload: UsageReportPayload) => {
  const response = await fetch(location.href, { cache: 'no-store' });
  const html = await response.text();
  const fetchAssetContent = async (src: string): Promise<string> => {
    try {
      const url = new URL(src, location.href).href;
      const res = await fetch(url, { cache: 'no-store' });
      return res.ok ? await res.text() : '';
    } catch {
      return '';
    }
  };
  const selfContained = await inlineReportHTML({ html, payload, readAssetContent: fetchAssetContent });
  const blob = new Blob([selfContained], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ai-usage-report-${payload.generatedAt.slice(0, 10)}.html`;
  link.click();
  URL.revokeObjectURL(url);
};
