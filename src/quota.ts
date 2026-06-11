import { findLatestCodexRateLimits, hasCodexHistory } from './codex-history';
import { createLocalHistoryStorage } from './local-history';
import { clr } from './render/colors';
import { fmtDate, pad } from './render/format';

export const renderQuota = (storage = createLocalHistoryStorage()) => {
  if (!hasCodexHistory(storage)) {
    console.log('No Codex data found at ~/.codex/sessions');
    return;
  }

  const latest = findLatestCodexRateLimits(storage);
  if (!latest) {
    console.log('No quota (rate_limits) snapshot found in recent Codex sessions.');
    return;
  }

  const { rateLimits, ts } = latest;
  const bar = (pct: number) => {
    const n = Math.round(Math.min(100, pct) / 5);
    const style = pct >= 90 ? clr.redB : pct >= 70 ? clr.yellow : clr.green;
    return style('█'.repeat(n)) + clr.grey('░'.repeat(20 - n));
  };
  const win = (label: string, window: any) => {
    if (!window) return;
    const mins = window.window_minutes;
    const span = mins >= 1440 ? `${Math.round(mins / 1440)}d` : `${Math.round(mins / 60)}h`;
    const resets = window.resets_at ? new Date(window.resets_at * 1000) : null;
    console.log(
      `  ${pad(`${label} (${span})`, 12)} ${bar(window.used_percent)} ${clr.bold(`${window.used_percent.toFixed(0)}%`)}` +
        (resets ? clr.dim(`  resets ${fmtDate(resets)}`) : ''),
    );
  };
  console.log(clr.bold('═══ Codex subscription quota ═══'));
  console.log(`  plan: ${clr.cyan(rateLimits.plan_type ?? 'unknown')}   ${clr.dim(`snapshot ${fmtDate(ts)}`)}`);
  win('5-hour', rateLimits.primary);
  win('weekly', rateLimits.secondary);
  if (rateLimits.credits != null) console.log(`  credits: ${rateLimits.credits}`);
  console.log(
    clr.dim(
      '\n  From the newest local token_count.rate_limits event (Codex CLI/VSCode). Claude/OpenCode/Cursor expose no local quota.',
    ),
  );
};
