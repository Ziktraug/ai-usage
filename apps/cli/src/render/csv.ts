import type { Row } from '@ai-usage/core/types';

const csvEscape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export const renderCSV = (rows: Row[]) => {
  const head = [
    'date',
    'end_date',
    'harness',
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
    'subagent',
    'partial',
  ];
  const body = rows.map((r) =>
    [
      r.date?.toISOString() ?? '',
      r.endDate?.toISOString() ?? '',
      r.harness,
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
      r.subagent ?? false,
      r.partial ?? false,
    ]
      .map((x) => csvEscape(String(x)))
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
};
