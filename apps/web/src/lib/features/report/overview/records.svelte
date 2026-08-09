<script lang="ts">
  import {
    muted,
    panel,
    panelHeader,
    panelSub,
    panelTitle,
    recordCard,
    recordLabel,
    recordSub,
    recordsGrid,
    recordValue,
    topList,
    topMoney,
    topRank,
    topRow,
    topTitle,
  } from '@ai-usage/design-system/report';
  import HarnessBadge from '@ai-usage/design-system/svelte/harness-badge';
  import type { FocusedOverviewRecords, FocusedOverviewSessionItem } from '@ai-usage/report-core/focused-report-query';
  import { fmtDateOnly, fmtDuration, fmtMoney, fmtNum } from '../../../foundation/presentation/format';
  import { apiValuePresentation } from '../../../foundation/presentation/report-value';

  const unchangedItem = (item: FocusedOverviewSessionItem): FocusedOverviewSessionItem => item;
  let {
    onSelectDay = () => undefined,
    onSelectSession = () => undefined,
    presentSessionItem = unchangedItem,
    records,
    topSessions,
  }: {
    onSelectDay?: (date: string) => void;
    onSelectSession?: (item: FocusedOverviewSessionItem) => void;
    presentSessionItem?: (item: FocusedOverviewSessionItem) => FocusedOverviewSessionItem;
    records: FocusedOverviewRecords | null;
    topSessions: readonly FocusedOverviewSessionItem[];
  } = $props();
  const presentedRecords = $derived(
    records
      ? {
          ...records,
          longest: records.longest ? presentSessionItem(records.longest) : null,
          topCost: records.topCost ? presentSessionItem(records.topCost) : null,
        }
      : null,
  );
  const presentedTopSessions = $derived(topSessions.map(presentSessionItem));
</script>

{#if presentedRecords}
  <div class={recordsGrid}>
    {#if presentedRecords.topCost}
      <button class={recordCard} onclick={() => onSelectSession(presentedRecords.topCost!)} type="button">
        <span class={recordLabel}>Top session</span>
        <span class={recordValue} title={apiValuePresentation(presentedRecords.topCost).title}
          >{apiValuePresentation(presentedRecords.topCost).label}</span
        >
        <span class={recordSub}>{presentedRecords.topCost.label}</span>
      </button>
    {/if}
    {#if presentedRecords.longest}
      <button class={recordCard} onclick={() => onSelectSession(presentedRecords.longest!)} type="button">
        <span class={recordLabel}>Longest session</span>
        <span class={recordValue}>{fmtDuration(presentedRecords.longest.durationMs)}</span>
        <span class={recordSub}>{presentedRecords.longest.label}</span>
      </button>
    {/if}
    {#if presentedRecords.busiest}
      <button class={recordCard} onclick={() => onSelectDay(presentedRecords.busiest!.date)} type="button">
        <span class={recordLabel}>Busiest day</span>
        <span class={recordValue}>{fmtMoney(presentedRecords.busiest.cost)}</span>
        <span class={recordSub}
          >{fmtDateOnly(presentedRecords.busiest.date)}
          · {fmtNum(presentedRecords.busiest.sessions)} sessions</span
        >
      </button>
    {/if}
    {#if presentedRecords.streak > 0 && presentedRecords.streakEnd}
      <button class={recordCard} onclick={() => onSelectDay(presentedRecords.streakEnd!)} type="button">
        <span class={recordLabel}>Streak</span>
        <span class={recordValue}
          >{fmtNum(presentedRecords.streak)} {presentedRecords.streak === 1 ? 'day' : 'days'}</span
        >
        <span class={recordSub}>consecutive days with sessions, ending {fmtDateOnly(presentedRecords.streakEnd)}</span>
      </button>
    {/if}
  </div>
{/if}

{#if presentedTopSessions.length > 0}
  <section class={panel}>
    <header class={panelHeader}>
      <h2 class={panelTitle}>Top sessions</h2>
      <p class={panelSub}>
        The five highest estimated API-equivalent values for sessions or campaigns in range — click to inspect
      </p>
    </header>
    <div class={topList}>
      {#each presentedTopSessions as item, index (item.row.rowId)}
        <button class={topRow} onclick={() => onSelectSession(item)} type="button">
          <span class={topRank}>{index + 1}</span>
          <span class={topTitle}>
            {item.label}
            {#if item.kind === 'campaign'}
              <span class={muted}> · Campaign · {fmtNum(item.sessionCount)} sessions</span>
            {/if}
          </span>
          <HarnessBadge name={item.harness} />
          <span class={topMoney} title={apiValuePresentation(item).title}>{apiValuePresentation(item).label}</span>
        </button>
      {/each}
    </div>
  </section>
{/if}
