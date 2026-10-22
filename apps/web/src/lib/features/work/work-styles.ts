import { css } from '@ai-usage/design-system/css';

export const workStack = css({ display: 'grid', gap: '16px', minW: 0 });
export const workPanel = css({
  p: { base: '16px', md: '20px' },
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  minW: 0,
});
export const workRow = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', minW: 0 });
export const workMuted = css({ color: 'muted', fontSize: '12px', lineHeight: 1.6, overflowWrap: 'anywhere' });
export const workHeading = css({ color: 'ink', fontSize: '16px', fontWeight: 550, overflowWrap: 'anywhere' });
export const workButton = css({
  minH: '44px',
  px: '12px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  color: 'ink',
  bg: 'surface',
  fontSize: '12px',
  cursor: 'pointer',
  _hover: { bg: 'surfaceMuted' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  _disabled: { opacity: 0.55, cursor: 'default' },
});
export const workLink = css({
  color: 'accent',
  minH: '44px',
  display: 'inline-flex',
  alignItems: 'center',
  textDecoration: 'underline',
  overflowWrap: 'anywhere',
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
export const workInput = css({
  minH: '44px',
  p: '8px',
  border: '1px solid token(colors.lineStrong)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  maxW: 'full',
});

// --- Resume surface -----------------------------------------------------------------------------

/** List beside a sticky detail column from 1024px up; one column below, where the detail is a drawer. */
export const workLayout = css({
  display: 'grid',
  gridTemplateColumns: { base: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(360px, 440px)' },
  gap: { base: '16px', lg: '24px' },
  alignItems: 'start',
  minW: 0,
});
export const workAside = css({
  display: { base: 'none', lg: 'grid' },
  position: 'sticky',
  top: '16px',
  maxH: 'calc(100vh - 32px)',
  overflowY: 'auto',
  overscrollBehaviorY: 'contain',
  minW: 0,
});
export const workCoverageLine = css({
  display: 'flex',
  flexWrap: 'wrap',
  columnGap: '14px',
  rowGap: '4px',
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
  minW: 0,
});
export const workFilterBar = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '8px',
  minW: 0,
});
export const workFilterGroup = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '6px',
  minW: 0,
});
export const workFilterLabel = css({
  color: 'faint',
  fontSize: '10px',
  fontWeight: 550,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  mr: '2px',
});
export const workChipButton = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  minH: { base: '44px', md: '32px' },
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  color: 'ink',
  fontSize: '12px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  _hover: { borderColor: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  '&[aria-pressed="true"]': { bg: 'ink', borderColor: 'ink', color: 'canvas' },
});
export const workChipCount = css({ color: 'inherit', opacity: 0.7, textStyle: 'numeric', fontSize: '11px' });
export const workSearchField = css({ minH: '44px', flex: '1 1 260px', maxW: '520px' });
export const workSection = css({ display: 'grid', gap: '6px', minW: 0 });
export const workSectionHeader = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '6px 12px',
  minW: 0,
  pt: '6px',
});
export const workSectionTitle = css({ color: 'ink', fontSize: '15px', fontWeight: 550, letterSpacing: '-0.01em' });
export const workSectionCount = css({ color: 'faint', fontSize: '12px', textStyle: 'numeric' });
export const workSectionNote = css({ flexBasis: '100%', color: 'muted', fontSize: '12px', lineHeight: 1.5 });
export const workRowList = css({
  listStyleType: 'none',
  m: 0,
  p: 0,
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  overflow: 'hidden',
  minW: 0,
});
export const workRowButton = css({
  appearance: 'none',
  display: 'grid',
  gap: '4px',
  w: 'full',
  minH: '44px',
  px: '12px',
  py: '9px',
  border: '0',
  borderBottom: '1px solid token(colors.line)',
  borderLeft: '3px solid transparent',
  bg: 'transparent',
  color: 'ink',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  minW: 0,
  _hover: { bg: 'surfaceMuted' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
  '&[aria-current="true"]': { bg: 'accentSoft', borderLeftColor: 'accent' },
  'li:last-child > &': { borderBottom: '0' },
});
export const workRowTop = css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px', minW: 0 });
export const workRowTitle = css({ fontSize: '14px', fontWeight: 550, lineHeight: 1.35, overflowWrap: 'anywhere' });
export const workMarker = css({
  color: 'faint',
  fontSize: '10px',
  fontWeight: 550,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
});
export const workRowMeta = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '2px 6px',
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
  minW: 0,
  overflowWrap: 'anywhere',
});
export const workQuestion = css({
  color: 'ink',
  fontSize: '13px',
  lineHeight: 1.45,
  lineClamp: 2,
  overflowWrap: 'anywhere',
});
export const workChipRow = css({ display: 'flex', flexWrap: 'wrap', gap: '4px 6px', minW: 0 });
export const workChip = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  minH: '20px',
  px: '6px',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '11px',
  lineHeight: 1.3,
  whiteSpace: 'nowrap',
});
export const workChipWarn = css({ bg: 'status.warnSoft', color: 'status.warn' });
export const workChipOk = css({ bg: 'status.okSoft', color: 'status.ok' });
export const workShowMore = css({
  minH: '44px',
  px: '12px',
  w: 'full',
  border: '0',
  bg: 'transparent',
  color: 'accent',
  fontSize: '12px',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: { textDecoration: 'underline' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '-2px' },
});
export const workDetail = css({ display: 'grid', gap: '16px', minW: 0 });
export const workDetailHeader = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '10px',
  alignItems: 'start',
  minW: 0,
});
export const workDetailTitle = css({
  color: 'ink',
  fontSize: '18px',
  fontWeight: 550,
  lineHeight: 1.3,
  letterSpacing: '-0.02em',
  overflowWrap: 'anywhere',
});
export const workDetailLabel = css({
  color: 'faint',
  fontSize: '10px',
  fontWeight: 550,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
});
export const workDetailQuestion = css({
  color: 'ink',
  fontSize: '14px',
  lineHeight: 1.5,
  px: '12px',
  py: '10px',
  borderLeft: '3px solid token(colors.accent)',
  bg: 'accentSoft',
  borderRadius: 'sm',
  overflowWrap: 'anywhere',
});
export const workDetailText = css({ color: 'ink', fontSize: '13px', lineHeight: 1.55, overflowWrap: 'anywhere' });
export const workFactList = css({ display: 'grid', gap: '8px', m: 0, p: 0, listStyleType: 'none' });
export const workFactItem = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'start',
  fontSize: '12px',
  lineHeight: 1.5,
  color: 'ink',
  overflowWrap: 'anywhere',
});
/** A bounded harness result: wrapped, scrollable past 240px, never a wall. */
export const workExcerpt = css({
  m: 0,
  p: '8px',
  maxH: '240px',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontSize: '12px',
  lineHeight: 1.5,
  color: 'ink',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
});
export const workInterpretation = css({
  display: 'grid',
  gap: '2px',
  pl: '10px',
  borderLeft: '2px solid token(colors.lineStrong)',
});
export const workCloseButton = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minW: '44px',
  minH: '44px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'muted',
  fontSize: '12px',
  cursor: 'pointer',
  _hover: { color: 'accent', borderColor: 'accent' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
export const workDrawerBody = css({
  p: '16px 20px',
  pb: 'calc(16px + env(safe-area-inset-bottom))',
  overflowY: 'auto',
  minH: 0,
});
/**
 * A question something later may have answered: muted and dashed, never styled as a current block.
 * Complete on its own rather than layered on `workQuestion`: atoms that conflict resolve by
 * stylesheet order, not by the order `cx` receives them.
 */
export const workQuestionToReconsider = css({
  color: 'muted',
  fontSize: '13px',
  lineHeight: 1.45,
  lineClamp: 2,
  overflowWrap: 'anywhere',
  pl: '8px',
  borderLeft: '2px dashed token(colors.line)',
});
/** A question the harness recorded as answered, handled or archived; complete for the same reason. */
export const workQuestionSettled = css({
  color: 'muted',
  fontSize: '13px',
  lineHeight: 1.45,
  lineClamp: 2,
  overflowWrap: 'anywhere',
});
export const workStandingMarker = css({
  px: '6px',
  borderRadius: 'sm',
  border: '1px dashed token(colors.line)',
  color: 'muted',
  fontSize: '11px',
  lineHeight: 1.5,
  whiteSpace: 'nowrap',
});
export const workRowDecision = css({ color: 'ink', fontSize: '12px', lineHeight: 1.5, overflowWrap: 'anywhere' });
export const workRowNext = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5, overflowWrap: 'anywhere' });
export const workSubsectionTitle = css({
  color: 'muted',
  fontSize: '12px',
  fontWeight: 550,
  letterSpacing: '0.02em',
  mt: '6px',
});
/** The detail's question when it is not a current block: no accent, a dashed rule; complete on its own. */
export const workDetailQuestionToReconsider = css({
  color: 'muted',
  fontSize: '14px',
  lineHeight: 1.5,
  px: '12px',
  py: '10px',
  borderLeft: '3px dashed token(colors.line)',
  bg: 'surfaceMuted',
  borderRadius: 'sm',
  overflowWrap: 'anywhere',
});
