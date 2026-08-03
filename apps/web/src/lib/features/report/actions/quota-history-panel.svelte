<script lang="ts">
  import { Drawer, SegmentedControl } from '@ai-usage/design-system/svelte';
  import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
  import {
    buildProviderQuotaHistoryModel,
    type ProviderQuotaHistoryRange,
  } from '../../../../provider-quota-history-model';
  import { fmtDate, fmtPct } from '../../../foundation/presentation/format';
  import { button, field, list, muted, panel, row, stack, table, tableCell, title } from '../breakdown/styles';

  let {
    errorMessage = null,
    loading,
    onClose,
    onRangeChange,
    open,
    range,
    result,
  }: {
    errorMessage?: string | null;
    loading: boolean;
    onClose: () => void;
    onRangeChange: (range: ProviderQuotaHistoryRange) => void;
    open: boolean;
    range: ProviderQuotaHistoryRange;
    result: ProviderQuotaHistoryResult | null;
  } = $props();

  const model = $derived(result ? buildProviderQuotaHistoryModel(result) : null);
  const rangeItems = ['24h', '7d', '30d'].map((value) => ({ label: value, value }));
  const changeRange = (value: string): void => {
    if (value === '24h' || value === '7d' || value === '30d') {
      onRangeChange(value);
    }
  };
  const providers = $derived([...new Set(model?.series.map(({ providerKey }) => providerKey) ?? [])]);
  const machines = $derived([...new Set(model?.series.map(({ machineId }) => machineId) ?? [])]);
  const accounts = $derived([...new Set(model?.series.map(({ accountScope }) => accountScope ?? 'unknown') ?? [])]);
  let provider = $state('');
  let machine = $state('');
  let account = $state('');
  const visibleSeries = $derived(
    model?.series.filter(
      (series) =>
        (!provider || series.providerKey === provider) &&
        (!machine || series.machineId === machine) &&
        (!account || (series.accountScope ?? 'unknown') === account),
    ) ?? [],
  );
  const resetFilters = (): void => {
    provider = '';
    machine = '';
    account = '';
  };
  const largestGapLabel = (milliseconds: number): string => {
    const minutes = Math.round(milliseconds / 60_000);
    return minutes < 60 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
  };
</script>

<Drawer
  contentAriaLabel="Codex quota history"
  modal
  onOpenChange={(nextOpen) => {
    if (!nextOpen) {
      onClose();
    }
  }}
  {open}
  trapFocus
>
  <div class={stack} data-quota-history>
    <header class={row}>
      <div>
        <h2 class={title}>Codex quota history</h2>
        <p class={muted}>Provider-defined quota observations retained on this machine.</p>
      </div>
      <button aria-label="Close Codex quota history" class={button} onclick={onClose} type="button">✕</button>
    </header>
    {#if errorMessage}
      <div class={panel} role="status">{errorMessage}</div>
    {/if}
    <div class={row}>
      <SegmentedControl
        ariaLabel="History range"
        defaultValue="24h"
        items={rangeItems}
        onValueChange={changeRange}
        value={range}
      />
      <label
        >Provider
        <select class={field} bind:value={provider}>
          <option value="">All</option>
          {#each providers as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <label
        >Machine
        <select class={field} bind:value={machine}>
          <option value="">All</option>
          {#each machines as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <label
        >Account scope
        <select class={field} bind:value={account}>
          <option value="">All</option>
          {#each accounts as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <button class={button} onclick={resetFilters} type="button">Reset filters</button>
    </div>
    {#if loading}
      <div role="status">Loading quota history…</div>
    {/if}
    {#if !loading && model?.emptyMessage}
      <div>{model.emptyMessage}</div>
    {/if}
    {#if model?.partial}
      <div class={panel}>History is partial or contains skipped corrupt observations.</div>
    {/if}
    <div class={list}>
      {#each visibleSeries as series (series.key)}
        <article class={panel}>
          <div class={row}>
            <strong>{series.label}</strong
            ><strong>{series.currentPercent === null ? 'Unknown' : fmtPct(series.currentPercent)}</strong>
          </div>
          <p class={muted}>{series.providerLabel} · {series.machineLabel ?? series.machineId}</p>
          <p class={muted}>
            {series.summary}
            · largest gap {largestGapLabel(series.largestGapMs)} · {series.sourceKey} ({series.sourceConfidence})
          </p>
          <p class={muted}>
            First {fmtDate(series.firstObservedAt)} · Last {fmtDate(series.lastObservedAt)} · Next reset
            {series.nextResetAt ? fmtDate(series.nextResetAt) : 'unknown'}
          </p>
          <table aria-label={`${series.label} quota observations`} class={table}>
            <tbody>
              {#each series.points as point (`${point.windowId}:${point.firstObservedAt}`)}
                <tr>
                  <td class={tableCell}>{fmtDate(point.firstObservedAt)}</td>
                  <td class={tableCell}>{point.usedPercent === null ? 'Unknown' : fmtPct(point.usedPercent)}</td>
                  <td class={tableCell}>Reset {point.resetAt ? fmtDate(point.resetAt) : 'unknown'}</td>
                  <td class={tableCell}>{point.source.key} ({point.source.confidence})</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </article>
      {/each}
    </div>
  </div>
</Drawer>
