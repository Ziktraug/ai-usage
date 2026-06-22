import { SegmentedControl } from '@ai-usage/design-system';
import { cx } from '@ai-usage/design-system/css';
import {
  accentFill,
  chartLegend,
  dateEditRow,
  dateFieldGroup,
  dateInput,
  inlineFieldLabel,
  monthGridline,
  timeAxis,
  timeAxisTick,
  timeBucket,
  timeBucketSegment,
  timeRangeHeader,
  timeRangeMeta,
  timeRangePanel,
  timeRangeTitle,
  timeSliderBars,
  timeSliderControl,
  timeSliderDimLeft,
  timeSliderDimRight,
  timeSliderRange,
  timeSliderRangeDrag,
  timeSliderRoot,
  timeSliderThumb,
  timeSliderTrack,
} from '@ai-usage/design-system/report';
import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import {
  clampNumber,
  dateFromIndex,
  dateIndexFrom,
  dateRangePresets,
  normalizeDateIndexRange,
  rowTime,
  shiftCalendarDays,
  startOfDay,
  type TimeRangePreset,
  toDateInputValue,
} from './date-range';
import type { DateRangeController } from './date-range-controller';
import { type DashboardRow, fmtDateOnly, fmtMoney, fmtNum, HarnessBadge, harnessFillFor } from './shared';

const track = (..._values: unknown[]) => _values.length;

type RangeDragPointerEvent = PointerEvent & { currentTarget: HTMLButtonElement };
type RangeHandle = 'start' | 'end';
interface TimelinePart {
  cost: number;
  harness: string;
}
interface TimelineBucket {
  date: Date;
  endDate: Date;
  parts: TimelinePart[];
  sessions: number;
  total: number;
}

const timelineBucketTitle = (bucket: TimelineBucket, weekly: boolean, valueMode: 'cost' | 'sessions') =>
  [
    `${weekly ? 'Week of ' : ''}${fmtDateOnly(bucket.date)} — ${
      valueMode === 'cost' ? fmtMoney(bucket.total) : `${fmtNum(bucket.sessions)} sessions`
    }`,
    ...bucket.parts.map((part) => `${part.harness} ${fmtMoney(part.cost)}`),
  ].join('\n');

const monthTickFormatter = new Intl.DateTimeFormat('en', { month: 'short' });

