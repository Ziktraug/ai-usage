import { type HarnessColor, harnessMetadataForLabel } from '@ai-usage/core/harness-metadata';
import type { Row } from '@ai-usage/core/types';
import { usageRowPricedCost } from '@ai-usage/core/usage-row';

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

const harnessColorFn = (color: HarnessColor) =>
  ({
    magenta: clr.magenta,
    cyan: clr.cyan,
    green: clr.green,
    blue: clr.blue,
  })[color];

export const harnessColor = (h: string) => harnessColorFn(harnessMetadataForLabel(h)?.color ?? 'blue');

export const provColor = (p: string) => (/API/.test(p) ? clr.yellow : clr.green);

export const costStyle = (row: Row) => {
  const cost = usageRowPricedCost(row);
  if (cost == null) return clr.grey;
  if (cost >= 20) return clr.redB;
  if (cost >= 5) return clr.yellow;
  return id;
};
