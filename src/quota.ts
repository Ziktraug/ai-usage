import { Effect } from 'effect';
import { type CodexQuotaWindow, findLatestCodexQuotaSnapshot, hasCodexHistory } from './codex-history';
import { clr } from './render/colors';
import { fmtDate, pad } from './render/format';

export const renderQuota = Effect.gen(function* () {
  if (!(yield* hasCodexHistory)) return 'No Codex data found at ~/.codex/sessions';

  const latest = yield* findLatestCodexQuotaSnapshot();
  if (!latest) return 'No quota (rate_limits) snapshot found in recent Codex sessions.';

  const bar = (pct: number) => {
    const n = Math.round(Math.min(100, pct) / 5);
    const style = pct >= 90 ? clr.redB : pct >= 70 ? clr.yellow : clr.green;
    return style('█'.repeat(n)) + clr.grey('░'.repeat(20 - n));
  };
  const lines = [
    clr.bold('═══ Codex subscription quota ═══'),
    `  plan: ${clr.cyan(latest.planType)}   ${clr.dim(`snapshot ${fmtDate(latest.ts)}`)}`,
  ];
  const win = (label: string, window: CodexQuotaWindow | null) => {
    if (!window) return;
    const span =
      window.windowMinutes >= 1440
        ? `${Math.round(window.windowMinutes / 1440)}d`
        : `${Math.round(window.windowMinutes / 60)}h`;
    lines.push(
      `  ${pad(`${label} (${span})`, 12)} ${bar(window.usedPercent)} ${clr.bold(`${window.usedPercent.toFixed(0)}%`)}` +
        (window.resetsAt ? clr.dim(`  resets ${fmtDate(window.resetsAt)}`) : ''),
    );
  };
  win('5-hour', latest.primary);
  win('weekly', latest.secondary);
  if (latest.credits != null) lines.push(`  credits: ${latest.credits}`);
  lines.push(
    clr.dim(
      '\n  From the newest local token_count.rate_limits event (Codex CLI/VSCode). Claude/OpenCode/Cursor expose no local quota.',
    ),
  );
  return lines.join('\n');
});
