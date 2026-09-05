import { css } from '@ai-usage/design-system/css';

export const stack = css({ display: 'grid', gap: '14px', minW: 0 });
export const row = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' });
export const panel = css({
  display: 'grid',
  gap: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  p: '14px',
  bg: 'surface',
});
export const panelHeader = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'center',
  justifyContent: 'space-between',
});
export const title = css({ fontSize: '16px', fontWeight: 700 });
export const muted = css({ color: 'muted', fontSize: '12px' });
export const field = css({
  h: { base: '44px', sm: '36px' },
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  px: '12px',
  fontSize: '13px',
  outline: 'none',
  _placeholder: { color: 'faint' },
  _focusVisible: { borderColor: 'accent', boxShadow: '0 0 0 3px token(colors.focusRing)' },
});
export const button = css({
  appearance: 'none',
  minH: '32px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  px: '10px',
  fontSize: '12px',
  fontWeight: 650,
  cursor: 'pointer',
  _hover: { borderColor: 'accent', color: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { cursor: 'not-allowed', opacity: 0.5 },
});
export const selectedButton = css({ borderColor: 'accent', bg: 'accentTint', color: 'ink' });
export const pill = css({
  appearance: 'none',
  minH: '28px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  color: 'ink',
  px: '10px',
  fontSize: '11px',
  cursor: 'pointer',
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
export const list = css({ display: 'grid', gap: '8px' });
export const item = css({
  display: 'grid',
  gridTemplateColumns: { base: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' },
  gap: '10px',
  alignItems: 'center',
  borderTop: '1px solid token(colors.line)',
  pt: '10px',
});
export const partialBarTrack = css({ border: '1px dashed token(colors.accent)' });
export const toolbar = css({
  position: { base: 'static', md: 'sticky' },
  top: 0,
  zIndex: 20,
  display: { base: 'grid', sm: 'flex' },
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  flexDirection: { base: 'column', sm: 'row' },
  flexWrap: { base: 'nowrap', sm: 'wrap', xl: 'nowrap' },
  gap: { base: '8px', sm: '10px' },
  alignItems: 'center',
  py: { base: '8px', sm: '12px' },
  bg: 'canvas',
  borderBottom: '1px solid token(colors.line)',
  _print: { display: 'none' },
  '& > input': {
    flex: { base: 'none', sm: '1 1 240px', lg: '1 1 180px' },
    minH: { base: '44px', sm: '36px' },
    minW: { base: 0, sm: '180px' },
    w: { base: 'full', sm: 'auto' },
  },
});
export const controls = css({
  display: { base: 'none', sm: 'contents' },
  '&[data-expanded=true]': { display: { base: 'grid', sm: 'contents' } },
  gridColumn: '1 / -1',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  w: { base: 'full', sm: 'auto' },
  gap: { base: '8px', sm: '0' },
  alignItems: 'center',
  '& > *': {
    minW: 0,
    w: { base: 'full', sm: 'auto' },
  },
  '& button, & a': { minH: { base: '44px', sm: '36px' } },
  '& > :last-child:nth-child(odd)': { gridColumn: { base: '1 / -1', sm: 'auto' } },
});
export const actions = css({
  alignItems: 'center',
  display: { base: 'contents', sm: 'flex' },
  flexShrink: 0,
  gap: { base: '8px', sm: '6px' },
  ml: { base: 0, sm: 'auto' },
  minW: 0,
  '& > [aria-label="Collection source status"]': {
    ml: 0,
    gap: { base: '4px', sm: '8px' },
    '& > a, & > button': { px: { base: '4px', sm: '10px' } },
    '& > button': { whiteSpace: 'nowrap' },
  },
});

export const table = css({ w: 'full', borderCollapse: 'collapse', fontSize: '12px' });
export const tableCell = css({ borderTop: '1px solid token(colors.line)', p: '6px', textAlign: 'left' });

export const analysisTabs = css({
  minW: 0,
  '& [role="tab"]': { minH: { base: '44px', md: '40px' } },
});
export const analysisPanel = css({ overflow: 'hidden' });
export const analysisActions = css({
  gridColumn: '1 / -1',
  minW: 0,
  '& > *': { minW: 0, maxW: 'full' },
  '& > input': {
    flex: { base: '1 1 100%', sm: '1 1 240px' },
    minH: { base: '44px', md: '36px' },
    w: { base: 'full', sm: 'auto' },
  },
  '& button': { minH: { base: '44px', md: '36px' } },
});
export const modelTableViewport = css({
  display: { base: 'none', md: 'block' },
  maxW: 'full',
  minW: 0,
  overflowX: 'auto',
});
export const modelTable = css({
  w: 'full',
  minW: '760px',
  borderCollapse: 'collapse',
  fontSize: '12px',
});
export const modelTableIntro = css({
  display: 'grid',
  gap: '3px',
  p: '12px 16px',
  borderBottom: '1px solid token(colors.line)',
});
export const modelTableIntroTitle = css({
  m: 0,
  color: 'ink',
  fontSize: '12px',
  fontWeight: 700,
});
export const modelTableDescription = css({
  m: 0,
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
});
export const modelTableHeaderCell = css({
  p: '10px 12px',
  borderBottom: '1px solid token(colors.lineStrong)',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '11px',
  fontWeight: 700,
  lineHeight: 1.35,
  verticalAlign: 'bottom',
});
export const modelTableCell = css({
  p: '12px',
  borderBottom: '1px solid token(colors.line)',
  color: 'ink',
  lineHeight: 1.45,
  verticalAlign: 'top',
});
// `textAlign` has to live on exactly one of the classes a cell composes. `cx` keeps both atoms and
// the winner is stylesheet order, not call order, so a base `left` silently beat the numeric `right`
// and every figure column read as text.
export const modelTextCell = css({
  textAlign: 'left',
});
export const modelNumericCell = css({
  textStyle: 'numeric',
  textAlign: 'right',
});
export const modelNameButton = css({
  appearance: 'none',
  maxW: '100%',
  minH: { base: '44px', md: '32px' },
  border: 0,
  p: { base: '8px 0', md: 0 },
  bg: 'transparent',
  color: 'ink',
  font: 'inherit',
  fontWeight: 650,
  textAlign: 'left',
  overflowWrap: 'anywhere',
  cursor: 'pointer',
  _hover: { color: 'accent', textDecoration: 'underline', textUnderlineOffset: '2px' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
export const modelQualification = css({
  display: 'block',
  mt: '3px',
  color: 'status.warn',
  fontSize: '11px',
  lineHeight: 1.4,
  overflowWrap: 'anywhere',
});
export const modelAssistiveText = css({
  position: 'absolute',
  w: '1px',
  h: '1px',
  p: 0,
  m: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
});
export const modelCards = css({
  display: { base: 'grid', md: 'none' },
  gap: 0,
  m: 0,
  p: 0,
  listStyle: 'none',
});
export const modelCardsDescription = css({
  display: { base: 'block', md: 'none' },
  m: 0,
  p: '12px 16px',
  borderBottom: '1px solid token(colors.line)',
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
});
export const modelCard = css({
  display: 'grid',
  gap: '12px',
  p: '14px 16px 16px',
  borderBottom: '1px solid token(colors.line)',
});
export const modelCardHeader = css({
  display: 'flex',
  gap: '12px',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  minW: 0,
});
export const modelCardPrimaryValue = css({
  textStyle: 'numeric',
  display: 'grid',
  gap: '2px',
  flexShrink: 0,
  pt: '6px',
  fontSize: '14px',
  fontWeight: 700,
  textAlign: 'right',
});
export const modelCardMetrics = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '12px 16px',
  m: 0,
});
export const modelCardMetric = css({ minW: 0 });
export const modelCardTerm = css({
  color: 'muted',
  fontSize: '11px',
  fontWeight: 650,
  lineHeight: 1.35,
});
export const modelCardValue = css({
  textStyle: 'numeric',
  mt: '3px',
  color: 'ink',
  fontSize: '13px',
  lineHeight: 1.4,
  overflowWrap: 'anywhere',
});
export const modelEmpty = css({
  p: '20px 16px',
  color: 'muted',
  fontSize: '12px',
  textAlign: 'center',
});
