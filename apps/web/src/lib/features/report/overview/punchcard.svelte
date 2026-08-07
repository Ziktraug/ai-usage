<script lang="ts" module>
  import { css, cx } from '@ai-usage/design-system/css';
  import {
    accentFill,
    emptyPanel,
    panel,
    panelHeader,
    panelSub,
    panelTitle,
    punchCell,
    punchCellButton,
    punchDayLabel,
    punchDot,
    punchGrid,
    punchHourLabel,
    punchIntensityKey,
    punchIntensityKeyCell,
  } from '@ai-usage/design-system/report';

  const srOnly = css({ srOnly: true });
</script>

<script lang="ts">
  import type { FocusedPunchcard } from '@ai-usage/report-core/focused-report-query';
  import {
    isLocalTimeHour,
    isLocalTimeWeekday,
    type LocalTimeCell,
    localTimeCellLabel,
    localTimeWeekdayNames,
  } from '@ai-usage/report-core/session-query';
  import { PUNCH_DAYS, PUNCHCARD_MIN_SESSION_OPACITY, punchcardSessionOpacity } from '../../../../overview-model';
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
</script>

<section class={panel}>
  <header class={panelHeader}>
    <!-- h3: this panel only ever renders inside the "Advanced analysis" h2 section. -->
    <h3 class={panelTitle}>Punchcard</h3>
    <p class={panelSub}>When the sessions happen — hour of day × weekday</p>
  </header>
  {#if punchcard}
    <div class={punchGrid} data-punchcard-visual>
      {#each punchcard.cells as dayCells, weekday (weekday)}
        <span aria-hidden="true" class={punchDayLabel}>{PUNCH_DAYS[weekday]}</span>
        {#each dayCells as item, hour (`${weekday}:${hour}`)}
          {@const timeCell = item.sessions > 0 ? localTimeCell(weekday, hour) : null}
          <span
            class={punchCell}
            title={`${PUNCH_DAYS[weekday]} ${String(hour).padStart(2, '0')}:00 — ${fmtNum(item.sessions)} sessions · ${fmtMoney(item.cost)}`}
          >
            {#if timeCell}
              <button
                aria-label={ariaLabel(timeCell, item.sessions)}
                class={punchCellButton}
                data-hour={hour}
                data-punchcard-cell
                data-weekday={weekday}
                onclick={() => onSelectTimeCell(timeCell)}
                type="button"
              >
                <span
                  class={cx(punchDot, accentFill)}
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
        <span aria-hidden="true" class={punchHourLabel}>{hour % 3 === 0 ? hour : ''}</span>
      {/each}
    </div>
    <div
      aria-label="Punchcard session-count intensity"
      class={punchIntensityKey}
      data-punchcard-intensity-key
      role="img"
    >
      <span>Low</span>
      <span class={cx(punchIntensityKeyCell, accentFill)} style:opacity={PUNCHCARD_MIN_SESSION_OPACITY}></span>
      <span class={cx(punchIntensityKeyCell, accentFill)}></span>
      <span>High</span>
      <span>session count</span>
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
    <p class={emptyPanel}>No dated sessions in range</p>
  {/if}
</section>
