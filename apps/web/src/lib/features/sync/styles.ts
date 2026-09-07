import { css } from '@ai-usage/design-system/css';

// Sync-specific presentation stays on the Svelte-safe design-system surface.
export const actionRow = css({
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
});

export const panelHeader = css({ display: 'grid', gap: '6px', mb: '18px' });
export const strongCell = css({ fontWeight: 600, overflowWrap: 'anywhere' });

export const statusPill = css({
  alignItems: 'center',
  border: '1px solid transparent',
  borderRadius: 'full',
  display: 'inline-flex',
  fontSize: '11px',
  fontWeight: 650,
  h: '22px',
  lineHeight: 1,
  px: '8px',
  whiteSpace: 'nowrap',
});
export const statusPillOk = css({ bg: 'status.okSoft', color: 'status.ok' });
export const statusPillWarn = css({ bg: 'status.warnSoft', color: 'status.warn' });
export const statusPillInfo = css({ bg: 'surfaceMuted', color: 'muted' });

export const ghostButton = css({
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _hover: { borderColor: 'accent', color: 'accent' },
  alignItems: 'center',
  appearance: 'none',
  bg: 'surface',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  color: 'ink',
  cursor: 'pointer',
  display: 'inline-flex',
  fontSize: '12px',
  fontWeight: 600,
  justifyContent: 'center',
  minH: { base: '44px', md: '36px' },
  px: '12px',
  py: '5px',
  transition: 'border-color 0.15s, color 0.15s',
  _disabled: { cursor: 'not-allowed', opacity: 0.5 },
});

export const headerTop = css({
  alignItems: 'flex-start',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '16px',
  justifyContent: 'space-between',
});
export const pageStack = css({ display: 'grid', gap: '36px', minW: 0 });
export const unavailablePanel = css({
  alignContent: 'center',
  bg: 'surface',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  display: 'grid',
  gap: '8px',
  minH: '180px',
  mt: '20px',
  p: '22px',
});
export const unavailableText = css({ color: 'muted', fontSize: '13px', maxW: '620px' });
