<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const grid = css({
    display: 'grid',
    gap: '10px',
    gridTemplateColumns: { base: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
  });
  const card = css({
    display: 'grid',
    gap: '8px',
    p: '12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
  });
  const heading = css({ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline' });
  const name = css({ fontSize: '13px', fontWeight: 700 });
  const source = css({ color: 'muted', fontSize: '11px' });
  const context = css({ color: 'muted', fontSize: '12px' });
  const windows = css({ display: 'grid', gap: '9px' });
  const windowRow = css({ display: 'grid', gap: '4px', fontSize: '12px' });
  const windowHeading = css({ display: 'flex', justifyContent: 'space-between', gap: '10px' });
  const windowMeta = css({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: '6px',
    color: 'muted',
    fontSize: '11px',
  });
  const windowValue = css({ fontWeight: 650, textStyle: 'numeric' });
  const progress = css({ w: '100%', h: '8px', accentColor: 'accent' });
  const badge = css({
    px: '8px',
    py: '3px',
    borderRadius: 'full',
    bg: 'track',
    color: 'muted',
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase',
  });
  const empty = css({ color: 'muted', fontSize: '12px' });
  const actions = css({ display: 'flex', justifyContent: 'flex-end', mt: '10px' });
  const historyButton = css({
    px: '10px',
    py: '6px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
    cursor: 'pointer',
    fontSize: '12px',
  });
</script>

<script lang="ts">
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { ProviderStatusView } from '../../../../provider-status-model';
  import { buildProviderStatusPanelSummary } from '../../../../provider-status-panel-model';
  import { providerProgressState } from '../../../../provider-status-progress';
  import { fmtDate } from '../../../foundation/presentation/format';
  import {
    providerPercentLabel,
    providerRemainingLabel,
    providerResetLabel,
    providerWindowAriaLabel,
  } from './provider-presentation';

  let { onOpenHistory, providers }: { onOpenHistory?: () => void; providers: readonly ProviderStatusView[] } = $props();
  const summary = $derived(buildProviderStatusPanelSummary([...providers]));
  const visibleProviders = $derived([
    ...summary.criticalProvidersWithoutQuota,
    ...summary.quotaProviders,
    ...summary.attentionProvidersWithoutQuota,
    ...summary.otherProvidersWithoutQuota,
    ...summary.unsupportedProvidersWithoutQuota,
  ]);
</script>

<section aria-labelledby="provider-status-heading" class={panel}>
  <div>
    <h2 class={panelTitle} id="provider-status-heading">Provider status</h2>
    <p class={panelSub}>Quota windows and collection quality for providers in this report</p>
  </div>
  {#if visibleProviders.length === 0}
    <p class={empty}>No provider status was captured for this report revision.</p>
  {:else}
    <div class={grid}>
      {#each visibleProviders as item (`${item.provider.key}:${item.provider.machineId ?? 'global'}`)}
        <article class={card} data-provider-tone={item.tone}>
          <div class={heading}>
            <div>
              <h3 class={name}>{item.provider.label}</h3>
              <p class={source}>{item.sourceLabel}</p>
            </div>
            <span class={badge}>{item.provider.state.replaceAll('-', ' ')}</span>
          </div>
          {#if item.accountContext || item.machineContext}
            <p class={context}>{[item.accountContext, item.machineContext].filter(Boolean).join(' · ')}</p>
          {/if}
          {#if item.windowGroups.length > 0}
            <div class={windows}>
              {#each item.windowGroups as group (group.key)}
                {#each group.windows as window (window.id)}
                  {@const state = providerProgressState(window.usedPercent)}
                  <div class={windowRow} data-provider-window={window.id}>
                    <div class={windowHeading}>
                      <span>{group.label} · {window.label}</span>
                      <strong class={windowValue}>{providerPercentLabel(window)}</strong>
                    </div>
                    {#if state.kind === 'determinate'}
                      <progress
                        aria-label={providerWindowAriaLabel(item.provider.label, window)}
                        class={progress}
                        max={100}
                        value={state.value}
                      ></progress>
                    {:else}
                      <progress
                        aria-label={providerWindowAriaLabel(item.provider.label, window)}
                        class={progress}
                        max={100}
                      ></progress>
                    {/if}
                    <div class={windowMeta}>
                      <span>{providerRemainingLabel(window)}</span>
                      <span>{providerResetLabel(window)}</span>
                    </div>
                  </div>
                {/each}
              {/each}
            </div>
          {:else}
            <p class={context}>No quota windows are available for this provider.</p>
          {/if}
          {#if item.creditsSummary}
            <p class={context}>{item.creditsSummary}</p>
          {/if}
          {#if item.nextResetAt}
            <p class={context}>Next reset {fmtDate(item.nextResetAt)}</p>
          {/if}
          {#each item.provider.warnings ?? [] as warning (warning)}
            <p class={context}>{warning}</p>
          {/each}
        </article>
      {/each}
    </div>
  {/if}
  {#if onOpenHistory}
    <div class={actions}>
      <button class={historyButton} onclick={onOpenHistory} type="button">View Codex quota history</button>
    </div>
  {/if}
</section>
