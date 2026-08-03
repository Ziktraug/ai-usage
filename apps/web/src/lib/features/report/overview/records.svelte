<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const grid = css({
    display: 'grid',
    gap: '10px',
    gridTemplateColumns: { base: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
  });
  const card = css({
    display: 'grid',
    gap: '4px',
    p: '12px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    textAlign: 'left',
  });
  const label = css({ color: 'muted', fontSize: '11px', textTransform: 'uppercase' });
  const value = css({ fontSize: '14px', fontWeight: 650, overflowWrap: 'anywhere' });
  const sub = css({ color: 'muted', fontSize: '11px' });
  const top = css({ display: 'grid', gap: '6px', mt: '8px' });
  const topItem = css({
    display: 'grid',
    gridTemplateColumns: '24px minmax(0, 1fr) auto',
    gap: '8px',
    alignItems: 'baseline',
    p: '7px 0',
    borderTop: '1px solid token(colors.line)',
  });
  const money = css({ fontWeight: 650, textStyle: 'numeric' });
</script>

<script lang="ts">
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
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

{#if presentedRecords || presentedTopSessions.length > 0}
  <section class={panel}>
    <div>
      <h2 class={panelTitle}>Records</h2>
      <p class={panelSub}>Notable activity in the selected report range</p>
    </div>
    {#if presentedRecords}
      <div class={grid}>
        {#if presentedRecords.busiest}
          <button class={card} onclick={() => onSelectDay(presentedRecords.busiest?.date ?? '')} type="button">
            <span class={label}>Busiest day</span
            ><span class={value}>{fmtDateOnly(presentedRecords.busiest.date)}</span>
            <span class={sub}
              >{fmtNum(presentedRecords.busiest.sessions)}
              sessions · {fmtMoney(presentedRecords.busiest.cost)}</span
            >
          </button>
        {/if}
        {#if presentedRecords.topCost}
          <button
            class={card}
            onclick={() => presentedRecords?.topCost && onSelectSession(presentedRecords.topCost)}
            type="button"
          >
            <span class={label}>Top session</span><span class={value}>{presentedRecords.topCost.label}</span>
            <span class={sub}
              >{apiValuePresentation(presentedRecords.topCost).label}
              · {presentedRecords.topCost.harness}</span
            >
          </button>
        {/if}
        {#if presentedRecords.longest}
          <button
            class={card}
            onclick={() => presentedRecords?.longest && onSelectSession(presentedRecords.longest)}
            type="button"
          >
            <span class={label}>Longest session</span><span class={value}>{presentedRecords.longest.label}</span>
            <span class={sub}
              >{fmtDuration(presentedRecords.longest.durationMs)}
              · {presentedRecords.longest.harness}</span
            >
          </button>
        {/if}
        <div class={card}>
          <span class={label}>Longest streak</span><span class={value}>{fmtNum(presentedRecords.streak)} days</span>
          <span class={sub}
            >{presentedRecords.streakEnd ? `Through ${fmtDateOnly(presentedRecords.streakEnd)}` : 'No dated streak'}</span
          >
        </div>
      </div>
    {/if}
    {#if presentedTopSessions.length > 0}
      <ol aria-label="Top sessions and campaigns" class={top}>
        {#each presentedTopSessions as item, index (item.row.rowId)}
          <li>
            <button class={topItem} onclick={() => onSelectSession(item)} type="button">
              <span>{index + 1}</span>
              <span
                >{item.label}
                <span class={sub}>
                  · {item.sessionCount} {item.kind === 'campaign' ? 'campaign sessions' : 'session'}</span
                ></span
              >
              <span class={money}>{apiValuePresentation(item).label}</span>
            </button>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
{/if}