// Month boundaries anchor the brush; the two endpoint labels only give the
// extremes, which is not enough to aim a selection on a long domain.
const monthTicksFor = (chart: { minDay: Date; maxDay: Date; maxIndex: number }) => {
  if (chart.maxIndex < 28) {
    return [];
  }
  const monthStep = chart.maxIndex > 430 ? 3 : 1;
  const ticks: { pct: number; label: string }[] = [];
  const cursor = new Date(chart.minDay.getFullYear(), chart.minDay.getMonth() + 1, 1);
  while (cursor <= chart.maxDay) {
    if (cursor.getMonth() % monthStep === 0) {
      const pct = (dateIndexFrom(cursor, chart.minDay) / chart.maxIndex) * 100;
      if (pct >= 2 && pct <= 98) {
        const label =
          cursor.getMonth() === 0
            ? `${monthTickFormatter.format(cursor)} ’${String(cursor.getFullYear()).slice(-2)}`
            : monthTickFormatter.format(cursor);
        ticks.push({ pct, label });
      }
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return ticks;
};

export const TimeRangeControl = (props: {
  rows: DashboardRow[];
  dateRange: DateRangeController;
  activeHarness: string[];
  onHarnessFilter: (value: string) => void;
  onDateRangeCommit: () => void;
}) => {
  const [chartDomain, setChartDomain] = createSignal(props.dateRange.domain());
  const syncChartDomain = () => setChartDomain(props.dateRange.domain());
  createEffect(() => {
    track(props.rows);
    setChartDomain(untrack(() => props.dateRange.domain()));
  });

  const data = createMemo(() => {
    const domain = chartDomain();
    if (!domain) {
      return null;
    }
    const dated = props.rows
      .map((row) => ({ row, time: rowTime(row) }))
      .filter((item): item is { row: DashboardRow; time: number } => item.time != null);
    const dayCount = domain.maxIndex + 1;
    // Weekly buckets past ~4 months keep the bars readable (and the DOM small).
    const weekly = dayCount > 120;
    const bucketStart = (date: Date) => {
      const day = startOfDay(date);
      return weekly ? shiftCalendarDays(day, -((day.getDay() + 6) % 7)) : day;
    };

    const buckets = new Map<string, TimelineBucket & { byHarness: Map<string, number> }>();
    for (
      let cursor = bucketStart(domain.minDay);
      cursor <= domain.maxDay;
      cursor = shiftCalendarDays(cursor, weekly ? 7 : 1)
    ) {
      buckets.set(toDateInputValue(cursor), {
        date: cursor,
        endDate: weekly ? shiftCalendarDays(cursor, 6) : cursor,
        total: 0,
        sessions: 0,
        parts: [],
        byHarness: new Map(),
      });
    }
    const harnessTotals = new Map<string, number>();
    for (const { row, time } of dated) {
      const bucket = buckets.get(toDateInputValue(bucketStart(new Date(time))));
      if (!bucket) {
        continue;
      }
      bucket.sessions++;
      if (row.costKnown) {
        bucket.total += row.costApprox;
        bucket.byHarness.set(row.harness, (bucket.byHarness.get(row.harness) ?? 0) + row.costApprox);
        harnessTotals.set(row.harness, (harnessTotals.get(row.harness) ?? 0) + row.costApprox);
      }
    }
    const harnesses = [...harnessTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const list = [...buckets.values()].map((bucket) => ({
      date: bucket.date,
      endDate: bucket.endDate > domain.maxDay ? domain.maxDay : bucket.endDate,
      total: bucket.total,
      sessions: bucket.sessions,
      parts: harnesses
        .map((name) => ({ harness: name, cost: bucket.byHarness.get(name) ?? 0 }))
        .filter((part) => part.cost > 0),
    }));
    const maxTotal = Math.max(...list.map((bucket) => bucket.total));
    const maxSessions = Math.max(...list.map((bucket) => bucket.sessions));
    const valueMode: 'cost' | 'sessions' = maxTotal > 0 ? 'cost' : 'sessions';
    const maxValue = valueMode === 'cost' ? maxTotal : maxSessions;
    if (maxValue <= 0) {
      return null;
    }
    return {
      list,
      maxValue,
      valueMode,
      weekly,
      harnesses,
      minDay: domain.minDay,
      maxDay: domain.maxDay,
      maxIndex: domain.maxIndex,
    };
  });

  const [draggingSelection, setDraggingSelection] = createSignal(false);
  let selectionDrag: {
    pointerId: number;
    startX: number;
    startFrom: number;
    startTo: number;
    trackWidth: number;
    maxIndex: number;
  } | null = null;
  let handleDrag: {
    handle: RangeHandle;
    pointerId: number;
    startIndex: number;
    startX: number;
    trackWidth: number;
    maxIndex: number;
  } | null = null;

  const indexesForValue = (value: number[]): [number, number] | null => {
    const chart = data();
    if (!chart) {
      return null;
    }
    return normalizeDateIndexRange(value, chart.maxIndex);
  };

  const commitIndexes = (value?: number[]) => {
    if (value) {
      const nextIndexes = indexesForValue(value);
      if (nextIndexes) {
        props.dateRange.setIndexes(nextIndexes[0], nextIndexes[1]);
      }
    }
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyPreset = (mode: TimeRangePreset) => {
    props.dateRange.setPreset(mode);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyFromInput = (from: string) => {
    props.dateRange.setFromInput(from);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const applyToInput = (to: string) => {
    props.dateRange.setToInput(to);
    syncChartDomain();
    props.onDateRangeCommit();
  };

  const startSelectionDrag = (event: RangeDragPointerEvent, chart: NonNullable<ReturnType<typeof data>>) => {
    if (event.button !== 0) {
      return;
    }
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!trackRect?.width || chart.maxIndex <= 0) {
      return;
    }
    const [startFrom, startTo] = props.dateRange.selectedIndexes();
    selectionDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startFrom,
      startTo,
      trackWidth: trackRect.width,
      maxIndex: chart.maxIndex,
    };
    setDraggingSelection(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveSelectionDrag = (event: RangeDragPointerEvent) => {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) {
      return;
    }
    const span = selectionDrag.startTo - selectionDrag.startFrom;
    const delta = Math.round(
      ((event.clientX - selectionDrag.startX) / selectionDrag.trackWidth) * selectionDrag.maxIndex,
    );
    const from = clampNumber(selectionDrag.startFrom + delta, 0, Math.max(0, selectionDrag.maxIndex - span));
    props.dateRange.setIndexes(from, from + span);
    event.preventDefault();
    event.stopPropagation();
  };

  const endSelectionDrag = (event: RangeDragPointerEvent) => {
    if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) {
      return;
    }
    selectionDrag = null;
    commitIndexes();
    setDraggingSelection(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const setHandleIndex = (handle: RangeHandle, index: number) => {
    const [from, to] = props.dateRange.selectedIndexes();
    if (handle === 'start') {
      props.dateRange.setIndexes(Math.min(index, to), to);
    } else {
      props.dateRange.setIndexes(from, Math.max(index, from));
    }
  };

  const startHandleDrag = (
    event: RangeDragPointerEvent,
    handle: RangeHandle,
    chart: NonNullable<ReturnType<typeof data>>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    const trackRect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!trackRect?.width || chart.maxIndex <= 0) {
      return;
    }
    const [from, to] = props.dateRange.selectedIndexes();
    handleDrag = {
      handle,
      pointerId: event.pointerId,
      startIndex: handle === 'start' ? from : to,
      startX: event.clientX,
      trackWidth: trackRect.width,
      maxIndex: chart.maxIndex,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveHandleDrag = (event: RangeDragPointerEvent) => {
    if (!handleDrag || handleDrag.pointerId !== event.pointerId) {
      return;
    }
    const delta = Math.round(((event.clientX - handleDrag.startX) / handleDrag.trackWidth) * handleDrag.maxIndex);
    setHandleIndex(handleDrag.handle, handleDrag.startIndex + delta);
    event.preventDefault();
    event.stopPropagation();
  };

  const endHandleDrag = (event: RangeDragPointerEvent) => {
    if (!handleDrag || handleDrag.pointerId !== event.pointerId) {
      return;
    }
    handleDrag = null;
    commitIndexes();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const handleSliderKeyDown = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }, handle: RangeHandle) => {
    const chart = data();
    if (!chart) {
      return;
    }
    const [from, to] = props.dateRange.selectedIndexes();
    const current = handle === 'start' ? from : to;
    const step = event.shiftKey ? 7 : 1;
    const next = (() => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        return current - step;
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        return current + step;
      }
      if (event.key === 'PageDown') {
        return current - 30;
      }
      if (event.key === 'PageUp') {
        return current + 30;
      }
      if (event.key === 'Home') {
        return 0;
      }
      if (event.key === 'End') {
        return chart.maxIndex;
      }
      return null;
    })();
    if (next == null) {
      return;
    }
    setHandleIndex(handle, clampNumber(next, 0, chart.maxIndex));
    commitIndexes();
    event.preventDefault();
    event.stopPropagation();
  };

  const rangeVars = (chart: NonNullable<ReturnType<typeof data>>) => {
    const [from, to] = props.dateRange.selectedIndexes();
    const max = Math.max(1, chart.maxIndex);
    const startPct = (from / max) * 100;
    const endPct = 100 - (to / max) * 100;
    return {
      '--slider-range-start': `${startPct}%`,
      '--slider-range-end': `${endPct}%`,
    };
  };

  return (
    <Show
      fallback={
        <section aria-label="Date range" class={timeRangePanel}>
          <div>
            <div class={timeRangeTitle}>Time range</div>
            <div class={timeRangeMeta}>No dated sessions match the current filters</div>
          </div>
        </section>
      }
      when={data()}
    >
      {(chart) => (
        <section aria-label="Date range" class={timeRangePanel}>
          <div class={timeRangeHeader}>
            <div>
              <div class={timeRangeTitle}>Time range</div>
              <div class={timeRangeMeta}>{props.dateRange.label()}</div>
            </div>
            <SegmentedControl
              ariaLabel="Date presets"
              items={dateRangePresets.map((preset) => ({ label: preset.label, value: preset.mode }))}
              onValueChange={(value) => {
                const preset = dateRangePresets.find((item) => item.mode === value);
                if (preset) {
                  applyPreset(preset.mode);
                }
              }}
              value={props.dateRange.mode()}
            />
          </div>

          <div class={dateEditRow}>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>From</span>
              <input
                class={dateInput}
                max={toDateInputValue(chart().maxDay)}
                min={toDateInputValue(chart().minDay)}
                onInput={(event) => applyFromInput(event.currentTarget.value)}
                type="date"
                value={props.dateRange.inputValues().from}
              />
            </label>
            <label class={dateFieldGroup}>
              <span class={inlineFieldLabel}>To</span>
              <input
                class={dateInput}
                max={toDateInputValue(chart().maxDay)}
                min={toDateInputValue(chart().minDay)}
                onInput={(event) => applyToInput(event.currentTarget.value)}
                type="date"
                value={props.dateRange.inputValues().to}
              />
            </label>
            <div class={chartLegend}>
              <For each={chart().harnesses}>
                {(name) => (
                  <HarnessBadge
                    active={props.activeHarness.includes(name)}
                    name={name}
                    onClick={() => props.onHarnessFilter(name)}
                    title={props.activeHarness.includes(name) ? `Clear ${name} filter` : `Filter by ${name}`}
                  />
                )}
              </For>
            </div>
          </div>

          <div class={timeSliderRoot}>
            <div class={timeSliderControl}>
              <div class={timeSliderTrack} style={rangeVars(chart())}>
                <For each={monthTicksFor(chart())}>
                  {(tick) => <div aria-hidden="true" class={monthGridline} style={{ left: `${tick.pct}%` }} />}
                </For>
                <div
                  aria-hidden="true"
                  class={timeSliderRange}
                  style={{ left: 'var(--slider-range-start)', right: 'var(--slider-range-end)' }}
                />
                <div aria-hidden="true" class={timeSliderBars}>
                  <For each={chart().list}>
                    {(bucket) => (
                      <div class={timeBucket} title={timelineBucketTitle(bucket, chart().weekly, chart().valueMode)}>
                        <Show
                          fallback={
                            <div
                              class={cx(timeBucketSegment, accentFill)}
                              style={{ height: `${Math.max(2, (bucket.sessions / chart().maxValue) * 100)}%` }}
                            />
                          }
                          when={chart().valueMode === 'cost'}
                        >
                          <For each={bucket.parts}>
                            {(part) => (
                              <div
                                class={cx(timeBucketSegment, harnessFillFor(part.harness) ?? accentFill)}
                                style={{ height: `${Math.max(2, (part.cost / chart().maxValue) * 100)}%` }}
                              />
                            )}
                          </For>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <div aria-hidden="true" class={timeSliderDimLeft} />
                <div aria-hidden="true" class={timeSliderDimRight} />
                <button
                  aria-label="Drag selected date range"
                  class={timeSliderRangeDrag}
                  data-dragging={String(draggingSelection())}
                  onLostPointerCapture={endSelectionDrag}
                  onPointerCancel={endSelectionDrag}
                  onPointerDown={(event) => startSelectionDrag(event, chart())}
                  onPointerMove={moveSelectionDrag}
                  onPointerUp={endSelectionDrag}
                  tabIndex={-1}
                  title="Drag selected range"
                  type="button"
                />
                <button
                  aria-label="Start date"
                  aria-valuemax={chart().maxIndex}
                  aria-valuemin={0}
                  aria-valuenow={props.dateRange.selectedIndexes()[0]}
                  aria-valuetext={fmtDateOnly(dateFromIndex(chart().minDay, props.dateRange.selectedIndexes()[0]))}
                  class={timeSliderThumb}
                  onKeyDown={(event) => handleSliderKeyDown(event, 'start')}
                  onLostPointerCapture={endHandleDrag}
                  onPointerCancel={endHandleDrag}
                  onPointerDown={(event) => startHandleDrag(event, 'start', chart())}
                  onPointerMove={moveHandleDrag}
                  onPointerUp={endHandleDrag}
                  role="slider"
                  style={{ left: 'var(--slider-range-start)' }}
                  type="button"
                />
                <button
                  aria-label="End date"
                  aria-valuemax={chart().maxIndex}
                  aria-valuemin={0}
                  aria-valuenow={props.dateRange.selectedIndexes()[1]}
                  aria-valuetext={fmtDateOnly(dateFromIndex(chart().minDay, props.dateRange.selectedIndexes()[1]))}
                  class={timeSliderThumb}
                  onKeyDown={(event) => handleSliderKeyDown(event, 'end')}
                  onLostPointerCapture={endHandleDrag}
                  onPointerCancel={endHandleDrag}
                  onPointerDown={(event) => startHandleDrag(event, 'end', chart())}
                  onPointerMove={moveHandleDrag}
                  onPointerUp={endHandleDrag}
                  role="slider"
                  style={{ left: 'calc(100% - var(--slider-range-end))' }}
                  type="button"
                />
              </div>
            </div>
            <div class={timeAxis}>
              <span>{fmtDateOnly(chart().minDay)}</span>
              <For each={monthTicksFor(chart()).filter((tick) => tick.pct >= 7 && tick.pct <= 93)}>
                {(tick) => (
                  <span class={timeAxisTick} style={{ left: `${tick.pct}%` }}>
                    {tick.label}
                  </span>
                )}
              </For>
              <span>{fmtDateOnly(chart().maxDay)}</span>
            </div>
          </div>
        </section>
      )}
    </Show>
  );
};
