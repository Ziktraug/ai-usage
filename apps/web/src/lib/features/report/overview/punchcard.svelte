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
  const legendLevels = [0.05, 0.3, 0.6, 1];
  const tooltip = css({
    display: 'grid',
    gap: '4px',
    p: '10px 12px',
    maxW: 'calc(100vw - 24px)',
    bg: 'surface',
    color: 'ink',
    border: '1px solid token(colors.lineStrong)',
    borderRadius: 'md',
    boxShadow: 'overlay',
    fontSize: '12px',
    lineHeight: 1.5,
    zIndex: 70,
    _open: { animation: 'fadeIn 0.12s ease-out' },
  });
  const tooltipDetail = css({ color: 'muted', fontSize: '11px' });
  const tooltipCount = css({ fontSize: '14px', fontWeight: 650, fontVariantNumeric: 'tabular-nums' });
</script>

<script lang="ts">
  import { Tooltip } from '@ai-usage/design-system/svelte';
  import type { FocusedPunchcard } from '@ai-usage/report-core/focused-report-query';
  import {
    isLocalTimeHour,
    isLocalTimeWeekday,
    type LocalTimeCell,
    localTimeCellLabel,
    localTimeWeekdayNames,
  } from '@ai-usage/report-core/session-query';
  import { PUNCH_DAYS, punchcardSessionMark } from '../../../../overview-model';
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
    <h4 class={panelTitle}>Punchcard</h4>
    <p class={panelSub}>When the sessions happen — hour of day × weekday</p>
  </header>
  {#if punchcard}
    <div class={punchGrid} data-punchcard-visual>
      {#each punchcard.cells as dayCells, weekday (weekday)}
        <span aria-hidden="true" class={punchDayLabel}>{PUNCH_DAYS[weekday]}</span>
        {#each dayCells as item, hour (`${weekday}:${hour}`)}
          {@const timeCell = item.sessions > 0 ? localTimeCell(weekday, hour) : null}
          <span class={punchCell}>
            {#if timeCell}
              {@const mark = punchcardSessionMark(item.sessions, punchcard.maxSessions)}
              <Tooltip contentClass={tooltip}>
                {#snippet trigger(_triggerProps)}
                  <button
                    {..._triggerProps}
                    aria-label={ariaLabel(timeCell, item.sessions)}
                    class={punchCellButton}
                    data-hour={hour}
                    data-punchcard-cell
                    data-weekday={weekday}
                    onclick={(event) => {
                      _triggerProps.onclick?.(event);
                      onSelectTimeCell(timeCell);
                    }}
                    type="button"
                  >
                    <span
                      class={cx(punchDot, accentFill)}
                      data-punchcard-cell-fill
                      style:--punch-size={`${mark.sizePx}px`}
                      style:opacity={mark.opacity}
                    ></span>
                  </button>
                {/snippet}
                {#snippet content()}
                  <span class={tooltipDetail}>{localTimeCellLabel(timeCell)}</span>
                  <strong class={tooltipCount}>
                    {fmtNum(item.sessions)} {item.sessions === 1 ? 'session' : 'sessions'}
                  </strong>
                  <span class={tooltipDetail}>{fmtMoney(item.cost)} est. API value</span>
                {/snippet}
              </Tooltip>
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
      aria-label="Punchcard session count: larger, brighter dots mean more sessions"
      class={punchIntensityKey}
      data-punchcard-intensity-key
      role="img"
    >
      <span>Low</span>
      {#each legendLevels as level (level)}
        {@const mark = punchcardSessionMark(level, 1)}
        <span
          class={cx(punchIntensityKeyCell, accentFill)}
          style:--punch-size={`${mark.sizePx}px`}
          style:opacity={mark.opacity}
        ></span>
      {/each}
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
