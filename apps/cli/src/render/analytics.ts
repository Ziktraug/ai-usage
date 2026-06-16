import { type AnalyticsGroup, calculateAnalytics } from '@ai-usage/core/analytics';
import type { Row } from '@ai-usage/core/types';
import { clr, harnessColor, id } from './colors';
import { fmtDur, fmtNum, pad, trunc } from './format';

const analyticsTable = (
  title: string,
  groups: AnalyticsGroup[],
  keyHeader: string,
  keyWidth: number,
  showHarness: boolean,
) => {
  const out: string[] = ['', clr.bold(clr.ul(title))];
  const cols: { h: string; w: number; r: boolean }[] = [
    { h: keyHeader, w: keyWidth, r: false },
    ...(showHarness ? [{ h: 'Harness', w: 12, r: false }] : []),
    { h: 'Sess', w: 5, r: true },
    { h: 'Fresh', w: 8, r: true },
    { h: 'cache%', w: 6, r: true },
    { h: '$API', w: 10, r: true },
    { h: '$/sess', w: 8, r: true },
    { h: 'median', w: 8, r: true },
    { h: '±Lines', w: 12, r: true },
    { h: '$/100ln', w: 8, r: true },
    { h: '%', w: 6, r: true },
  ];
  out.push(clr.dim(cols.map((col) => pad(col.h, col.w, col.r)).join('  ')));
  for (const group of groups) {
    const unavailableOnly = group.usageUnavailable === group.sessions;
    const cells: string[] = [];
    cells.push(clr.cyan(pad(trunc(group.key, keyWidth), keyWidth)));
    if (showHarness) cells.push(harnessColor(group.harness)(pad(trunc(group.harness, 12), 12)));
    cells.push(pad(String(group.sessions), 5, true));
    cells.push(pad(unavailableOnly ? 'n/a' : fmtNum(group.fresh), 8, true));
    cells.push(clr.dim(pad(unavailableOnly ? 'n/a' : `${group.cacheHitPct.toFixed(0)}%`, 6, true)));
    const costText = unavailableOnly
      ? 'n/a'
      : (group.priced ? `$${group.costSum.toFixed(2)}` : '–') + (group.unpriced ? '*' : '');
    const costStyle = !group.priced
      ? clr.grey
      : group.costSum >= 100
        ? clr.redB
        : group.costSum >= 25
          ? clr.yellow
          : id;
    cells.push(costStyle(pad(costText, 10, true)));
    cells.push(
      pad(unavailableOnly || group.costPerSession == null ? '–' : `$${group.costPerSession.toFixed(2)}`, 8, true),
    );
    cells.push(pad(unavailableOnly || group.medianCost == null ? '–' : `$${group.medianCost.toFixed(2)}`, 8, true));
    cells.push(clr.green(pad(group.lineCount ? `+${fmtNum(group.linesA)}/-${fmtNum(group.linesD)}` : '–', 12, true)));
    cells.push(pad(group.costPer100Lines == null ? '–' : `$${group.costPer100Lines.toFixed(2)}`, 8, true));
    cells.push(clr.dim(pad(`${group.costPercent.toFixed(1)}%`, 6, true)));
    out.push(cells.join('  '));
  }
  return out.join('\n');
};

export const renderAnalytics = (rows: Row[]) => {
  const analytics = calculateAnalytics(rows);
  const out: string[] = [];

  out.push('', clr.bold('═══ Data analysis ═══'));
  out.push(
    `  ${clr.bold(String(analytics.sessionCount))} sessions` +
      (analytics.unpricedCount ? clr.dim(` (${analytics.unpricedCount} unpriced)`) : '') +
      ` · ~API total ${clr.yellowB(`$${analytics.totalCost.toFixed(2)}`)} · ` +
      `mean ${clr.bold(`$${analytics.meanCost.toFixed(2)}`)}/sess · ` +
      `median ${clr.bold(`$${analytics.medianCost.toFixed(2)}`)}/sess`,
  );
  out.push(
    clr.dim('  ') +
      `tracked lines ${clr.green(`+${fmtNum(analytics.linesA)}/-${fmtNum(analytics.linesD)}`)}` +
      (analytics.costPer100Lines == null
        ? ''
        : ` · ${clr.bold(`$${analytics.costPer100Lines.toFixed(2)}`)}/100 lines`) +
      ` · ${fmtNum(analytics.turns)} turns · ${fmtNum(analytics.tools)} tool calls` +
      (analytics.durationRows && analytics.averageDurationMs != null
        ? ` · ${fmtDur(analytics.durationMs)} observed span · ${fmtDur(analytics.averageDurationMs)} avg span/sess`
        : ''),
  );
  if (analytics.recentSessions) {
    out.push(
      clr.dim(
        `  includes ${analytics.recentSessions} session${analytics.recentSessions === 1 ? '' : 's'} updated in the last 5m; local log counters may change while tools are active.`,
      ),
    );
  }

  out.push(analyticsTable('By model — cost & usage (sorted by ~API $)', analytics.byModel, 'Model', 24, true));
  out.push(analyticsTable('By provider — cost & usage', analytics.byProvider, 'Provider', 20, false));
  out.push(analyticsTable('By harness — cost & usage', analytics.byHarness, 'Harness', 14, false));
  if (analytics.unpricedCount)
    out.push(
      clr.dim(
        `  * $API sums priced sessions only; n/a = usage counters unavailable; $/sess & median exclude unpriced/unavailable sessions.`,
      ),
    );
  return out.join('\n');
};
