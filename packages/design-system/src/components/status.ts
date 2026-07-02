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
  color: 'canvas',
  fontSize: '10px',
  fontWeight: 800,
  lineHeight: 1,
});

export const statusDotLinked = css({
  bg: 'status.ok',
  _before: {
    content: '"✓"',
  },
});

export const statusDotMissing = css({
  bg: 'transparent',
  border: '2px solid token(colors.status.warn)',
});

export const statusDotBroken = css({
  bg: 'status.danger',
  borderRadius: 'xs',
  _before: {
    content: '"!"',
  },
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
