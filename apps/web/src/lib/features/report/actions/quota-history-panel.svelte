<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { Drawer, drawerBody } from '@ai-usage/design-system/svelte';
  import type { ProviderQuotaHistoryResult } from '@ai-usage/report-core/provider-quota';
  import {
    buildProviderQuotaHistoryModel,
    type ProviderQuotaHistoryRange,
    providerQuotaHistoryWindow,
  } from '../../../../provider-quota-history-model';
  import { button, field, list, muted, panel, row, stack, title } from '../breakdown/styles';
  import QuotaHistorySeries from './quota-history-series.svelte';

  const rangeControls = css({ display: 'flex', flexWrap: 'wrap', gap: '8px', border: 0, m: 0, p: 0 });
  // `Drawer` styles its content with `drawerClass` only — `drawerBody`, which forces descendant
  // controls to 44 px, is never applied here. Without this the buttons sit at their 32 px minimum
  // beside 36 px selects, so the height has to be stated: it tracks `field`'s own responsive height.
  const rangeButton = css({ minW: '56px', minH: { base: '44px', sm: '36px' } });
  const selectedRange = css({ borderColor: 'accent', bg: 'accentTint', color: 'accent' });
  const historyControl = css({
    display: 'grid',
    gap: '6px',
    fontSize: '12px',
    color: 'muted',
    flex: '1 1 140px',
    minW: 0,
  });
  const historySelect = cx(field, css({ w: 'full', minW: 0 }));

  const historyRanges = ['24h', '7d', '30d'] as const satisfies readonly ProviderQuotaHistoryRange[];

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

  let closeButton: HTMLButtonElement | undefined;
  let previousFocus: HTMLElement | null = $state(null);
  let wasOpen = false;
  $effect.pre(() => {
    if (open && !wasOpen) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    wasOpen = open;
  });
  // The window ends at the result's `generatedAt` — the server's own query time — rather than at the
  // owner's request clock, so the drawn axis matches the observations the server actually answered with.
  const historyWindow = $derived(result ? providerQuotaHistoryWindow(range, result.generatedAt) : null);
  const model = $derived(result && historyWindow ? buildProviderQuotaHistoryModel(result, historyWindow) : null);
  const changeRange = (value: string): void => {
    if (value === '24h' || value === '7d' || value === '30d') {
      onRangeChange(value);
    }
  };
  const pressedAria = (item: ProviderQuotaHistoryRange) =>
    ({ 'aria-pressed': range === item ? 'true' : 'false' }) as const;
  const providers = $derived([...new Set(model?.series.map(({ providerKey }) => providerKey) ?? [])]);
  const machines = $derived([...new Set(model?.series.map(({ machineId }) => machineId) ?? [])]);
  const accounts = $derived([...new Set(model?.series.map(({ accountScope }) => accountScope ?? 'unknown') ?? [])]);
  let provider = $state('');
  let machine = $state('');
  let account = $state('');
  $effect(() => {
    if (provider && !providers.includes(provider)) {
      provider = '';
    }
    if (machine && !machines.includes(machine)) {
      machine = '';
    }
    if (account && !accounts.includes(account)) {
      account = '';
    }
  });
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
</script>

<Drawer
  contentAriaLabel="Provider quota history"
  finalFocusEl={() => (previousFocus instanceof HTMLElement && previousFocus.isConnected ? previousFocus : null)}
  initialFocusEl={() => closeButton ?? null}
  modal
  onOpenChange={(nextOpen) => {
    if (!nextOpen) {
      onClose();
    }
  }}
  {open}
  trapFocus
>
  <div
    class={cx(stack, drawerBody)}
    data-quota-history
    data-quota-window-from={model?.window.from}
    data-quota-window-to={model?.window.to}
  >
    <header
      class={css({ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '12px', alignItems: 'start', pb: '16px', borderBottom: '1px solid token(colors.line)' })}
    >
      <div>
        <h2 class={title}>Provider quota history</h2>
        <p class={muted}>Provider-defined quota observations retained on this machine.</p>
      </div>
      <button
        aria-label="Close provider quota history"
        class={button}
        onclick={onClose}
        type="button"
        bind:this={closeButton}
      >
        ✕
      </button>
    </header>
    {#if errorMessage}
      <div class={panel} role="status">{errorMessage}</div>
    {/if}
    <div class={row}>
      <fieldset class={rangeControls}>
        <legend>History range</legend>
        {#each historyRanges as item (item)}
          <button
            {...pressedAria(item)}
            class={[button, rangeButton, range === item ? selectedRange : undefined]}
            onclick={() => changeRange(item)}
            type="button"
          >
            {item}
          </button>
        {/each}
      </fieldset>
      <label class={historyControl}
        >Provider
        <select class={historySelect} bind:value={provider}>
          <option value="">All</option>
          {#each providers as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <label class={historyControl}
        >Machine
        <select class={historySelect} bind:value={machine}>
          <option value="">All</option>
          {#each machines as value}
            <option {value}>{value}</option>
          {/each}
        </select></label
      >
      <label class={historyControl}
        >Account scope
        <select class={historySelect} bind:value={account}>
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
    {#if visibleSeries.length > 0}
      <p class={muted} data-quota-legend>▼ reset boundary · ▽ collection gap · ○ held from before the window</p>
    {/if}
    <div class={list}>
      {#each visibleSeries as series (series.key)}
        {#if model}
          <QuotaHistorySeries {series} window={model.window} />
        {/if}
      {/each}
    </div>
  </div>
</Drawer>
