import { css } from '@ai-usage/design-system/css';

// Sync-local presentation styles keep the browser closure on the Svelte-safe
// design-system surface. Values intentionally match the legacy report layout.
export const actionRow = css({
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
});

export const panelHeader = css({ display: 'grid', gap: '2px' });
export const strongCell = css({ fontWeight: 600, overflowWrap: 'anywhere' });

export const statusPill = css({
  alignItems: 'center',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  display: 'inline-flex',
  fontSize: '11px',
  fontWeight: 650,
  h: '22px',
  lineHeight: 1,
  px: '8px',
  whiteSpace: 'nowrap',
});
export const statusPillOk = css({ bg: 'status.okSoft', borderColor: 'status.ok', color: 'status.ok' });
export const statusPillWarn = css({ bg: 'status.warnSoft', borderColor: 'status.warn', color: 'status.warn' });
export const statusPillInfo = css({ bg: 'surfaceMuted', borderColor: 'line', color: 'muted' });

export const ghostButton = css({
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _hover: { borderColor: 'accent', color: 'accent' },
  alignItems: 'center',
  appearance: 'none',
  bg: 'surface',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  color: 'muted',
  cursor: 'pointer',
  display: 'inline-flex',
  fontSize: '12px',
  fontWeight: 600,
  justifyContent: 'center',
  px: '12px',
  py: '5px',
  transition: 'border-color 0.15s, color 0.15s',
});

export const headerTop = css({
  alignItems: 'flex-start',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '16px',
  justifyContent: 'space-between',
});
export const pageStack = css({ display: 'grid', gap: '16px' });
export const unavailablePanel = css({
  alignContent: 'center',
  bg: 'surface',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
  display: 'grid',
  gap: '8px',
  minH: '180px',
  mt: '20px',
  p: '22px',
});
export const unavailableText = css({ color: 'muted', fontSize: '13px', maxW: '620px' });
