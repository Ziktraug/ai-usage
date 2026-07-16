import { LocalHistoryStorage } from '@ai-usage/local-collectors/local-history';
import { ensureMachineConfig } from '@ai-usage/local-collectors/machine-config';
import type { ProviderLimitWindow } from '@ai-usage/report-core/provider-status';
import { queryLatestProviderQuotaObservations, usageStorePath } from '@ai-usage/usage-store';
import { Effect } from 'effect';
import { clr } from './render/colors';
import { fmtDate, pad } from './render/format';

export const renderQuota = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const machine = yield* ensureMachineConfig;
  const stored = yield* queryLatestProviderQuotaObservations({
    dbPath: usageStorePath(storage.home),
    machineId: machine.id,
    providerKey: 'codex',
  });
  const latest = stored.observations[0]?.observation;
  if (!latest) {
    return 'No stored Codex usage-limit observation is available.';
  }

  const bar = (pct: number) => {
    const n = Math.round(Math.min(100, pct) / 5);
    const style = quotaColor(pct);
    return style('█'.repeat(n)) + clr.grey('░'.repeat(20 - n));
  };
  const lines = [
    clr.bold('═══ Codex subscription quota ═══'),
    `  plan: ${clr.cyan(latest.plan ?? 'unknown')}   ${clr.dim(`observed ${fmtDate(new Date(latest.observedAt))}`)}`,
  ];
  const win = (window: ProviderLimitWindow) => {
    const usedPercent = window.usedPercent ?? (window.remainingPercent === null ? 0 : 100 - window.remainingPercent);
    const span = quotaWindowSpan(window);
    lines.push(
      `  ${pad(`${window.label} (${span})`, 18)} ${bar(usedPercent)} ${clr.bold(`${usedPercent.toFixed(0)}%`)}` +
        (window.resetsAt ? clr.dim(`  resets ${fmtDate(new Date(window.resetsAt))}`) : ''),
    );
  };
  for (const window of latest.windows) {
    win(window);
  }
  lines.push(
    clr.dim(
      '\n  From the newest durable Codex usage-limit observation. Claude/OpenCode/Cursor expose no equivalent source.',
    ),
  );
  return lines.join('\n');
});

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
