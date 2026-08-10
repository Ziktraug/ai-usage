import type { ProviderLimitWindow, ProviderStatus } from '@ai-usage/report-core/provider-status';
import { clr } from './render/colors';
import { fmtDate, pad } from './render/format';

export const renderQuota = (providers: readonly ProviderStatus[]): string => {
  if (providers.length === 0) {
    return 'No stored provider usage-limit observation is available.';
  }

  const bar = (pct: number) => {
    const n = Math.round(Math.min(100, pct) / 5);
    const style = quotaColor(pct);
    return style('█'.repeat(n)) + clr.grey('░'.repeat(20 - n));
  };
  const lines: string[] = [];
  // Every provider that stores an observation, not a nominated one: the command is "show my quota",
  // and answering with only the first stored provider hides the rest as they are wired up.
  for (const provider of providers) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(
      clr.bold(`═══ ${provider.label} subscription quota ═══`),
      `  plan: ${clr.cyan(provider.plan ?? 'unknown')}   ${clr.dim(`observed ${fmtDate(new Date(provider.generatedAt))}`)}`,
    );
    if (provider.windows.length === 0) {
      lines.push(clr.dim('  no quota window reported'));
      continue;
    }
    for (const window of provider.windows) {
      const usedPercent = window.usedPercent ?? (window.remainingPercent === null ? 0 : 100 - window.remainingPercent);
      const span = quotaWindowSpan(window);
      lines.push(
        `  ${pad(`${window.label} (${span})`, 18)} ${bar(usedPercent)} ${clr.bold(`${usedPercent.toFixed(0)}%`)}` +
          (window.resetsAt ? clr.dim(`  resets ${fmtDate(new Date(window.resetsAt))}`) : ''),
      );
    }
  }
  lines.push(clr.dim('\n  Percentages are consumed usage, from the newest durable observation of each provider.'));
  return lines.join('\n');
};

const quotaWindowSpan = (window: ProviderLimitWindow): string => {
  if (window.limitSeconds === null) {
    return window.label;
  }
  if (window.limitSeconds >= 86_400) {
    return `${Math.round(window.limitSeconds / 86_400)}d`;
  }
  return `${Math.round(window.limitSeconds / 3600)}h`;
};

const quotaColor = (pct: number) => {
  if (pct >= 90) {
    return clr.redB;
  }
  if (pct >= 70) {
    return clr.yellow;
  }
  return clr.green;
};
