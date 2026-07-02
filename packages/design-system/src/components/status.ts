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

export const statusDot = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '15px',
  h: '15px',
  borderRadius: 'full',
  flexShrink: 0,
});

export const statusDotLinked = css({
  bg: 'status.ok',
});

export const statusDotMissing = css({
  bg: 'transparent',
  border: '2px solid token(colors.status.warn)',
});

export const statusDotBroken = css({
  bg: 'status.danger',
});

export const statusDotCopy = css({
  bg: 'transparent',
  border: '2px dotted token(colors.muted)',
});

export const statusDotNone = css({
  w: '12px',
  h: '2px',
  borderRadius: 'full',
  bg: 'faint',
});
