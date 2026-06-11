import { Effect } from 'effect';
import { findLatestCodexRateLimits, hasCodexHistory } from './codex-history';
import { clr } from './render/colors';
import { fmtDate, pad } from './render/format';

export const renderQuota = Effect.gen(function* () {
  if (!(yield* hasCodexHistory)) return 'No Codex data found at ~/.codex/sessions';

  const latest = yield* findLatestCodexRateLimits();
  if (!latest) return 'No quota (rate_limits) snapshot found in recent Codex sessions.';

  const { rateLimits, ts } = latest;
  const bar = (pct: number) => {
    const n = Math.round(Math.min(100, pct) / 5);
    const style = pct >= 90 ? clr.redB : pct >= 70 ? clr.yellow : clr.green;
    return style('█'.repeat(n)) + clr.grey('░'.repeat(20 - n));
  };
  const lines = [
    clr.bold('═══ Codex subscription quota ═══'),
    `  plan: ${clr.cyan(rateLimits.plan_type ?? 'unknown')}   ${clr.dim(`snapshot ${fmtDate(ts)}`)}`,
  ];
  const win = (label: string, window: any) => {
    if (!window) return;
    const mins = window.window_minutes;
    const span = mins >= 1440 ? `${Math.round(mins / 1440)}d` : `${Math.round(mins / 60)}h`;
    const resets = window.resets_at ? new Date(window.resets_at * 1000) : null;
    lines.push(
      `  ${pad(`${label} (${span})`, 12)} ${bar(window.used_percent)} ${clr.bold(`${window.used_percent.toFixed(0)}%`)}` +
        (resets ? clr.dim(`  resets ${fmtDate(resets)}`) : ''),
    );
  };
  win('5-hour', rateLimits.primary);
  win('weekly', rateLimits.secondary);
  if (rateLimits.credits != null) lines.push(`  credits: ${rateLimits.credits}`);
  lines.push(
    clr.dim(
      '\n  From the newest local token_count.rate_limits event (Codex CLI/VSCode). Claude/OpenCode/Cursor expose no local quota.',
    ),
  );
  return lines.join('\n');
});
