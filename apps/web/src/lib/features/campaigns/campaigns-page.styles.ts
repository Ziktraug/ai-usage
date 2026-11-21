import { css } from '@ai-usage/design-system/css';

export const toolbar = css({ display: 'flex', alignItems: 'end', flexWrap: 'wrap', gap: '12px', mb: '24px' });
export const viewControls = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', mt: '2px', mb: '20px' });
export const activeViewButton = css.raw({ bg: 'accentTint', borderColor: 'accent', color: 'ink' });
export const field = css({ display: 'grid', gap: '5px', color: 'muted', fontSize: '11px' });
export const input = css({
  minH: '40px',
  px: '12px',
  py: '7px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '12px',
  maxW: 'full',
  _focusVisible: { outline: '2px solid token(colors.accent)' },
});
export const layout = css({
  display: 'grid',
  gridTemplateColumns: { base: 'minmax(0, 1fr)', lg: 'minmax(230px, 0.38fr) minmax(0, 1fr)' },
  alignItems: 'start',
  gap: '24px',
  '&[data-mobile-map=true] > section': { display: { base: 'none', lg: 'block' } },
  '&[data-mobile-map=false] > div': { display: { base: 'none', lg: 'grid' } },
  minW: 0,
});
export const mobileBack = css({
  display: { base: 'block', lg: 'none' },
  p: '12px',
  color: 'accent',
  cursor: 'pointer',
});
export const campaignList = css({
  display: 'grid',
  gap: '6px',
  minW: 0,
  '& [data-campaign-scroll]': { h: { base: '65dvh', lg: 'calc(100dvh - 330px)' } },
  pr: '4px',
});
export const cardStyle = css.raw({
  display: 'grid',
  gap: '7px',
  p: '14px',
  textAlign: 'left',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  color: 'ink',
  cursor: 'pointer',
  minW: 0,
  w: 'full',
  _hover: { bg: 'accentTint' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
});
export const card = css(cardStyle);
export const activeCard = css.raw({ bg: 'accentTint', borderColor: 'accent' });
export const title = css({ fontSize: '13px', fontWeight: 600, lineHeight: 1.45, overflowWrap: 'anywhere' });
export const muted = css({ color: 'muted', fontSize: '11px', lineHeight: 1.55 });
export const detail = css({
  display: 'grid',
  gap: '16px',
  minW: 0,
  border: '1px solid token(colors.line)',
  borderRadius: 'lg',
  p: { base: '16px', md: '24px' },
  bg: 'surface',
});
export const empty = css({
  display: 'grid',
  gap: '12px',
  p: '24px',
  border: '1px dashed token(colors.lineStrong)',
  borderRadius: 'md',
  color: 'muted',
  fontSize: '13px',
  lineHeight: 1.7,
});
export const notice = css({ color: 'muted', fontSize: '12px', lineHeight: 1.6, mb: '12px' });
