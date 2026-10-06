import { type HarnessColor, harnessMetadataForLabel } from '@ai-usage/report-core/harness-metadata';
import type { Row } from '@ai-usage/report-core/types';
import { usageRowPricedCost } from '@ai-usage/report-core/usage-row';

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

// 256-colour approximations of the web hues; the 16 basic colours have no clay or raspberry.
const harnessColors: Record<HarnessColor, (s: string) => string> = {
  clay: sgr('38;5;173'),
  blue: sgr('38;5;75'),
  teal: sgr('38;5;79'),
  raspberry: sgr('38;5;175'),
};

// An unrecognised harness stays uncoloured rather than borrowing a known harness's identity.
export const harnessColor = (h: string) => {
  const color = harnessMetadataForLabel(h)?.color;
  return color === undefined ? id : harnessColors[color];
};

const API_PROVIDER_PATTERN = /API/;

export const provColor = (p: string) => (API_PROVIDER_PATTERN.test(p) ? clr.yellow : clr.green);

export const costStyle = (row: Row) => {
  const cost = usageRowPricedCost(row);
  if (cost == null) {
    return clr.grey;
  }
  if (cost >= 20) {
    return clr.redB;
  }
  if (cost >= 5) {
    return clr.yellow;
  }
  return id;
};
