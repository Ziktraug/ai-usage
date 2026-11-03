import { css } from '@ai-usage/design-system/css';

/** Extract semantic aliases before token pruning; graph layout CSS stays with its route. */
export const graphTheme = css({
  '--graph-ink': 'token(colors.ink)',
  '--graph-surface': 'token(colors.surface)',
  '--graph-soft': 'token(colors.surfaceMuted)',
  '--graph-muted': 'token(colors.muted)',
  '--graph-accent': 'token(colors.accent)',
  '--graph-line': 'token(colors.line)',
  '--graph-track': 'token(colors.track)',
  '--graph-radius-sm': 'token(radii.sm)',
  '--graph-radius-md': 'token(radii.md)',
  '--graph-mono': 'token(fonts.mono)',
});
