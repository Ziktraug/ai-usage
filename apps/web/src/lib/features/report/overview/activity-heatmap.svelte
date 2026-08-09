<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    heatBody,
    heatCell,
    heatCellToday,
    heatCellZero,
    heatDayControl,
    heatDayDetail,
    heatGrid,
    heatLegend,
    heatLegendCell,
    heatMonths,
    heatScroll,
    heatWeekColumn,
    heatWeekdays,
    panel,
    panelHeader,
    panelSub,
    panelTitle,
  } from '@ai-usage/design-system/report';

  const accentFill = css({ bg: 'accent' });
  const emptyPanel = css({ color: 'muted', fontSize: '12px' });
  const heatOpacity = [0.28, 0.52, 0.76, 1] as const;
</script>

<script lang="ts">
  import type { FocusedCalendarHeatmap, FocusedHeatDay } from '@ai-usage/report-core/focused-report-query';
  import { toDateInputValue } from '../../../../date-range';
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
  let scrollElement = $state<HTMLDivElement>();
  const cellElements = new Map<string, HTMLButtonElement>();
  const dateKey = (date: string): string => toDateInputValue(new Date(date));
  const days = $derived(
    heatmap?.weeks.flatMap((week) => week.days.filter((day): day is FocusedHeatDay => day !== null)) ?? [],
  );
  const initialFocusIndex = (): number => {
    const todayIndex = heatmap ? days.findIndex((day) => dateKey(day.date) === heatmap.todayKey) : -1;
    return todayIndex >= 0 ? todayIndex : Math.max(0, days.length - 1);
  };
  let focusedIndex = $state(initialFocusIndex());
  const focusedDay = $derived(days[focusedIndex] ?? days[0]);

  $effect(() => {
    if (focusedIndex >= days.length) {
      focusedIndex = Math.max(0, days.length - 1);
    }
  });
  $effect(() => {
    if (heatmap && scrollElement) {
      scrollElement.scrollLeft = scrollElement.scrollWidth;
    }
  });

  const describeHeatDay = (item: FocusedHeatDay): string => {
    const value = aggregateApiValuePresentation(item.priceMeasurement).label;
    const provenance = aggregateApiPriceProvenance(item.priceMeasurement);
    return `${fmtDateOnly(item.date)} — ${value} · ${fmtNum(item.sessions)} sessions${provenance ? ` · ${provenance.label}` : ''}`;
  };
  const describeHeatDayWithProvenance = (item: FocusedHeatDay): string => {
    const description = describeHeatDay(item);
    const provenance = aggregateApiPriceProvenance(item.priceMeasurement);
    return provenance ? `${description}. ${provenance.description}` : description;
  };
  const focusDay = (item: FocusedHeatDay, moveDomFocus = false): void => {
    const index = days.findIndex((candidate) => candidate.date === item.date);
    if (index < 0) {
      return;
    }
    focusedIndex = index;
    if (moveDomFocus) {
      cellElements.get(dateKey(item.date))?.focus();
    }
  };
  const focusMovedDay = (event: KeyboardEvent, item: FocusedHeatDay): void => {
    const currentIndex = days.findIndex((candidate) => candidate.date === item.date);
    const nextIndex = nextHeatmapFocusIndex(currentIndex, days.length, event.key);
    if (nextIndex === null) {
      return;
    }
    const nextDay = days[nextIndex];
    if (!nextDay) {
      return;
    }
    event.preventDefault();
    focusDay(nextDay, true);
  };
  const registerCell = (element: HTMLButtonElement, key: string): { destroy: () => void } => {
    cellElements.set(key, element);
    return { destroy: () => cellElements.delete(key) };
  };
  const currentDayAria = (date: string): { readonly 'aria-current'?: 'date' } =>
    dateKey(date) === heatmap?.todayKey ? { 'aria-current': 'date' } : {};
</script>

<section class={panel}>
  <header class={panelHeader}>
    <h2 class={panelTitle}>Rhythm</h2>
    <div class={panelSub}>
      Daily activity across the whole filtered history — choose a day to focus the dashboard on it
    </div>
  </header>
  {#if heatmap && days.length > 0}
    <div class={heatBody}>
      <div aria-hidden="true" class={heatWeekdays}>
        <span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span></span>
      </div>
      <div class={heatScroll} bind:this={scrollElement}>
        <div aria-hidden="true" class={heatMonths}>
          {#each heatmap.monthLabels as label, index (`${label}-${index}`)}
            <span>{label}</span>
          {/each}
        </div>
        <div
          aria-label="Daily activity calendar. Use arrow keys to move by day or week."
          class={heatGrid}
          role="toolbar"
        >
          {#each heatmap.weeks as week, weekIndex (weekIndex)}
            <div class={heatWeekColumn}>
              {#each week.days as item, dayIndex (`${weekIndex}-${dayIndex}`)}
                {#if item}
                  {@const key = dateKey(item.date)}
                  {@const description = describeHeatDayWithProvenance(item)}
                  <button
                    {...currentDayAria(item.date)}
                    aria-label={`${description}. Focus dashboard on this day.`}
                    class={cx(heatCell, item.level === 0 ? heatCellZero : accentFill, key === heatmap.todayKey ? heatCellToday : undefined)}
                    data-heatmap-day={key}
                    data-price-state={item.priceMeasurement.state}
                    onclick={() => onSelectDay(key)}
                    onfocus={() => focusDay(item)}
                    onkeydown={(event) => focusMovedDay(event, item)}
                    tabindex={focusedDay?.date === item.date ? 0 : -1}
                    title={description}
                    type="button"
                    style:opacity={item.level > 0 ? heatOpacity[item.level - 1] : undefined}
                    use:registerCell={key}
                  ></button>
                {:else}
                  <span></span>
                {/if}
              {/each}
            </div>
          {/each}
        </div>
      </div>
    </div>
    <div aria-live="polite" class={heatDayControl} data-heatmap-readout role="status">
      <span class={heatDayDetail}
        >{focusedDay ? describeHeatDay(focusedDay) : 'Choose a day in the activity range.'}</span
      >
    </div>
    <div class={heatLegend}>
      <span>Less</span><span class={cx(heatLegendCell, heatCellZero)}></span>
      {#each heatOpacity as opacity (opacity)}
        <span class={cx(heatLegendCell, accentFill)} style:opacity></span>
      {/each}
      <span>More</span><span style="margin-left: auto">scaled by sessions</span>
    </div>
  {:else}
    <div class={emptyPanel}>No dated sessions match the current filters</div>
  {/if}
</section>
