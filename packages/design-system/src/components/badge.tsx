import { css, cx } from '@ai-usage/design-system/css';

const badge = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  h: '22px',
  px: '9px',
  borderRadius: 'full',
  fontSize: '11px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  _before: {
    content: '""',
    w: '6px',
    h: '6px',
    borderRadius: 'full',
    bg: 'currentColor',
  },
});

const badgeButton = css({
  appearance: 'none',
  border: '0',
  cursor: 'pointer',
  transition: 'box-shadow 0.15s, transform 0.15s',
  _hover: {
    boxShadow: '0 0 0 1px token(colors.accent)',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const badgeActive = css({
  boxShadow: '0 0 0 1.5px token(colors.accent)',
});

const badgeTones: Record<string, string> = {
  claude: css({ bg: 'harness.claude.bg', color: 'harness.claude.fg' }),
  codex: css({ bg: 'harness.codex.bg', color: 'harness.codex.fg' }),
  cursor: css({ bg: 'harness.cursor.bg', color: 'harness.cursor.fg' }),
  opencode: css({ bg: 'harness.opencode.bg', color: 'harness.opencode.fg' }),
  gemini: css({ bg: 'harness.gemini.bg', color: 'harness.gemini.fg' }),
};

const badgeNeutral = css({ bg: 'surfaceMuted', color: 'muted' });
const HARNESS_NAME_SEPARATOR = /[\s-]/;

export const harnessFamily = (name: string) => {
  const lower = name.toLowerCase();
  return badgeTones[lower] ? lower : (lower.split(HARNESS_NAME_SEPARATOR)[0] ?? '');
};

export const badgeToneFor = (name: string) => badgeTones[harnessFamily(name)] ?? badgeNeutral;

const harnessFillTones: Record<string, string> = {
  claude: css({ bg: 'harness.claude.fg' }),
  codex: css({ bg: 'harness.codex.fg' }),
  cursor: css({ bg: 'harness.cursor.fg' }),
  opencode: css({ bg: 'harness.opencode.fg' }),
  gemini: css({ bg: 'harness.gemini.fg' }),
};

export const harnessFillFor = (name: string) => harnessFillTones[harnessFamily(name)];

const harnessSvgFillTones: Record<string, string> = {
  claude: css({ fill: 'harness.claude.fg' }),
  codex: css({ fill: 'harness.codex.fg' }),
  cursor: css({ fill: 'harness.cursor.fg' }),
  opencode: css({ fill: 'harness.opencode.fg' }),
  gemini: css({ fill: 'harness.gemini.fg' }),
};

const harnessSvgFillNeutral = css({ fill: 'muted' });

export const harnessSvgFillFor = (name: string) => harnessSvgFillTones[harnessFamily(name)] ?? harnessSvgFillNeutral;

export const HarnessBadge = (props: { name: string; onClick?: () => void; active?: boolean; title?: string }) => {
  const className = () =>
    cx(
      badge,
      badgeToneFor(props.name),
      props.onClick ? badgeButton : undefined,
      props.active ? badgeActive : undefined,
    );
  if (!props.onClick) {
    return <span class={className()}>{props.name}</span>;
  }
  return (
    <button
      aria-pressed={props.active === undefined ? undefined : props.active}
      class={className()}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick?.();
      }}
      title={props.title ?? `Filter by ${props.name}`}
      type="button"
    >
      {props.name}
    </button>
  );
};
