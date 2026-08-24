<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';
  import type { ProviderStatusTone } from '../../../../provider-status-model';

  const panelIntro = css({ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'space-between' });
  const statusList = css({ display: 'grid', gap: '10px', listStyle: 'none', m: 0, p: 0 });
  const providerCard = css({
    bg: 'surfaceMuted',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    containerType: 'inline-size',
    display: 'grid',
    gap: '12px',
    p: '14px',
  });
  const providerTop = css({
    alignItems: 'start',
    display: 'grid',
    gap: '10px',
    gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1fr) auto' },
  });
  const providerTitleRow = css({ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '8px' });
  const providerTitle = css({ fontSize: '14px', fontWeight: 700, overflowWrap: 'anywhere' });
  const badge = css({
    alignItems: 'center',
    borderRadius: 'full',
    display: 'inline-flex',
    fontSize: '11px',
    fontWeight: 700,
    h: '22px',
    px: '9px',
    textTransform: 'capitalize',
    whiteSpace: 'nowrap',
  });
  const badgeTones: Record<ProviderStatusTone, string> = {
    critical: css({ bg: 'harness.claude.bg', color: 'harness.claude.fg' }),
    muted: css({ bg: 'surface', color: 'muted' }),
    ok: css({ bg: 'harness.codex.bg', color: 'harness.codex.fg' }),
    warning: css({ bg: 'accentSoft', color: 'accent' }),
  };
  const contextLine = css({ color: 'muted', fontSize: '12px', overflowWrap: 'anywhere' });
  const summaryGrid = css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    justifyContent: { base: 'flex-start', md: 'flex-end' },
  });
  const summaryPill = css({
    alignItems: 'center',
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'full',
    color: 'ink',
    display: 'inline-flex',
    fontSize: '11px',
    minH: '24px',
    overflowWrap: 'anywhere',
    px: '10px',
  });
  // Grid items stretch by default and `normal` behaves as `stretch` for the tracks inside them, so a
  // one-window column split the extra height of its taller neighbour between its label and its rows
  // and the single window floated mid-column. Both axes have to opt out for the columns to top-align.
  const windowsGrid = css({
    alignItems: 'start',
    display: 'grid',
    gap: '10px',
    gridTemplateColumns: { base: '1fr', lg: 'repeat(3, minmax(0, 1fr))' },
  });
  const windowGroup = css({ alignContent: 'start', display: 'grid', gap: '8px', minW: 0 });
  const groupLabel = css({
    color: 'muted',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  });
  const windowRows = css({ display: 'grid', gap: '8px' });
  const windowLabel = css({
    display: 'flex',
    fontSize: '12px',
    gap: '8px',
    justifyContent: 'space-between',
    overflowWrap: 'anywhere',
  });
  const windowMeta = css({ color: 'muted', fontSize: '11px' });
  const barTrack = css({
    appearance: 'none',
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'full',
    display: 'block',
    h: '8px',
    overflow: 'hidden',
    w: 'full',
    '&::-moz-progress-bar': { borderRadius: 'full' },
    '&::-webkit-progress-bar': { bg: 'surface', borderRadius: 'full' },
    '&::-webkit-progress-value': { borderRadius: 'full' },
  });
  const barTones: Record<ProviderStatusTone, string> = {
    critical: css({
      '&::-moz-progress-bar': { bg: 'harness.claude.fg' },
      '&::-webkit-progress-value': { bg: 'harness.claude.fg' },
    }),
    muted: css({
      '&::-moz-progress-bar': { bg: 'muted' },
      '&::-webkit-progress-value': { bg: 'muted' },
    }),
    ok: css({
      '&::-moz-progress-bar': { bg: 'harness.codex.fg' },
      '&::-webkit-progress-value': { bg: 'harness.codex.fg' },
    }),
    warning: css({
      '&::-moz-progress-bar': { bg: 'accent' },
      '&::-webkit-progress-value': { bg: 'accent' },
    }),
  };
  const warningList = css({
    color: 'muted',
    display: 'grid',
    fontSize: '12px',
    gap: '4px',
    listStyle: 'none',
    m: 0,
    p: 0,
  });
  const compactOverview = css({ display: 'grid', gap: '10px' });
  const compactProviderList = css({
    display: 'grid',
    gap: '8px',
    gridTemplateColumns: { base: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
    listStyle: 'none',
    m: 0,
    p: 0,
  });
  const compactProvider = css({
    bg: 'surfaceMuted',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    display: 'grid',
    gap: '8px',
    p: '10px 12px',
  });
  const compactProviderTop = css({
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    justifyContent: 'space-between',
  });
  const compactProviderName = css({ display: 'grid', gap: '2px', minW: 0 });
  const compactProviderMetrics = css({ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const compactEmpty = css({ color: 'muted', fontSize: '12px' });
  const historyButton = css({
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    color: 'ink',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 700,
    justifySelf: 'start',
    px: '10px',
    py: '6px',
    _focusVisible: { borderRadius: 'sm', outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const machineLineList = css({ display: 'grid', gap: '4px', listStyle: 'none', m: 0, p: 0 });
  const glossaryList = css({
    color: 'muted',
    display: 'grid',
    fontSize: '11px',
    gap: '2px',
    listStyle: 'none',
    m: 0,
    overflowWrap: 'anywhere',
    p: 0,
  });
  const criticalNote = css({ color: 'harness.claude.fg', fontSize: '12px', fontWeight: 600 });
  const detailDisclosure = css({
    borderTop: '1px solid token(colors.line)',
    mt: '2px',
    '&[open] > summary': { mb: '10px' },
  });
  const detailSummary = css({
    color: 'muted',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 700,
    py: '10px',
    _focusVisible: { borderRadius: 'sm', outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    _hover: { color: 'ink' },
  });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { panel, panelHeader, panelSub, panelTitle } from '@ai-usage/design-system/report';
  import type { ProviderStatusView } from '../../../../provider-status-model';
  import {
    buildProviderStatusPanelSummary,
    describeProviderStatusSummary,
    detailedProviders,
    providerMachineLines,
  } from '../../../../provider-status-panel-model';
  import { providerProgressState } from '../../../../provider-status-progress';
  import { fmtDate, fmtPct } from '../../../foundation/presentation/format';
  import { providerPercentLabel, providerWindowAriaLabel } from './provider-presentation';

  let { onOpenHistory, providers }: { onOpenHistory?: () => void; providers: readonly ProviderStatusView[] } = $props();
  const summary = $derived(buildProviderStatusPanelSummary([...providers]));
  const details = $derived(detailedProviders(summary));
  const machineLines = $derived(providerMachineLines(summary.providersWithoutQuotaSource));
  const providerCountLabel = (count: number): string => `${count} provider${count === 1 ? '' : 's'}`;
  const compactProviderContext = (view: ProviderStatusView): string =>
    [view.machineContext, view.accountContext].filter((value) => value !== null).join(' · ');
</script>

{#snippet providerStateBadge(_view: ProviderStatusView)}
  <span class={cx(badge, badgeTones[_view.tone])}>{_view.provider.state.replaceAll('-', ' ')}</span>
{/snippet}

{#snippet providerSummaryMetrics(_view: ProviderStatusView, _className: string)}
  <div class={_className}>
    {#if _view.worstUsedPercent !== null}
      <span class={summaryPill}>Peak use {fmtPct(_view.worstUsedPercent)}</span>
    {/if}
    {#if _view.nextResetAt}
      <span class={summaryPill}>Next reset {fmtDate(_view.nextResetAt)}</span>
    {/if}
    {#if _view.creditsSummary}
      <span class={summaryPill}>{_view.creditsSummary}</span>
    {/if}
  </div>
{/snippet}

{#snippet compactProviderStatus(_view: ProviderStatusView)}
  <li class={compactProvider}>
    <div class={compactProviderTop}>
      <div class={compactProviderName}>
        <strong class={providerTitle}>{_view.provider.label}</strong>
        {#if compactProviderContext(_view)}
          <span class={contextLine}>{compactProviderContext(_view)}</span>
        {/if}
      </div>
      {@render providerStateBadge(_view)}
    </div>
    {@render providerSummaryMetrics(_view, compactProviderMetrics)}
    {#if _view.provider.warnings?.[0]}
      <div class={criticalNote}>{_view.provider.warnings[0]}</div>
    {/if}
  </li>
{/snippet}

{#snippet providerDetailCard(_view: ProviderStatusView)}
  <li class={providerCard}>
    <div class={providerTop}>
      <div>
        <div class={providerTitleRow}>
          <div class={providerTitle}>{_view.provider.label}</div>
          {@render providerStateBadge(_view)}
        </div>
        <div class={contextLine}>
          {_view.sourceLabel}
          {#if _view.machineContext}
            · {_view.machineContext}
          {/if}
          {#if _view.accountContext}
            · {_view.accountContext}
          {/if}
        </div>
      </div>
      {@render providerSummaryMetrics(_view, summaryGrid)}
    </div>

    {#if _view.windowGroups.length > 0}
      <div class={windowsGrid}>
        {#each _view.windowGroups as group (group.key)}
          <div class={windowGroup} data-provider-window-group>
            <div class={groupLabel}>{group.label}</div>
            <div class={windowRows}>
              {#each group.windows as window (window.id)}
                {@const state = providerProgressState(window.usedPercent)}
                <div>
                  <div class={windowLabel}>
                    <span>{window.label}</span>
                    <strong>{providerPercentLabel(window)}</strong>
                  </div>
                  {#if state.kind === 'determinate'}
                    <progress
                      aria-label={providerWindowAriaLabel(_view.provider.label, window)}
                      class={cx(barTrack, barTones[_view.tone])}
                      max={100}
                      value={state.value}
                    ></progress>
                  {:else}
                    <progress
                      aria-label={providerWindowAriaLabel(_view.provider.label, window)}
                      class={cx(barTrack, barTones[_view.tone])}
                      max={100}
                    ></progress>
                  {/if}
                  <div class={windowMeta}>
                    {window.resetsAt ? `Resets ${fmtDate(window.resetsAt)}` : 'Reset time unknown'}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class={contextLine}>No usage limit was read for this provider.</div>
    {/if}

    {#if _view.provider.warnings?.length}
      <ul class={warningList}>
        {#each _view.provider.warnings as warning}
          <li>{warning}</li>
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

{#if providers.length > 0}
  <section aria-labelledby="provider-status-title" class={panel}>
    <div class={panelIntro}>
      <div class={panelHeader}>
        <h2 class={panelTitle} id="provider-status-title">Provider status</h2>
        <div class={panelSub}>Quota usage and operational issues at a glance.</div>
      </div>
      {#if onOpenHistory}
        <button class={historyButton} onclick={onOpenHistory} type="button">View quota history</button>
      {/if}
    </div>

    <div class={compactOverview}>
      {#if summary.quotaProviders.length > 0}
        <ul class={compactProviderList}>
          {#each summary.quotaProviders as view (`quota:${view.provider.key}:${view.provider.machineId ?? 'global'}`)}
            {@render compactProviderStatus(view)}
          {/each}
        </ul>
      {:else}
        <div class={compactEmpty}>No provider reported a usage limit in this report.</div>
      {/if}

      {#if summary.criticalProvidersWithoutQuota.length > 0}
        <ul aria-label="Critical providers" class={compactProviderList}>
          {#each summary.criticalProvidersWithoutQuota as view (`critical:${view.provider.key}:${view.provider.machineId ?? 'global'}`)}
            {@render compactProviderStatus(view)}
          {/each}
        </ul>
      {/if}

      <p class={contextLine} data-provider-status-summary>{describeProviderStatusSummary(summary)}</p>

      {#if machineLines.length > 0}
        <ul aria-label="Providers with no limit reading" class={machineLineList}>
          {#each machineLines as line (line.key)}
            <li class={contextLine} data-provider-no-quota-line>{line.text}</li>
          {/each}
        </ul>
      {/if}

      <ul aria-label="What each provider state means" class={glossaryList} data-provider-state-glossary>
        <li>Ok = this provider reported how much of its limit is used.</li>
        <li>Partial = usage was collected here, but no limit reading arrived for this provider.</li>
        <li>Unsupported = this provider does not publish a limit ai-usage can read.</li>
      </ul>
    </div>

    {#if details.length > 0}
      <details class={detailDisclosure}>
        <summary class={detailSummary}>Provider details ({providerCountLabel(details.length)})</summary>
        <ul class={statusList}>
          {#each details as view (`${view.provider.key}:${view.provider.machineId ?? 'global'}`)}
            {@render providerDetailCard(view)}
          {/each}
        </ul>
      </details>
    {/if}
  </section>
{/if}
