import { css } from '@ai-usage/design-system/css';

export const stack = css({ display: 'grid', gap: '12px' });
export const compactStack = css({ display: 'grid', gap: '7px' });
export const heading = css({ fontWeight: 700 });
export const muted = css({ color: 'muted', fontSize: '12px' });
export const pathText = css({ fontFamily: 'mono', fontSize: '11px', color: 'muted', overflowWrap: 'anywhere' });
export const pill = css({
  display: 'inline-flex',
  alignItems: 'center',
  w: 'fit-content',
  px: '7px',
  py: '2px',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '10px',
  fontWeight: 700,
  textTransform: 'uppercase',
});
export const infoPill = css({ bg: 'accentTint', color: 'accent' });
export const warningPill = css({ bg: 'status.warnSoft', color: 'status.warn' });
export const dangerPill = css({ bg: 'status.dangerSoft', color: 'status.danger' });
export const button = css({
  appearance: 'none',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  px: '10px',
  py: '7px',
  cursor: 'pointer',
  fontSize: '12px',
  _hover: { borderColor: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { cursor: 'default', opacity: 0.5 },
});
export const primaryButton = css({ bg: 'accent', color: 'surface', borderColor: 'accent' });
export const diagnosticRow = css({
  display: 'grid',
  gap: '4px',
  minW: 0,
  p: '8px 0',
  border: 0,
  borderTop: '1px solid token(colors.line)',
});
export const switchButton = css({
  appearance: 'none',
  position: 'relative',
  w: '32px',
  h: '18px',
  flexShrink: 0,
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  cursor: 'pointer',
  _after: {
    content: '""',
    position: 'absolute',
    top: '2px',
    left: '2px',
    w: '12px',
    h: '12px',
    borderRadius: 'full',
    bg: 'muted',
    transition: 'transform 0.15s, background-color 0.15s',
  },
  '&[aria-checked=true]': {
    bg: 'status.okSoft',
    borderColor: 'status.ok',
    _after: { bg: 'status.ok', transform: 'translateX(14px)' },
  },
  '&[data-pending=true]': {
    borderColor: 'accent',
    _before: {
      content: '"… "',
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'accent',
      fontSize: '13px',
      fontWeight: 800,
      lineHeight: 1,
    },
    _after: {
      opacity: 0.25,
    },
  },
  _disabled: { opacity: 0.5, cursor: 'not-allowed' },
});
export const notice = css({ p: '8px', borderRadius: 'sm', bg: 'accentTint', fontSize: '12px' });
export const errorNotice = css({ bg: 'status.dangerSoft', color: 'status.danger' });
export const operationNotice = css({
  position: 'fixed',
  zIndex: 50,
  bottom: { base: '80px', lg: '16px' },
  right: { base: '12px', sm: '16px' },
  w: { base: 'calc(100vw - 24px)', sm: 'auto' },
  maxW: '420px',
  boxShadow: 'overlay',
});
export const passiveOperationNotice = css({ pointerEvents: 'none' });
