import type { ProviderLimitWindow } from '@ai-usage/report-core/provider-status';
import { fmtDate, fmtPct } from '../../../foundation/presentation/format';

export const providerPercentLabel = (window: Pick<ProviderLimitWindow, 'usedPercent'>): string =>
  window.usedPercent === null ? 'Unknown usage' : fmtPct(window.usedPercent);

export const providerRemainingLabel = (window: Pick<ProviderLimitWindow, 'remainingPercent'>): string =>
  window.remainingPercent === null ? 'Remaining unknown' : `${fmtPct(window.remainingPercent)} remaining`;

export const providerResetLabel = (window: Pick<ProviderLimitWindow, 'resetsAt'>): string =>
  window.resetsAt ? `Resets ${fmtDate(window.resetsAt)}` : 'Reset time unknown';

export const providerWindowAriaLabel = (
  providerLabel: string,
  window: Pick<ProviderLimitWindow, 'label' | 'remainingPercent' | 'resetsAt' | 'usedPercent'>,
): string => {
  const used = window.usedPercent === null ? 'unknown used percent' : `${window.usedPercent.toFixed(0)} percent used`;
  const remaining =
    window.remainingPercent === null
      ? 'unknown remaining percent'
      : `${window.remainingPercent.toFixed(0)} percent remaining`;
  const reset = window.resetsAt ? `resets ${fmtDate(window.resetsAt)}` : 'reset time unknown';
  return `${providerLabel} ${window.label}: ${used}, ${remaining}, ${reset}`;
};
