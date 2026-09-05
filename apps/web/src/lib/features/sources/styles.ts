import { css } from '@ai-usage/design-system/css';

export const actionRow = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });
export const headerTop = css({
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: '16px',
});
export const headerActions = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '8px',
  flexShrink: 1,
  maxW: '100%',
  _print: { display: 'none' },
});
export const ghostButton = css({
  appearance: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  minH: { base: '44px', md: '36px' },
  px: '12px',
  py: '5px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'border-color 0.15s, color 0.15s',
  _hover: { borderColor: 'accent', color: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { cursor: 'not-allowed', opacity: 0.45 },
});
export const statusPill = css({
  display: 'inline-flex',
  alignItems: 'center',
  h: '22px',
  px: '8px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  fontSize: '11px',
  fontWeight: 650,
  lineHeight: 1,
  whiteSpace: 'nowrap',
});
export const statusPillOk = css({ bg: 'status.okSoft', borderColor: 'status.ok', color: 'status.ok' });
export const statusPillWarn = css({ bg: 'status.warnSoft', borderColor: 'status.warn', color: 'status.warn' });
export const statusPillDanger = css({
  bg: 'status.dangerSoft',
  borderColor: 'status.danger',
  color: 'status.danger',
});
export const statusPillInfo = css({ bg: 'surfaceMuted', borderColor: 'line', color: 'muted' });
export const banner = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '12px',
  alignItems: 'center',
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '13px',
});
export const bannerError = css({ bg: 'status.dangerSoft', borderColor: 'status.danger' });
