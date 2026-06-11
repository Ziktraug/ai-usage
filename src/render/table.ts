import type { Row } from '../types';
import { clr, costStyle, harnessColor, id, provColor } from './colors';
import { fmtDate, fmtDur, fmtNum, pad, trunc } from './format';

interface Col {
  h: string;
  f: (r: Row) => string;
  w: number;
  r: boolean;
  c: (r: Row) => (s: string) => string;
}

const fmtCost = (r: Row) => (r.costKnown ? `$${r.costApprox.toFixed(2)}` : '?');

const fmtDelta = (r: Row) => {
  if (r.linesAdded == null && r.linesDeleted == null) return '';
  const a = r.linesAdded || 0;
  const d = r.linesDeleted || 0;
  if (a + d === 0) return '';
  return `+${fmtNum(a)}/-${fmtNum(d)}`;
};

export const renderTable = (rows: Row[], wide = false) => {
  const cols: Col[] = [
    { h: 'Date', f: (r) => fmtDate(r.date), w: 16, r: false, c: () => clr.grey },
    { h: 'Harness', f: (r) => r.harness, w: 11, r: false, c: (r) => harnessColor(r.harness) },
    { h: 'Provider', f: (r) => r.provider, w: 16, r: false, c: (r) => provColor(r.provider) },
    { h: 'Model', f: (r) => r.model, w: 20, r: false, c: () => clr.cyan },
    { h: 'Project', f: (r) => r.project, w: 14, r: false, c: () => clr.dim },
    { h: 'In', f: (r) => fmtNum(r.tokIn), w: 7, r: true, c: () => id },
    { h: 'Out', f: (r) => fmtNum(r.tokOut), w: 7, r: true, c: () => id },
    { h: 'CacheR', f: (r) => fmtNum(r.tokCr), w: 8, r: true, c: () => clr.dim },
    ...(wide ? [] : [{ h: 'CacheW', f: (r: Row) => fmtNum(r.tokCw), w: 7, r: true, c: () => clr.dim }]),
    { h: '$API', f: fmtCost, w: 8, r: true, c: (r) => costStyle(r) },
    ...(wide
      ? ([
          { h: 'Dur', f: (r: Row) => fmtDur(r.durationMs), w: 6, r: true, c: () => clr.grey },
          { h: 'Trn', f: (r: Row) => (r.turns ? String(r.turns) : ''), w: 4, r: true, c: () => clr.dim },
          { h: 'Tool', f: (r: Row) => (r.tools ? String(r.tools) : ''), w: 5, r: true, c: () => clr.dim },
          { h: '±Lines', f: fmtDelta, w: 15, r: true, c: () => clr.green },
        ] as Col[])
      : []),
    {
      h: 'Session',
      f: (r) => r.name + (r.partial ? ' ~' : '') + (r.subagent ? ' ↳' : ''),
      w: 34,
      r: false,
      c: (r) => (r.partial || r.subagent ? clr.dim : id),
    },
  ];
  const header = clr.bold(cols.map((col) => pad(col.h, col.w, col.r)).join('  '));
  const sep = clr.grey('─'.repeat(cols.reduce((a, col) => a + col.w + 2, -2)));
  const lines = rows.map((r) => cols.map((col) => col.c(r)(pad(trunc(col.f(r), col.w), col.w, col.r))).join('  '));
  return [header, sep, ...lines].join('\n');
};
