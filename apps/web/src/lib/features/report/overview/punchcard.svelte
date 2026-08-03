<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const scroll = css({ overflowX: 'auto', pb: '4px' });
  const grid = css({
    display: 'grid',
    gridTemplateColumns: '34px repeat(24, 18px)',
    gap: '3px',
    minW: '560px',
    alignItems: 'center',
  });
  const dayLabel = css({ color: 'muted', fontSize: '9px' });
  const cell = css({ display: 'grid', placeItems: 'center', w: '18px', h: '18px' });
  const button = css({
    display: 'grid',
    placeItems: 'center',
    w: '18px',
    h: '18px',
    cursor: 'pointer',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '1px' },
  });
  const dot = css({ display: 'block', w: '10px', h: '10px', borderRadius: 'full', bg: 'accent' });
  const hourLabel = css({ color: 'muted', fontSize: '8px', textAlign: 'center' });
  const key = css({
    display: 'flex',
    gap: '5px',
    alignItems: 'center',
    justifyContent: 'flex-end',
    color: 'muted',
    fontSize: '10px',
  });
  const keyCell = css({ w: '10px', h: '10px', borderRadius: 'full', bg: 'accent' });
  const empty = css({ color: 'muted', fontSize: '12px' });
  const srOnly = css({ srOnly: true });
</script>

<script lang="ts">
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { FocusedPunchcard } from '@ai-usage/report-core/focused-report-query';
  import {
    isLocalTimeHour,
    isLocalTimeWeekday,
    type LocalTimeCell,
    localTimeCellLabel,
    localTimeWeekdayNames,
  } from '@ai-usage/report-core/session-query';
  import { PUNCH_DAYS, punchcardSessionOpacity } from '../../../../overview-model';
  import { fmtMoney, fmtNum } from '../../../foundation/presentation/format';

  let {
    onSelectTimeCell = () => undefined,
    punchcard,
  }: { onSelectTimeCell?: (cell: LocalTimeCell) => void; punchcard: FocusedPunchcard | null } = $props();

  const localTimeCell = (weekday: number, hour: number): LocalTimeCell | null =>
    isLocalTimeWeekday(weekday) && isLocalTimeHour(hour) ? { hour, weekday } : null;
  const accessibleCells = $derived(
    punchcard?.cells.flatMap((dayCells, weekday) =>
      dayCells.flatMap((item, hour) =>
        item.sessions > 0
          ? [{ cost: item.cost, day: localTimeWeekdayNames[weekday] ?? '', hour, sessions: item.sessions }]
          : [],
      ),
    ) ?? [],
  );
  const ariaLabel = (cell: LocalTimeCell, sessions: number): string =>
    `Filter report to ${localTimeCellLabel(cell)}, ${fmtNum(sessions)} ${sessions === 1 ? 'session' : 'sessions'}`;
  const moveFocus = (event: KeyboardEvent, weekday: number, hour: number): void => {
    let nextWeekday = weekday;
    let nextHour = hour;
    if (event.key === 'ArrowLeft') {
      nextHour = Math.max(0, hour - 1);
    } else if (event.key === 'ArrowRight') {
      nextHour = Math.min(23, hour + 1);
    } else if (event.key === 'ArrowUp') {
      nextWeekday = Math.max(0, weekday - 1);
    } else if (event.key === 'ArrowDown') {
      nextWeekday = Math.min(6, weekday + 1);
    } else if (event.key === 'Home') {
      nextHour = 0;
    } else if (event.key === 'End') {
      nextHour = 23;
    } else {
      return;
    }
    event.preventDefault();
    const section = (event.currentTarget as HTMLElement).closest('section');
    const exact = section?.querySelector<HTMLButtonElement>(
      `button[data-weekday="${nextWeekday}"][data-hour="${nextHour}"]`,
    );
    const fallback = section?.querySelector<HTMLButtonElement>('button[data-punchcard-cell]');
    (exact ?? fallback)?.focus();
  };
</script>

<section class={panel}>
  <div>
    <h2 class={panelTitle}>Punchcard</h2>
    <p class={panelSub}>When the sessions happen — hour of day × weekday</p>
  </div>
  {#if punchcard}
    <div class={scroll}>
      <div class={grid} data-punchcard-visual>
        {#each punchcard.cells as dayCells, weekday (weekday)}
          <span class={dayLabel}>{PUNCH_DAYS[weekday]}</span>
          {#each dayCells as item, hour (`${weekday}:${hour}`)}
            {@const timeCell = item.sessions > 0 ? localTimeCell(weekday, hour) : null}
            <span
              class={cell}
              title={`${localTimeWeekdayNames[weekday]} ${String(hour).padStart(2, '0')}:00 — ${fmtNum(item.sessions)} sessions · ${fmtMoney(item.cost)}`}
            >
              {#if timeCell}
                <button
                  aria-label={ariaLabel(timeCell, item.sessions)}
                  class={button}
                  data-hour={hour}
                  data-punchcard-cell
                  data-weekday={weekday}
                  onclick={() => onSelectTimeCell(timeCell)}
                  onkeydown={(event) => moveFocus(event, weekday, hour)}
                  type="button"
                >
                  <span
                    class={dot}
                    data-punchcard-cell-fill
                    style:opacity={punchcardSessionOpacity(item.sessions, punchcard.maxSessions)}
                  ></span>
                </button>
              {/if}
            </span>
          {/each}
        {/each}
        <span></span>
        {#each Array.from({ length: 24 }, (_, hour) => hour) as hour (hour)}
          <span class={hourLabel}>{hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}</span>
        {/each}
      </div>
    </div>
    <div class={key} data-punchcard-intensity-key>
      <span>Low</span><span class={keyCell} style:opacity="0.3"></span><span class={keyCell}></span><span>High</span>
    </div>
    <div class={srOnly}>
      <table aria-label="Punchcard">
        <caption>
          Non-empty activity periods
        </caption>
        <thead>
          <tr>
            <th scope="col">Weekday</th>
            <th scope="col">Hour</th>
            <th scope="col">Sessions</th>
            <th scope="col">Estimated API-equivalent value</th>
          </tr>
        </thead>
        <tbody>
          {#each accessibleCells as item (`${item.day}:${item.hour}`)}
            <tr>
              <th scope="row">{item.day}</th>
              <td>{String(item.hour).padStart(2, '0')}:00</td>
              <td>{fmtNum(item.sessions)}</td>
              <td>{fmtMoney(item.cost)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class={empty}>No dated sessions in range</p>
  {/if}
</section>
