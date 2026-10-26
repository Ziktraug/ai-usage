import { css } from '@ai-usage/design-system/css';

/** Keep theme aliases extracted by Panda; the task composition CSS loads with the Work route. */
export const threadSurface = css({
  '--wt-paper': 'token(colors.surface)',
  '--wt-soft': 'token(colors.surfaceMuted)',
  '--wt-ink': 'token(colors.ink)',
  '--wt-muted': 'token(colors.muted)',
  '--wt-line': 'token(colors.line)',
  '--wt-line-strong': 'token(colors.lineStrong)',
  '--wt-accent': 'token(colors.accent)',
  '--wt-contrast': 'token(colors.accentContrast)',
  '--wt-tint': 'token(colors.accentTint)',
  '--wt-ok': 'token(colors.status.ok)',
  '--wt-ok-soft': 'token(colors.status.okSoft)',
  '--wt-warn': 'token(colors.status.warn)',
  '--wt-warn-soft': 'token(colors.status.warnSoft)',
  '--wt-danger': 'token(colors.status.danger)',
  '--wt-danger-soft': 'token(colors.status.dangerSoft)',
  '--wt-claude': 'token(colors.harness.claude.fg)',
  '--wt-claude-bg': 'token(colors.harness.claude.bg)',
  '--wt-codex': 'token(colors.harness.codex.fg)',
  '--wt-codex-bg': 'token(colors.harness.codex.bg)',
});
