<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const scroll = css({ overflowX: 'auto', pb: '4px' });
  const body = css({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(max-content, 1fr)',
    gap: '8px',
    minW: '520px',
  });
  const weekdays = css({
    display: 'grid',
    gridTemplateRows: 'repeat(7, 14px)',
    gap: '3px',
    color: 'muted',
    fontSize: '9px',
  });
  const grid = css({
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: '14px',
    gridTemplateRows: 'repeat(7, 14px)',
    gap: '3px',
  });
  const day = css({
    w: '14px',
    h: '14px',
    borderRadius: 'sm',
    bg: 'accent',
    cursor: 'pointer',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const legend = css({
    display: 'flex',
    gap: '5px',
    alignItems: 'center',
    justifyContent: 'flex-end',
    color: 'muted',
    fontSize: '10px',
  });
  const legendCell = css({ w: '12px', h: '12px', borderRadius: 'sm', bg: 'accent' });
  const readout = css({ display: 'grid', gap: '3px', p: '8px', borderRadius: 'md', bg: 'track', fontSize: '11px' });
  const muted = css({ color: 'muted' });
  const empty = css({ color: 'muted', fontSize: '12px' });
</script>

<script lang="ts">
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { FocusedCalendarHeatmap, FocusedHeatDay } from '@ai-usage/report-core/focused-report-query';
  import { nextHeatmapFocusIndex } from '../../../../overview-model';
  import { fmtDateOnly, fmtNum } from '../../../foundation/presentation/format';
  import {
    aggregateApiPriceProvenance,
    aggregateApiValuePresentation,
  } from '../../../foundation/presentation/report-value';

  let {
    heatmap,
    onSelectDay = () => undefined,
  }: { heatmap: FocusedCalendarHeatmap | null; onSelectDay?: (date: string) => void } = $props();
  const days = $derived(
    heatmap?.weeks.flatMap((week) => week.days.filter((day): day is FocusedHeatDay => day !== null)) ?? [],
  );
  const initialFocusIndex = (): number => {
    const todayIndex = heatmap ? days.findIndex((day) => day.date === heatmap.todayKey) : -1;
    return todayIndex >= 0 ? todayIndex : Math.max(0, days.length - 1);
  };
  let focusedIndex = $state(initialFocusIndex());
  const focusedDay = $derived(days[focusedIndex] ?? days[0] ?? null);

  $effect(() => {
    if (focusedIndex >= days.length) {
      focusedIndex = Math.max(0, days.length - 1);
    }
  });

  const focusMovedDay = (event: KeyboardEvent, index: number): void => {
    const next = nextHeatmapFocusIndex(index, days.length, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    focusedIndex = next;
    const toolbar = (event.currentTarget as HTMLElement).closest('[role="toolbar"]');
    toolbar?.querySelectorAll<HTMLButtonElement>('button[data-heatmap-day]')[next]?.focus();
  };
  const currentDayAria = (date: string): { readonly 'aria-current'?: 'date' } =>
    date === heatmap?.todayKey ? { 'aria-current': 'date' } : {};
  const dayTitle = (item: FocusedHeatDay): string => {
    const value = aggregateApiValuePresentation(item.priceMeasurement);
    const provenance = aggregateApiPriceProvenance(item.priceMeasurement);
    return [
      fmtDateOnly(item.date),
      `${fmtNum(item.sessions)} ${item.sessions === 1 ? 'session' : 'sessions'}`,
      value.label,
      provenance?.description ?? value.title,
    ].join(' · ');
  };
</script>

<section class={panel}>
  <div>
    <h2 class={panelTitle}>Rhythm</h2>
    <p class={panelSub}>Daily session activity in the report time zone</p>
  </div>
  {#if heatmap && days.length > 0}
    <div aria-label="Daily activity calendar" class={scroll} role="toolbar">
      <div class={body}>
        <div aria-hidden="true" class={weekdays}>
          <span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span>Sun</span>
        </div>
        <div class={grid}>
          {#each days as item, index (item.date)}
            <button
              {...currentDayAria(item.date)}
              aria-label={`Filter report to ${fmtDateOnly(item.date)}, ${fmtNum(item.sessions)} ${item.sessions === 1 ? 'session' : 'sessions'}. ${dayTitle(item)}`}
              class={day}
              data-heatmap-day
              data-price-state={item.priceMeasurement.state}
              onclick={() => onSelectDay(item.date)}
              onfocus={() => (focusedIndex = index)}
              onkeydown={(event) => focusMovedDay(event, index)}
              tabindex={focusedIndex === index ? 0 : -1}
              title={dayTitle(item)}
              type="button"
              style:opacity={item.sessions > 0 ? 0.2 + item.level * 0.2 : 0.12}
            ></button>
          {/each}
        </div>
      </div>
    </div>
    <div class={legend}>
      <span>Less</span>
      {#each [0, 1, 2, 3, 4] as level (level)}
        <span class={legendCell} style:opacity={level === 0 ? 0.12 : 0.2 + level * 0.2}></span>
      {/each}
      <span>More</span>
    </div>
    {#if focusedDay}
      {@const value = aggregateApiValuePresentation(focusedDay.priceMeasurement)}
      {@const provenance = aggregateApiPriceProvenance(focusedDay.priceMeasurement)}
      <div aria-live="polite" class={readout} data-heatmap-readout role="status">
        <strong
          >{fmtDateOnly(focusedDay.date)}
          · {fmtNum(focusedDay.sessions)} {focusedDay.sessions === 1 ? 'session' : 'sessions'}</strong
        >
        <span>{value.label}</span>
        <span class={muted}>{provenance?.description ?? value.title}</span>
      </div>
    {/if}
  {:else}
    <p class={empty}>No dated sessions in range</p>
  {/if}
</section>
