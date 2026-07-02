import { css, cx } from '@ai-usage/design-system/css';
import { panel, panelHeader, panelSub, panelTitle } from '@ai-usage/design-system/report';
import type { ProviderLimitWindow } from '@ai-usage/report-core/provider-status';
import { For, Show } from 'solid-js';
import type { ProviderStatusView } from './provider-status-model';
import { fmtDate, fmtPct } from './shared';

const panelIntro = css({ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' });
const statusList = css({ display: 'grid', gap: '10px', listStyle: 'none', m: 0, p: 0 });
const providerCard = css({
  display: 'grid',
  gap: '12px',
  p: '14px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
  containerType: 'inline-size',
});
const providerTop = css({
  display: 'grid',
  gap: '10px',
  gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1fr) auto' },
  alignItems: 'start',
});
const providerTitleRow = css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' });
const providerTitle = css({ fontSize: '14px', fontWeight: 700, overflowWrap: 'anywhere' });
const badge = css({
  display: 'inline-flex',
  alignItems: 'center',
  h: '22px',
  px: '9px',
  borderRadius: 'full',
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'capitalize',
  whiteSpace: 'nowrap',
});
const badgeTones: Record<ProviderStatusView['tone'], string> = {
  critical: css({ bg: 'harness.claude.bg', color: 'harness.claude.fg' }),
  warning: css({ bg: 'accentSoft', color: 'accent' }),
  muted: css({ bg: 'surface', color: 'muted' }),
  ok: css({ bg: 'harness.codex.bg', color: 'harness.codex.fg' }),
};
const contextLine = css({ color: 'muted', fontSize: '12px', overflowWrap: 'anywhere' });
const summaryGrid = css({
  display: 'flex',
  gap: '8px',
  flexWrap: 'wrap',
  justifyContent: { base: 'flex-start', md: 'flex-end' },
});
const summaryPill = css({
  display: 'inline-flex',
  alignItems: 'center',
  minH: '24px',
  px: '10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'full',
  bg: 'surface',
  color: 'ink',
  fontSize: '11px',
  overflowWrap: 'anywhere',
});
const windowsGrid = css({
  display: 'grid',
  gap: '10px',
  gridTemplateColumns: { base: '1fr', lg: 'repeat(3, minmax(0, 1fr))' },
});
const windowGroup = css({ display: 'grid', gap: '8px', minW: 0 });
const groupLabel = css({
  color: 'muted',
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
});
const windowRows = css({ display: 'grid', gap: '8px' });
const windowLabel = css({
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  fontSize: '12px',
  overflowWrap: 'anywhere',
});
const windowMeta = css({ color: 'muted', fontSize: '11px' });
const barTrack = css({
  h: '8px',
  borderRadius: 'full',
  bg: 'surface',
  overflow: 'hidden',
  border: '1px solid token(colors.line)',
});
const barFill = css({ h: '100%', borderRadius: 'full' });
const barTones: Record<ProviderStatusView['tone'], string> = {
  critical: css({ bg: 'harness.claude.fg' }),
  warning: css({ bg: 'accent' }),
  muted: css({ bg: 'muted' }),
  ok: css({ bg: 'harness.codex.fg' }),
};
const warningList = css({
  display: 'grid',
  gap: '4px',
  m: 0,
  p: 0,
  listStyle: 'none',
  color: 'muted',
  fontSize: '12px',
});

const percentLabel = (window: ProviderLimitWindow) =>
  window.usedPercent === null ? 'Unknown usage' : fmtPct(window.usedPercent);

const windowAriaLabel = (providerLabel: string, window: ProviderLimitWindow) => {
  const used = window.usedPercent === null ? 'unknown used percent' : `${window.usedPercent.toFixed(0)} percent used`;
  const remaining =
    window.remainingPercent === null
      ? 'unknown remaining percent'
      : `${window.remainingPercent.toFixed(0)} percent remaining`;
  const reset = window.resetsAt ? `resets ${fmtDate(window.resetsAt)}` : 'reset time unknown';
  return `${providerLabel} ${window.label}: ${used}, ${remaining}, ${reset}`;
};

export const ProviderStatusPanel = (props: { providers: ProviderStatusView[] }) => (
  <Show when={props.providers.length > 0}>
    <section aria-labelledby="provider-status-title" class={panel}>
      <div class={panelIntro}>
        <div class={panelHeader}>
          <h2 class={panelTitle} id="provider-status-title">
            Provider status
          </h2>
          <div class={panelSub}>Quota windows, reset credits, and provider-specific collection limits.</div>
        </div>
      </div>

      <ul class={statusList}>
        <For each={props.providers}>
          {(view) => (
            <li class={providerCard}>
              <div class={providerTop}>
                <div>
                  <div class={providerTitleRow}>
                    <div class={providerTitle}>{view.provider.label}</div>
                    <span class={cx(badge, badgeTones[view.tone])}>{view.provider.state.replaceAll('-', ' ')}</span>
                  </div>
                  <div class={contextLine}>
                    {view.sourceLabel}
                    <Show when={view.machineContext}> · {view.machineContext}</Show>
                    <Show when={view.accountContext}> · {view.accountContext}</Show>
                  </div>
                </div>
                <div class={summaryGrid}>
                  <Show when={view.worstUsedPercent !== null}>
                    <span class={summaryPill}>Worst use {fmtPct(view.worstUsedPercent ?? 0)}</span>
                  </Show>
                  <Show when={view.nextResetAt}>
                    {(nextResetAt) => <span class={summaryPill}>Next reset {fmtDate(nextResetAt())}</span>}
                  </Show>
                  <Show when={view.creditsSummary}>
                    {(creditsSummary) => <span class={summaryPill}>{creditsSummary()}</span>}
                  </Show>
                </div>
              </div>

              <Show
                fallback={<div class={contextLine}>No quota windows are available for this provider.</div>}
                when={view.windowGroups.length > 0}
              >
                <div class={windowsGrid}>
                  <For each={view.windowGroups}>
                    {(group) => (
                      <div class={windowGroup}>
                        <div class={groupLabel}>{group.label}</div>
                        <div class={windowRows}>
                          <For each={group.windows}>
                            {(window) => (
                              <div>
                                <div class={windowLabel}>
                                  <span>{window.label}</span>
                                  <strong>{percentLabel(window)}</strong>
                                </div>
                                <div
                                  aria-label={windowAriaLabel(view.provider.label, window)}
                                  aria-valuemax="100"
                                  aria-valuemin="0"
                                  aria-valuenow={window.usedPercent ?? undefined}
                                  class={barTrack}
                                  role="progressbar"
                                >
                                  <div
                                    class={cx(barFill, barTones[view.tone])}
                                    style={{ width: `${window.usedPercent ?? 0}%` }}
                                  />
                                </div>
                                <div class={windowMeta}>
                                  <Show fallback="Reset time unknown" when={window.resetsAt}>
                                    {(resetsAt) => <>Resets {fmtDate(resetsAt())}</>}
                                  </Show>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={view.provider.warnings?.length}>
                <ul class={warningList}>
                  <For each={view.provider.warnings}>{(warning) => <li>{warning}</li>}</For>
                </ul>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  </Show>
);
