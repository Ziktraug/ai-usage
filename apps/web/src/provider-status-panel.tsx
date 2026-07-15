import { css, cx } from '@ai-usage/design-system/css';
import { panel, panelHeader, panelSub, panelTitle } from '@ai-usage/design-system/report';
import type { ProviderLimitWindow } from '@ai-usage/report-core/provider-status';
import { createMemo, For, Show } from 'solid-js';
import type { ProviderStatusView } from './provider-status-model';
import { buildProviderStatusPanelSummary } from './provider-status-panel-model';
import { providerProgressState } from './provider-status-progress';
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
  appearance: 'none',
  display: 'block',
  w: 'full',
  h: '8px',
  borderRadius: 'full',
  bg: 'surface',
  overflow: 'hidden',
  border: '1px solid token(colors.line)',
  '&::-webkit-progress-bar': { bg: 'surface', borderRadius: 'full' },
  '&::-webkit-progress-value': { borderRadius: 'full' },
  '&::-moz-progress-bar': { borderRadius: 'full' },
});
const barTones: Record<ProviderStatusView['tone'], string> = {
  critical: css({
    '&::-webkit-progress-value': { bg: 'harness.claude.fg' },
    '&::-moz-progress-bar': { bg: 'harness.claude.fg' },
  }),
  warning: css({
    '&::-webkit-progress-value': { bg: 'accent' },
    '&::-moz-progress-bar': { bg: 'accent' },
  }),
  muted: css({
    '&::-webkit-progress-value': { bg: 'muted' },
    '&::-moz-progress-bar': { bg: 'muted' },
  }),
  ok: css({
    '&::-webkit-progress-value': { bg: 'harness.codex.fg' },
    '&::-moz-progress-bar': { bg: 'harness.codex.fg' },
  }),
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
const compactOverview = css({ display: 'grid', gap: '10px' });
const compactProviderList = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
  gap: '8px',
  m: 0,
  p: 0,
  listStyle: 'none',
});
const compactProvider = css({
  display: 'grid',
  gap: '8px',
  p: '10px 12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surfaceMuted',
});
const compactProviderTop = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  flexWrap: 'wrap',
});
const compactProviderName = css({ display: 'grid', gap: '2px', minW: 0 });
const compactProviderMetrics = css({ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' });
const compactEmpty = css({ color: 'muted', fontSize: '12px' });
const historyButton = css({
  justifySelf: 'start',
  px: '10px',
  py: '6px',
  border: '1px solid token(colors.line)',
  borderRadius: 'md',
  bg: 'surface',
  color: 'ink',
  cursor: 'pointer',
  fontSize: '12px',
  fontWeight: 700,
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
});
const issueList = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexWrap: 'wrap',
  m: 0,
  p: 0,
  listStyle: 'none',
});
const issuePill = css({
  display: 'inline-flex',
  alignItems: 'center',
  minH: '24px',
  px: '9px',
  borderRadius: 'full',
  bg: 'surfaceMuted',
  color: 'muted',
  fontSize: '11px',
  fontWeight: 700,
});
const attentionProviderName = css({ color: 'ink' });
const criticalNote = css({ color: 'harness.claude.fg', fontSize: '12px', fontWeight: 600 });
const detailDisclosure = css({
  mt: '2px',
  borderTop: '1px solid token(colors.line)',
  '&[open] > summary': { mb: '10px' },
});
const detailSummary = css({
  py: '10px',
  color: 'muted',
  cursor: 'pointer',
  fontSize: '12px',
  fontWeight: 700,
  _hover: { color: 'ink' },
  _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px', borderRadius: 'sm' },
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

const ProviderProgress = (props: {
  providerLabel: string;
  tone: ProviderStatusView['tone'];
  window: ProviderLimitWindow;
}) => {
  const state = providerProgressState(props.window.usedPercent);
  const progressProps = {
    'aria-label': windowAriaLabel(props.providerLabel, props.window),
    class: cx(barTrack, barTones[props.tone]),
    max: 100,
  };
  return state.kind === 'determinate' ? (
    <progress {...progressProps} value={state.value} />
  ) : (
    <progress {...progressProps} />
  );
};

const compactProviderContext = (view: ProviderStatusView) =>
  [view.machineContext, view.accountContext].filter((value) => value !== null).join(' · ');

const ProviderStateBadge = (props: { view: ProviderStatusView }) => (
  <span class={cx(badge, badgeTones[props.view.tone])}>{props.view.provider.state.replaceAll('-', ' ')}</span>
);

const ProviderSummaryMetrics = (props: { class: string; view: ProviderStatusView }) => (
  <div class={props.class}>
    <Show when={props.view.worstUsedPercent !== null}>
      <span class={summaryPill}>Peak use {fmtPct(props.view.worstUsedPercent ?? 0)}</span>
    </Show>
    <Show when={props.view.nextResetAt}>
      {(nextResetAt) => <span class={summaryPill}>Next reset {fmtDate(nextResetAt())}</span>}
    </Show>
    <Show when={props.view.creditsSummary}>
      {(creditsSummary) => <span class={summaryPill}>{creditsSummary()}</span>}
    </Show>
  </div>
);

const CompactProviderStatus = (props: {
  historyAvailable?: boolean | undefined;
  onViewHistory?: (() => void) | undefined;
  view: ProviderStatusView;
}) => (
  <li class={compactProvider}>
    <div class={compactProviderTop}>
      <div class={compactProviderName}>
        <strong class={providerTitle}>{props.view.provider.label}</strong>
        <Show when={compactProviderContext(props.view)}>
          {(providerContext) => <span class={contextLine}>{providerContext()}</span>}
        </Show>
      </div>
      <ProviderStateBadge view={props.view} />
    </div>
    <ProviderSummaryMetrics class={compactProviderMetrics} view={props.view} />
    <Show when={props.view.provider.warnings?.[0]}>{(warning) => <div class={criticalNote}>{warning()}</div>}</Show>
    <Show when={props.historyAvailable && props.view.provider.key.split(':')[0] === 'codex'}>
      <button class={historyButton} onClick={() => props.onViewHistory?.()} type="button">
        View history
      </button>
    </Show>
  </li>
);

const ProviderDetailCard = (props: { view: ProviderStatusView }) => (
  <li class={providerCard}>
    <div class={providerTop}>
      <div>
        <div class={providerTitleRow}>
          <div class={providerTitle}>{props.view.provider.label}</div>
          <ProviderStateBadge view={props.view} />
        </div>
        <div class={contextLine}>
          {props.view.sourceLabel}
          <Show when={props.view.machineContext}> · {props.view.machineContext}</Show>
          <Show when={props.view.accountContext}> · {props.view.accountContext}</Show>
        </div>
      </div>
      <ProviderSummaryMetrics class={summaryGrid} view={props.view} />
    </div>

    <Show
      fallback={<div class={contextLine}>No quota windows are available for this provider.</div>}
      when={props.view.windowGroups.length > 0}
    >
      <div class={windowsGrid}>
        <For each={props.view.windowGroups}>
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
                      <ProviderProgress
                        providerLabel={props.view.provider.label}
                        tone={props.view.tone}
                        window={window}
                      />
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

    <Show when={props.view.provider.warnings?.length}>
      <ul class={warningList}>
        <For each={props.view.provider.warnings}>{(warning) => <li>{warning}</li>}</For>
      </ul>
    </Show>
  </li>
);

const providerCountLabel = (count: number) => `${count} provider${count === 1 ? '' : 's'}`;

export const ProviderStatusPanel = (props: {
  historyAvailable?: boolean | undefined;
  onViewHistory?: (() => void) | undefined;
  providers: ProviderStatusView[];
}) => {
  const summary = createMemo(() => buildProviderStatusPanelSummary(props.providers));

  return (
    <Show when={props.providers.length > 0}>
      <section aria-labelledby="provider-status-title" class={panel}>
        <div class={panelIntro}>
          <div class={panelHeader}>
            <h2 class={panelTitle} id="provider-status-title">
              Provider status
            </h2>
            <div class={panelSub}>Quota usage and operational issues at a glance.</div>
          </div>
          <Show when={props.historyAvailable}>
            <button class={historyButton} onClick={() => props.onViewHistory?.()} type="button">
              View Codex history
            </button>
          </Show>
        </div>

        <div class={compactOverview}>
          <Show
            fallback={<div class={compactEmpty}>No provider exposes quota windows in this report.</div>}
            when={summary().quotaProviders.length > 0}
          >
            <ul class={compactProviderList}>
              <For each={summary().quotaProviders}>
                {(view) => (
                  <CompactProviderStatus
                    historyAvailable={props.historyAvailable}
                    onViewHistory={props.onViewHistory}
                    view={view}
                  />
                )}
              </For>
            </ul>
          </Show>

          <Show when={summary().criticalProvidersWithoutQuota.length > 0}>
            <ul aria-label="Critical providers" class={compactProviderList}>
              <For each={summary().criticalProvidersWithoutQuota}>
                {(view) => (
                  <CompactProviderStatus
                    historyAvailable={props.historyAvailable}
                    onViewHistory={props.onViewHistory}
                    view={view}
                  />
                )}
              </For>
            </ul>
          </Show>

          <Show when={summary().attentionProvidersWithoutQuota.length > 0}>
            <ul aria-label="Providers requiring attention" class={issueList}>
              <For each={summary().attentionProvidersWithoutQuota}>
                {(view) => (
                  <li class={issuePill}>
                    <strong class={attentionProviderName}>{view.provider.label}</strong>
                    <Show when={compactProviderContext(view)}>
                      {(providerContext) => <span>· {providerContext()}</span>}
                    </Show>
                    <span>· {view.provider.state.replaceAll('-', ' ')}</span>
                    <Show when={view.provider.warnings?.[0]}>{(warning) => <span>· {warning()}</span>}</Show>
                    <Show when={view.creditsSummary}>{(creditsSummary) => <span>· {creditsSummary()}</span>}</Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show
            when={
              summary().warningCount > 0 ||
              summary().unsupportedProviderCount > 0 ||
              summary().noWindowProviderCount > 0
            }
          >
            <ul aria-label="Provider status issue counts" class={issueList}>
              <Show when={summary().warningCount > 0}>
                <li class={issuePill}>
                  {summary().warningCount} provider warning{summary().warningCount === 1 ? '' : 's'}
                </li>
              </Show>
              <Show when={summary().unsupportedProviderCount > 0}>
                <li class={issuePill}>
                  {summary().unsupportedProviderCount} unsupported provider
                  {summary().unsupportedProviderCount === 1 ? '' : 's'}
                </li>
              </Show>
              <Show when={summary().noWindowProviderCount > 0}>
                <li class={issuePill}>{providerCountLabel(summary().noWindowProviderCount)} without quota windows</li>
              </Show>
            </ul>
          </Show>
        </div>

        <details class={detailDisclosure}>
          <summary class={detailSummary}>Provider details ({providerCountLabel(props.providers.length)})</summary>
          <ul class={statusList}>
            <For each={props.providers}>{(view) => <ProviderDetailCard view={view} />}</For>
          </ul>
        </details>
      </section>
    </Show>
  );
};
