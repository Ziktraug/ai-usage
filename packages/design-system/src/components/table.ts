import { css, cx } from '@ai-usage/design-system/css';

export const table = css({
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  minW: '1040px',
  tableLayout: 'fixed',
  fontSize: '13px',
  '& th': {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    bg: 'surface',
    textStyle: 'label',
    color: 'muted',
    textAlign: 'left',
    py: '10px',
    px: '12px',
    borderBottom: '1px solid token(colors.line)',
  },
  '& td': {
    py: '10px',
    px: '12px',
    borderBottom: '1px solid token(colors.line)',
    verticalAlign: 'middle',
  },
  '& tr:last-child td': {
    borderBottom: '0',
  },
});

export const sessionsTable = css({
  '& tbody tr[data-selected]': {
    cursor: 'pointer',
    transition: 'background-color 0.1s',
  },
  '& tbody tr[data-selected]:hover td': {
    bg: 'surfaceMuted',
  },
  '& tbody tr[data-selected]:hover td:first-child': {
    boxShadow: 'inset 2px 0 0 token(colors.lineStrong)',
  },
  '& tbody tr[data-selected] td:last-child': {
    position: 'relative',
    pr: '26px',
  },
  '& tbody tr[data-selected] td:last-child::after': {
    content: '"›"',
    position: 'absolute',
    right: '10px',
    top: '50%',
    transform: 'translateY(-50%)',
    color: 'faint',
    fontSize: '14px',
    opacity: 0,
    transition: 'opacity 0.1s',
  },
  '& tbody tr[data-selected]:hover td:last-child::after': {
    opacity: 1,
    color: 'accent',
  },
  '& tbody tr:focus-visible': {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '-2px',
  },
  '& tbody tr[data-selected="true"] td': {
    bg: 'accentTint',
  },
  '& tbody tr[data-selected="true"] td:first-child': {
    boxShadow: 'inset 2px 0 0 token(colors.accent)',
  },
});

