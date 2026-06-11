#!/usr/bin/env bun
import { parseArgs } from './cli';
import { collectClaude, collectCodex, collectCursor, collectOpenCode } from './collectors';
import { createLocalHistoryStorage } from './local-history';
import { renderQuota } from './quota';
import { renderAnalytics } from './render/analytics';
import { clr, setColor } from './render/colors';
import { renderCSV } from './render/csv';
import { renderTable } from './render/table';
import type { Row } from './types';

const compareRows = (sort: 'date' | 'tokens' | 'cost') =>
  ({
    date: (a: Row, b: Row) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0),
    tokens: (a: Row, b: Row) => b.tokIn + b.tokOut + b.tokCr + b.tokCw - (a.tokIn + a.tokOut + a.tokCr + a.tokCw),
    cost: (a: Row, b: Row) => b.costApprox - a.costApprox,
  })[sort];

export const main = () => {
  try {
    const argv = process.argv.slice(2);
    const storage = createLocalHistoryStorage();
    if (argv[0] === 'quota') {
      setColor(argv.includes('--no-color') ? false : !!process.stdout.isTTY || argv.includes('--color'));
      renderQuota(storage);
      return;
    }
    if (argv[0] === 'report') argv.shift();
    const args = parseArgs(argv);
    setColor(args.color === null ? !!process.stdout.isTTY : args.color);

    let rows: Row[] = [];
    const want = (h: string) => !args.harness || args.harness === h;
    if (want('claude')) rows.push(...collectClaude(storage));
    if (want('codex')) rows.push(...collectCodex(storage));
    if (want('opencode')) rows.push(...collectOpenCode(storage));
    if (want('cursor') && args.cursor) rows.push(...collectCursor(storage));

    rows = rows.filter((r) => {
      const total = r.tokIn + r.tokOut + r.tokCr + r.tokCw;
      const activeAt = r.endDate ?? r.date;
      if (total < args.minTokens) return false;
      if (args.since && (!activeAt || activeAt < args.since)) return false;
      if (args.project && !r.project.toLowerCase().includes(args.project)) return false;
      return true;
    });

    rows.sort(compareRows(args.sort));

    const tableRows = args.limit ? rows.slice(0, args.limit) : rows;

    if (args.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (args.csv) {
      console.log(renderCSV(rows));
      return;
    }
    console.log(renderTable(tableRows, args.wide));
    if (args.limit && rows.length > tableRows.length) {
      console.log(
        clr.dim(`  … ${rows.length - tableRows.length} more rows (analytics below cover all ${rows.length})`),
      );
    }
    console.log(renderAnalytics(rows));
    console.log(
      clr.dim(
        '\nNotes: Codex tokens are cumulative observed counters (proxy, not billing); Codex durations span the rollout file (resumed sessions look long, not active time).' +
          ' Cursor rows marked ~ are partial (counts stored server-side); ↳ = contains sub-agents.' +
          ' Tracked lines: OpenCode/Cursor only (Claude/Codex expose none locally).' +
          ' $API = hypothetical cost at current API rates (subscriptions bill differently); ? = no public rate.',
      ),
    );
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
};

main();
