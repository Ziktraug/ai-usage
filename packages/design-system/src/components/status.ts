import { css } from '@ai-usage/design-system/css';

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

export const statusPillOk = css({
  bg: 'status.okSoft',
  borderColor: 'status.ok',
  color: 'status.ok',
});

export const statusPillWarn = css({
  bg: 'status.warnSoft',
  borderColor: 'status.warn',
  color: 'status.warn',
});

export const statusPillDanger = css({
  bg: 'status.dangerSoft',
  borderColor: 'status.danger',
  color: 'status.danger',
});

export const statusPillInfo = css({
  bg: 'surfaceMuted',
  borderColor: 'line',
  color: 'muted',
});

// The circular exposure dots that used to live here were replaced by letterform marks rendered by
// the skills surfaces themselves: at 12–15px a dashed ring and a plain ring were indistinguishable,
// and two of the state hues share a deutan appearance — shape and letter now carry the state.

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

export const bannerError = css({
  bg: 'status.dangerSoft',
  borderColor: 'status.danger',
});

export const bannerOk = css({
  bg: 'status.okSoft',
  borderColor: 'status.ok',
});