export const tableWrap = css({
  overflow: 'auto',
  maxH: 'calc(100dvh - 240px)',
  minH: '320px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  backgroundImage: `linear-gradient(to bottom, token(colors.surface) 30%, transparent),
    linear-gradient(to top, token(colors.surface) 30%, transparent),
    linear-gradient(to bottom, token(colors.lineStrong), transparent),
    linear-gradient(to top, token(colors.lineStrong), transparent)`,
  backgroundPosition: 'top, bottom, top, bottom',
  backgroundRepeat: 'no-repeat',
  backgroundSize: '100% 36px, 100% 36px, 100% 10px, 100% 10px',
  backgroundAttachment: 'local, local, scroll, scroll',
  _print: { maxH: 'none', overflow: 'visible', boxShadow: 'none' },
});

export const desktopTableSurface = css({
  display: { base: 'none', md: 'block' },
  _print: { display: 'block' },
});

export const mobileSummarySurface = css({
  display: { base: 'grid', md: 'none' },
  _print: { display: 'none' },
});

export const tableControls = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  alignItems: 'center',
  justifyContent: 'flex-end',
  _print: { display: 'none' },
});

export const right = css({ textAlign: 'right' });
export const muted = css({ color: 'muted' });
export const strongCell = css({ fontWeight: 600, overflowWrap: 'anywhere' });
export const numCell = css({
  textStyle: 'numeric',
  textAlign: 'right',
  fontSize: '12px',
});
export const dateCell = css({
  fontFamily: 'mono',
  fontSize: '12px',
  lineHeight: '1.4',
  color: 'muted',
});
export const sessionCell = css({ fontWeight: 600, overflowWrap: 'break-word' });
export const sessionTitleClamp = css({
  lineClamp: 2,
});
export const modelCell = css({
  fontFamily: 'mono',
  fontSize: '12px',
  fontWeight: 500,
  overflowWrap: 'anywhere',
});
export const projectTable = css({
  minW: '780px',
});

export const projectSummaryList = css({
  gap: '10px',
  m: 0,
  p: 0,
  listStyle: 'none',
});

export const projectSummaryCard = css({
  display: 'grid',
  gap: '12px',
  p: '14px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
});

export const projectSummaryHeader = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '12px',
  alignItems: 'start',
});

export const projectSummaryHeadline = css({
  display: 'grid',
  gap: '3px',
  justifyItems: 'end',
  textAlign: 'right',
});

export const projectSummaryCost = css({
  textStyle: 'numeric',
  color: 'ink',
  fontSize: '14px',
  fontWeight: 700,
});

export const projectSummarySessions = css({
  color: 'muted',
  fontSize: '11px',
});

export const projectSummaryMetrics = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '8px',
  m: 0,
});

export const projectSummaryMetric = css({
  display: 'grid',
  gap: '2px',
  minW: 0,
  m: 0,
  '& dt': {
    color: 'faint',
    fontSize: '9px',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  '& dd': {
    textStyle: 'numeric',
    m: 0,
    color: 'muted',
    fontSize: '11px',
    overflowWrap: 'anywhere',
  },
});

export const sessionDesktopControl = css({
  display: { base: 'none', md: 'block' },
});

export const sessionSummaryMobileSort = css({
  display: { base: 'flex', md: 'none' },
  flex: '1 0 100%',
  alignItems: 'end',
  justifyContent: 'space-between',
  gap: '8px',
  w: '100%',
  '& > button': {
    minH: '44px',
  },
});

export const sessionSummaryMobileSortField = css({
  display: 'grid',
  gap: '3px',
  minW: 0,
  flex: '1 1 auto',
  color: 'faint',
  fontSize: '9px',
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
});

export const sessionSummaryMobileSortSelect = css({
  appearance: 'none',
  w: '100%',
  minH: '44px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
  color: 'ink',
  fontSize: '12px',
  fontWeight: 600,
  textTransform: 'none',
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const sessionSummaryViewport = css({
  gap: 0,
  maxH: 'calc(100dvh - 240px)',
  minH: '320px',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  m: 0,
  p: 0,
  listStyle: 'none',
});

export const sessionSummaryRow = css({
  h: '188px',
  p: '0 0 8px',
});

export const sessionSummaryCard = css({
  display: 'grid',
  gridTemplateRows: 'auto minmax(0, 1fr) auto',
  gap: '8px',
  h: '180px',
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  boxShadow: 'card',
  '&[data-selected="true"]': {
    borderColor: 'accent',
    bg: 'accentTint',
  },
  '&[data-depth="1"]': {
    ml: '14px',
    borderLeft: '2px solid token(colors.accent)',
  },
});

export const sessionSummaryHeader = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  minW: 0,
});

export const sessionSummaryDate = css({
  color: 'muted',
  fontFamily: 'mono',
  fontSize: '10px',
});

export const sessionSummaryOpen = css({
  appearance: 'none',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '10px',
  alignItems: 'start',
  minW: 0,
  minH: '44px',
  p: 0,
  border: 0,
  bg: 'transparent',
  color: 'ink',
  cursor: 'pointer',
  textAlign: 'left',
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '3px',
  },
});

export const sessionSummaryTitle = css({
  lineClamp: 2,
  fontSize: '13px',
  fontWeight: 650,
  lineHeight: 1.35,
  overflowWrap: 'anywhere',
});

export const sessionSummaryValue = css({
  textStyle: 'numeric',
  color: 'ink',
  fontSize: '13px',
  fontWeight: 700,
  whiteSpace: 'nowrap',
});

export const sessionSummaryFooter = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: '5px',
  alignItems: 'end',
});

export const sessionSummaryFilters = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(78px, 1fr))',
  gap: '6px',
  minW: 0,
});

export const sessionSummaryFilter = css({
  appearance: 'none',
  display: 'block',
  minW: 0,
  minH: '44px',
  px: '6px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
  color: 'muted',
  cursor: 'pointer',
  fontFamily: 'mono',
  fontSize: '10.5px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  _hover: { borderColor: 'accent', color: 'accent' },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

export const sessionSummaryStats = css({
  textStyle: 'numeric',
  color: 'faint',
  fontSize: '10px',
  whiteSpace: 'nowrap',
});

export const sessionSummaryLoadMore = css({
  display: { base: 'flex', md: 'none' },
  justifyContent: 'center',
  pt: '10px',
  '& button': {
    minH: '44px',
  },
});

export const sessionPagingLoadMore = css({
  display: 'flex',
  justifyContent: 'center',
  pt: '10px',
  '& button': {
    minH: '44px',
  },
});

export const groupKeyButton = cx(
  css({
    appearance: 'none',
    display: 'inline',
    maxW: '100%',
    border: '0',
    p: '0',
    bg: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    overflowWrap: 'anywhere',
    cursor: 'pointer',
    _hover: {
      color: 'accent',
      textDecoration: 'underline',
      textUnderlineOffset: '2px',
    },
    _focusVisible: {
      outline: '2px solid token(colors.accent)',
      outlineOffset: '2px',
    },
  }),
  css({ fontWeight: 600 }),
);
