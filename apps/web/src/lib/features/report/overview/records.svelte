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

  let {
    onSelectDay = () => undefined,
    onSelectSession = () => undefined,
    records,
    topSessions,
  }: {
    onSelectDay?: (date: string) => void;
    onSelectSession?: (item: FocusedOverviewSessionItem) => void;
    records: FocusedOverviewRecords | null;
    topSessions: readonly FocusedOverviewSessionItem[];
  } = $props();
</script>

{#if records || topSessions.length > 0}
  <section class={panel}>
    <div>
      <h2 class={panelTitle}>Records</h2>
      <p class={panelSub}>Notable activity in the selected report range</p>
    </div>
    {#if records}
      <div class={grid}>
        {#if records.busiest}
          <button class={card} onclick={() => onSelectDay(records.busiest?.date ?? '')} type="button">
            <span class={label}>Busiest day</span><span class={value}>{fmtDateOnly(records.busiest.date)}</span>
            <span class={sub}>{fmtNum(records.busiest.sessions)} sessions · {fmtMoney(records.busiest.cost)}</span>
          </button>
        {/if}
        {#if records.topCost}
          <button class={card} onclick={() => records?.topCost && onSelectSession(records.topCost)} type="button">
            <span class={label}>Top value</span><span class={value}>{records.topCost.label}</span>
            <span class={sub}>{apiValuePresentation(records.topCost).label} · {records.topCost.harness}</span>
          </button>
        {/if}
        {#if records.longest}
          <button class={card} onclick={() => records?.longest && onSelectSession(records.longest)} type="button">
            <span class={label}>Longest</span><span class={value}>{records.longest.label}</span>
            <span class={sub}>{fmtDuration(records.longest.durationMs)} · {records.longest.harness}</span>
          </button>
        {/if}
        <div class={card}>
          <span class={label}>Longest streak</span><span class={value}>{fmtNum(records.streak)} days</span>
          <span class={sub}>{records.streakEnd ? `Through ${fmtDateOnly(records.streakEnd)}` : 'No dated streak'}</span>
        </div>
      </div>
    {/if}
    {#if topSessions.length > 0}
      <ol aria-label="Top sessions and campaigns" class={top}>
        {#each topSessions as item, index (item.row.rowId)}
          <li>
            <button class={topItem} onclick={() => onSelectSession(item)} type="button">
              <span>{index + 1}</span
              ><span
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
