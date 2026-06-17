import { css, cx } from '@ai-usage/design-system/css';

export const table = css({
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  minW: '1040px',
  tableLayout: 'fixed',
  fontSize: '13px',
  '& th': {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    bg: 'surface',
    textStyle: 'label',
    color: 'muted',
    textAlign: 'left',
    py: '10px',
    px: '12px',
    borderBottom: '1px solid token(colors.line)',
  },
  '& td': {
    py: '10px',
    px: '12px',
    borderBottom: '1px solid token(colors.line)',
    verticalAlign: 'middle',
  },
  '& tr:last-child td': {
    borderBottom: '0',
  },
});

export const sessionsTable = css({
  '& tbody tr[data-selected]': {
    cursor: 'pointer',
    transition: 'background-color 0.1s',
  },
  '& tbody tr[data-selected]:hover td': {
    bg: 'surfaceMuted',
  },
  '& tbody tr[data-selected]:hover td:first-child': {
    boxShadow: 'inset 2px 0 0 token(colors.lineStrong)',
  },
  '& tbody tr[data-selected] td:last-child': {
    position: 'relative',
    pr: '26px',
  },
  '& tbody tr[data-selected] td:last-child::after': {
    content: '"›"',
    position: 'absolute',
    right: '10px',
    top: '50%',
    transform: 'translateY(-50%)',
    color: 'faint',
    fontSize: '14px',
    opacity: 0,
    transition: 'opacity 0.1s',
  },
  '& tbody tr[data-selected]:hover td:last-child::after': {
    opacity: 1,
    color: 'accent',
  },
  '& tbody tr:focus-visible': {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '-2px',
  },
  '& tbody tr[data-selected="true"] td': {
    bg: 'accentTint',
  },
  '& tbody tr[data-selected="true"] td:first-child': {
    boxShadow: 'inset 2px 0 0 token(colors.accent)',
  },
});

export const tableWrap = css({
  overflow: 'auto',
  maxH: 'calc(100dvh - 240px)',
  minH: '320px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  backgroundImage: `linear-gradient(to bottom, token(colors.surface) 30%, transparent),
    linear-gradient(to top, token(colors.surface) 30%, transparent),
    linear-gradient(to bottom, token(colors.lineStrong), transparent),
    linear-gradient(to top, token(colors.lineStrong), transparent)`,
  backgroundPosition: 'top, bottom, top, bottom',
  backgroundRepeat: 'no-repeat',
  backgroundSize: '100% 36px, 100% 36px, 100% 10px, 100% 10px',
  backgroundAttachment: 'local, local, scroll, scroll',
  _print: { maxH: 'none', overflow: 'visible', boxShadow: 'none' },
});

export const tableControls = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'center',
  justifyContent: 'flex-end',
  _print: { display: 'none' },
});

export const right = css({ textAlign: 'right' });
export const muted = css({ color: 'muted' });
export const strongCell = css({ fontWeight: 600, overflowWrap: 'anywhere' });
export const numCell = css({
  textStyle: 'numeric',
  textAlign: 'right',
  fontSize: '12px',
});
export const dateCell = css({
  fontFamily: 'mono',
  fontSize: '12px',
  lineHeight: '1.4',
  color: 'muted',
});
export const sessionCell = css({ fontWeight: 600, overflowWrap: 'break-word' });
export const sessionTitleClamp = css({
  lineClamp: 2,
});
export const modelCell = css({
  fontFamily: 'mono',
  fontSize: '12px',
  fontWeight: 500,
  overflowWrap: 'anywhere',
});
export const projectTable = css({
  minW: '780px',
});

export const groupKeyButton = cx(
  css({
    appearance: 'none',
    display: 'inline',
    maxW: '100%',
    border: '0',
    p: '0',
    bg: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    overflowWrap: 'anywhere',
    cursor: 'pointer',
    _hover: {
      color: 'accent',
      textDecoration: 'underline',
      textUnderlineOffset: '2px',
    },
    _focusVisible: {
      outline: '2px solid token(colors.accent)',
      outlineOffset: '2px',
    },
  }),
  css({ fontWeight: 600 }),
);
