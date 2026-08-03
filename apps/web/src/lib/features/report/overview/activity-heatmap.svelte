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
  const cell = css({ w: '14px', h: '14px', borderRadius: 'sm', bg: 'track' });
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
  const empty = css({ color: 'muted', fontSize: '12px' });
</script>

<script lang="ts">
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { FocusedCalendarHeatmap, FocusedHeatDay } from '@ai-usage/report-core/focused-report-query';
  import { nextHeatmapFocusIndex } from '../../../../overview-model';
  import { fmtDateOnly, fmtMoney, fmtNum } from '../../../foundation/presentation/format';

  let {
    heatmap,
    onSelectDay = () => undefined,
  }: { heatmap: FocusedCalendarHeatmap | null; onSelectDay?: (date: string) => void } = $props();
  const days = $derived(
    heatmap?.weeks.flatMap((week) => week.days.filter((day): day is FocusedHeatDay => day !== null)) ?? [],
  );

  const focusMovedDay = (event: KeyboardEvent, index: number): void => {
    const next = nextHeatmapFocusIndex(index, days.length, event.key);
    if (next === null) {
      return;
    }
    event.preventDefault();
    const toolbar = (event.currentTarget as HTMLElement).closest('[role="toolbar"]');
    const target = toolbar?.querySelectorAll<HTMLButtonElement>('button[data-heatmap-day]')[next];
    target?.focus();
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
            {#if item.sessions > 0}
              <button
                aria-label={`Filter report to ${fmtDateOnly(item.date)}, ${fmtNum(item.sessions)} ${item.sessions === 1 ? 'session' : 'sessions'}`}
                class={day}
                data-heatmap-day
                onclick={() => onSelectDay(item.date)}
                onkeydown={(event) => focusMovedDay(event, index)}
                title={`${fmtDateOnly(item.date)} · ${fmtNum(item.sessions)} sessions · ${fmtMoney(item.cost)}`}
                type="button"
                style:opacity={0.2 + item.level * 0.2}
              ></button>
            {:else}
              <span class={cell} title={`${fmtDateOnly(item.date)} · 0 sessions`}></span>
            {/if}
          {/each}
        </div>
      </div>
    </div>
    <div class={legend}>
      <span>Less</span>
      {#each [1, 2, 3, 4] as level (level)}
        <span class={legendCell} style:opacity={0.2 + level * 0.2}></span>
      {/each}
      <span>More</span>
    </div>
  {:else}
    <p class={empty}>No dated sessions in range</p>
  {/if}
</section>
