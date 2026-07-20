import { statusPillDanger, statusPillInfo, statusPillOk, statusPillWarn } from '@ai-usage/design-system/report';
import type { SourceControlEntryView } from '@ai-usage/report-core/source-control';

export type SourcePresentationTone = 'danger' | 'info' | 'ok' | 'warning';

export interface SourcePresentation {
  readonly explanation: string;
  readonly label: string;
  readonly tone: SourcePresentationTone;
}

export type SourceProgressPresentation =
  | { readonly kind: 'determinate'; readonly max: number; readonly value: number }
  | { readonly kind: 'indeterminate' };

export const presentSourceProgress = (source: SourceControlEntryView): SourceProgressPresentation => {
  const { completed, total } = source.progress ?? {};
  if (completed === undefined || total === undefined || total <= 0) {
    return { kind: 'indeterminate' };
  }
  return { kind: 'determinate', max: total, value: Math.min(completed, total) };
};

export const sourceToneClass = (tone: SourcePresentationTone): string => {
  if (tone === 'ok') {
    return statusPillOk;
  }
  if (tone === 'danger') {
    return statusPillDanger;
  }
  return tone === 'warning' ? statusPillWarn : statusPillInfo;
};

export const presentSourceState = (source: SourceControlEntryView): SourcePresentation => {
  if (source.lifecycle === 'pausing') {
    return {
      explanation: 'The picked run will finish and save its contribution; future runs are paused.',
      label: 'Pausing after current run',
      tone: 'warning',
    };
  }
  if (source.policy === 'disabled') {
    return {
      explanation: 'Future collection is paused. Previously stored data remains available.',
      label: 'Disabled',
      tone: 'info',
    };
  }
  if (source.availability === 'misconfigured') {
    return {
      explanation: source.reason.message ?? 'The source configuration needs attention before it can run.',
      label: 'Misconfigured',
      tone: 'danger',
    };
  }
  if (source.availability === 'not-detected') {
    return {
      explanation: source.reason.message ?? 'No supported local input was detected.',
      label: 'Not detected',
      tone: 'warning',
    };
  }
  if (source.availability === 'unsupported') {
    return {
      explanation: source.reason.message ?? 'This source is unavailable on the current platform.',
      label: 'Unsupported',
      tone: 'warning',
    };
  }
  if (source.lastOutcome === 'timed-out') {
    return {
      explanation: 'The last run exceeded its time limit and was cancelled before further writes.',
      label: 'Timed out',
      tone: 'danger',
    };
  }
  if (source.lastOutcome === 'failed') {
    return {
      explanation: source.reason.message ?? 'The last run failed; previously stored data was preserved.',
      label: 'Failed',
      tone: 'danger',
    };
  }
  if (source.lifecycle === 'running') {
    return { explanation: 'Collection is running.', label: 'Running', tone: 'ok' };
  }
  if (source.lifecycle === 'queued') {
    return { explanation: 'The source is waiting for a worker.', label: 'Queued', tone: 'info' };
  }
  if (source.lastOutcome === 'warning') {
    return {
      explanation: 'The last run completed with partial or rejected local records.',
      label: 'Completed with warnings',
      tone: 'warning',
    };
  }
  if (source.lastOutcome === 'not-run') {
    return { explanation: 'The source has not completed its first run yet.', label: 'Not run yet', tone: 'info' };
  }
  if (source.lastOutcome === 'skipped') {
    return {
      explanation: source.reason.message ?? 'The last queued run was skipped safely.',
      label: 'Skipped',
      tone: 'info',
    };
  }
  return { explanation: 'The last run completed successfully.', label: 'Ready', tone: 'ok' };
};
