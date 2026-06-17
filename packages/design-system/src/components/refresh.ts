import { css } from '@ai-usage/design-system/css';

export const refreshStatus = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  h: '36px',
  px: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1,
  whiteSpace: 'nowrap',
});

export const refreshStatusError = css({
  borderColor: 'accent',
  color: 'accent',
});

export const refreshRing = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '16px',
  h: '16px',
  borderRadius: 'full',
  color: 'chart.c2',
  flexShrink: 0,
  bg: 'conic-gradient(currentColor calc(var(--refresh-progress) * 1turn), token(colors.track) 0)',
  transition: 'background 0.15s, color 0.15s, opacity 0.15s',
  _after: {
    content: '""',
    w: '10px',
    h: '10px',
    borderRadius: 'full',
    bg: 'surface',
  },
});

export const refreshRingIdle = css({ color: 'chart.c4' });
export const refreshRingRefreshing = css({ color: 'chart.c6' });
export const refreshRingSuccess = css({ color: 'chart.c2' });
export const refreshRingDelayed = css({ color: 'chart.c5' });
export const refreshRingError = css({ color: 'accent' });
export const refreshRingStatic = css({ bg: 'transparent', border: '1px solid token(colors.faint)' });
export const refreshRingPaused = css({ bg: 'transparent', border: '1px solid currentColor', opacity: 0.8 });
