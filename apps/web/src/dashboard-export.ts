import { serializedRowsToCSV } from '@ai-usage/report-core/csv';
import { inlineReportHTML } from '@ai-usage/report-core/html-export';
import type { SerializedRow, UsageReportPayload } from '@ai-usage/report-core/report-data';

export const downloadCSV = (rows: SerializedRow[], generatedAt: string) => {
  const blob = new Blob([serializedRowsToCSV(rows)], { type: 'text/csv;charset=utf-8' });
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
