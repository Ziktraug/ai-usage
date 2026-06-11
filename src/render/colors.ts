import type { Row } from '../types';

let colorEnabled = true;

export const setColor = (enabled: boolean) => {
  colorEnabled = enabled;
};

const sgr = (code: string) => (s: string) => (colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s);
export const id = (s: string) => s;

export const clr = {
  bold: sgr('1'),
  dim: sgr('2'),
  italic: sgr('3'),
  ul: sgr('4'),
  red: sgr('31'),
  green: sgr('32'),
  yellow: sgr('33'),
  blue: sgr('34'),
  magenta: sgr('35'),
  cyan: sgr('36'),
  grey: sgr('90'),
  redB: sgr('1;31'),
  yellowB: sgr('1;33'),
  greenB: sgr('1;32'),
  cyanB: sgr('1;36'),
};

export const harnessColor = (h: string) =>
  h === 'Claude Code' ? clr.magenta : h === 'Codex' ? clr.cyan : h === 'OpenCode' ? clr.green : clr.blue;

export const provColor = (p: string) => (/API/.test(p) ? clr.yellow : clr.green);

export const costStyle = (row: Row) => {
  if (!row.costKnown) return clr.grey;
  if (row.costApprox >= 20) return clr.redB;
  if (row.costApprox >= 5) return clr.yellow;
  return id;
};
