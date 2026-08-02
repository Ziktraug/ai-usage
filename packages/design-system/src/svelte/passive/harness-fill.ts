import { css } from '@ai-usage/design-system/css';

const HARNESS_NAME_SEPARATOR = /[\s-]/;

const harnessFillTones: Readonly<Record<string, string>> = {
  claude: css({ bg: 'harness.claude.fg' }),
  codex: css({ bg: 'harness.codex.fg' }),
  cursor: css({ bg: 'harness.cursor.fg' }),
  opencode: css({ bg: 'harness.opencode.fg' }),
  gemini: css({ bg: 'harness.gemini.fg' }),
};

const harnessFamily = (name: string): string => {
  const lowerName = name.toLowerCase();
  return harnessFillTones[lowerName] ? lowerName : (lowerName.split(HARNESS_NAME_SEPARATOR)[0] ?? '');
};

export const harnessFillFor = (name: string): string | undefined => harnessFillTones[harnessFamily(name)];
