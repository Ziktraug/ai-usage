import type { FocusedReportSummary, FocusedTimelineGap } from '@ai-usage/report-core/focused-report-query';
import { originProvenanceFor } from '@ai-usage/report-core/provenance';
import { fmtCompact, fmtNum, fmtPct } from '../../../foundation/presentation/format';

export interface TokenAnatomyRow {
  readonly key: 'cache-read' | 'cache-write' | 'input' | 'output';
  readonly label: string;
  readonly percentage: string;
  readonly value: string;
}

export const tokenAnatomyRows = (summary: FocusedReportSummary): TokenAnatomyRow[] => {
  const values = [summary.cacheRead, summary.cacheWrite, summary.tokIn, summary.tokOut] as const;
  const total = values.reduce((sum, value) => sum + value, 0);
  const row = (key: TokenAnatomyRow['key'], label: string, value: number): TokenAnatomyRow => ({
    key,
    label,
    percentage: fmtPct(total > 0 ? (value / total) * 100 : 0),
    value: fmtCompact(value),
  });
  return [
    row('cache-read', 'Cache read', summary.cacheRead),
    row('cache-write', 'Cache write', summary.cacheWrite),
    row('input', 'Input', summary.tokIn),
    row('output', 'Output', summary.tokOut),
  ];
};

export const originGapDescription = (gap: FocusedTimelineGap): string => {
  const causes = gap.causes
    .map(({ kind, sessions }) => {
      const provenance = originProvenanceFor(kind);
      return `${provenance.label}: ${fmtNum(sessions)} ${sessions === 1 ? 'session' : 'sessions'}`;
    })
    .join(' · ');
  const total = `Not classified: ${fmtNum(gap.sessions)} ${gap.sessions === 1 ? 'session' : 'sessions'}`;
  return causes.length > 0 ? `${total} · ${causes}` : total;
};
