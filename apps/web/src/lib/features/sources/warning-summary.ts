import type { SourceControlEntryView } from '@ai-usage/report-core/source-control';

type Warning = SourceControlEntryView['warnings'][number];

/** Group identical visible messages, retaining the order of their first occurrence. */
export const summarizeWarnings = (
  warnings: readonly Warning[],
): readonly { label: string; message: string; count: number }[] => {
  const groups = new Map<string, { label: string; message: string; count: number }>();
  for (const warning of warnings) {
    const label = warning.code === 'historicalMetricValidation' ? 'Historical note' : 'Warning';
    const message = warning.message ?? warning.code;
    const key = JSON.stringify([label, message]);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { label, message, count: 1 });
    }
  }
  return [...groups.values()];
};
