import { css } from '@ai-usage/design-system/css';

export const commandButton = css({
  h: '36px',
  px: '16px',
  ml: 'auto',
  border: '1px solid token(colors.ink)',
  borderRadius: 'sm',
  bg: 'ink',
  color: 'canvas',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background-color 0.15s, border-color 0.15s',
  _hover: {
    bg: 'inkHover',
    borderColor: 'inkHover',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const ghostButton = css({
  appearance: 'none',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'muted',
  px: '12px',
  py: '5px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'border-color 0.15s, color 0.15s',
  _hover: {
    borderColor: 'accent',
    color: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const themeToggleButton = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '36px',
  h: '36px',
  flexShrink: 0,
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'muted',
  cursor: 'pointer',
  transition: 'color 0.15s, border-color 0.15s',
  _hover: {
    color: 'accent',
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
  _print: { display: 'none' },
});

export const activeFilterButton = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  h: '24px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  color: 'ink',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'border-color 0.15s, color 0.15s',
  _hover: {
    borderColor: 'accent',
    color: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const filterTextButton = css({
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
});

export const presetButton = css({
  appearance: 'none',
  h: '30px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'muted',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'border-color 0.15s, color 0.15s, background-color 0.15s',
  _hover: {
    borderColor: 'accent',
    color: 'accent',
  },
  '&[data-active="true"]': {
    bg: 'accentSoft',
    borderColor: 'accent',
    color: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const sortButton = css({
  appearance: 'none',
  display: 'inline-flex',
  gap: '5px',
  alignItems: 'center',
  border: '0',
  p: '0',
  bg: 'transparent',
  color: 'inherit',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  cursor: 'pointer',
  _hover: {
    color: 'ink',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const refreshButton = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  h: '100%',
  p: 0,
  border: '0',
  bg: 'transparent',
  color: 'accent',
  fontSize: '12px',
  fontWeight: 650,
  lineHeight: 1,
  minW: '44px',
  justifyContent: 'center',
  cursor: 'pointer',
  transition: 'color 0.15s',
  _hover: {
    color: 'ink',
  },
  _disabled: {
    color: 'faint',
    cursor: 'not-allowed',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const refreshIconButton = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '22px',
  h: '22px',
  p: 0,
  border: '0',
  borderRadius: 'xs',
  bg: 'transparent',
  color: 'faint',
  fontFamily: 'mono',
  fontSize: '11px',
  fontWeight: 650,
  lineHeight: 1,
  cursor: 'pointer',
  transition: 'color 0.15s, background-color 0.15s',
  _hover: {
    bg: 'surfaceMuted',
    color: 'accent',
  },
  _disabled: {
    bg: 'transparent',
    color: 'faint',
    cursor: 'not-allowed',
    opacity: 0.55,
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const drawerClose = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '30px',
  h: '30px',
  flexShrink: 0,
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'transparent',
  color: 'muted',
  fontSize: '14px',
  lineHeight: '1',
  cursor: 'pointer',
  transition: 'color 0.15s, border-color 0.15s',
  _hover: {
    color: 'accent',
    borderColor: 'accent',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
  _disabled: {
    opacity: 0.4,
    cursor: 'default',
    _hover: {
      color: 'muted',
      borderColor: 'line',
    },
  },
});

export const topRow = css({
  appearance: 'none',
  display: 'grid',
  gridTemplateColumns: '24px minmax(0, 1fr) auto auto',
  gap: '12px',
  alignItems: 'center',
  textAlign: 'left',
  px: '4px',
  py: '10px',
  border: '0',
  borderBottom: '1px solid token(colors.line)',
  bg: 'transparent',
  cursor: 'pointer',
  transition: 'background-color 0.1s',
  _hover: {
    bg: 'surfaceMuted',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '-2px',
  },
  _last: {
    borderBottom: '0',
  },
});
