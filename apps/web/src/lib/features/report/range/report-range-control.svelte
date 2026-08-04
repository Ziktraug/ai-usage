<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits the numeric slider bounds and position from typed state; time-range.spec.ts asserts the rendered values -->
<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const shell = css({ display: 'grid', gap: '14px' });
  const presetRow = css({ display: 'flex', flexWrap: 'wrap', gap: '6px' });
  const preset = css({
    px: '10px',
    py: '6px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    fontSize: '12px',
  });
  const selectedPreset = css({ bg: 'accent', color: 'surface' });
  const summary = css({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: '8px',
    color: 'muted',
    fontSize: '12px',
  });
  const fields = css({
    display: 'grid',
    gridTemplateColumns: { base: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
    gap: '10px',
  });
  const field = css({ display: 'grid', gap: '4px', color: 'muted', fontSize: '11px' });
  const input = css({
    px: '10px',
    py: '7px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surface',
    color: 'ink',
    fontSize: '12px',
  });
  const brush = css({ position: 'relative', h: '36px', mx: '10px' });
  const track = css({ position: 'absolute', insetInline: 0, top: '16px', h: '4px', borderRadius: 'full', bg: 'track' });
  const selection = css({
    position: 'absolute',
    top: '10px',
    h: '16px',
    borderRadius: 'full',
    bg: 'accent',
    opacity: 0.3,
    cursor: 'grab',
  });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import {
    panel,
    panelSub,
    panelTitle,
    SegmentedControl,
    timeChartOptions,
    timeChartOptionsCurrent,
    timeChartOptionsSummary,
    timeChartOptionsTitle,
    timeRangeViewControls,
    timeSliderThumb,
  } from '@ai-usage/design-system/svelte';
  import {
    type FocusedDateDomain,
    type FocusedTimelineData,
    type FocusedTimelineSeries,
    focusedTimelineDimensionDefinitions,
    focusedTimelineDimensionLabel,
    isFocusedTimelineDimension,
  } from '@ai-usage/report-core/focused-report-query';
  import { flushSync, untrack } from 'svelte';
  import type { DashboardDateRangeSearch, DashboardSearch } from '../../../../dashboard-search';
  import { dateFromIndex, dateRangePresets, parseLocalDate } from '../../../../date-range';
  import type { MigrationGranularity, TimelineDimension, TimelineValue } from '../../../../overview-model';
  import {
    createTimeRangeControlState,
    type TimeRangeControlState,
    type TimeRangeSelectionIndexes,
    transitionTimeRangeControl,
  } from '../../../../time-range-control-state';
  import type { SearchNavigationIntent, SearchNavigationOptions } from '../../../foundation/navigation/search-intent';
  import { createSearchEditRun } from '../../../foundation/navigation/svelte/dashboard-url';
  import { fmtDateOnly } from '../../../foundation/presentation/format';
  import ActivityTimeline from '../overview/activity-timeline.svelte';
  import type { MachineSeriesPresenter } from '../overview/timeline-model';
  import { timelineRangeForSelection } from '../overview/timeline-window';
  import {
    customRangeFromIndexes,
    customRangeFromInputs,
    escapedRangeDraft,
    inputValueForRange,
    reportRangeEditKey,
    reportRangePointerFinishType,
    reportRangeProjection,
  } from './report-range-model';

  interface Props {
    activeSeriesKeys?: readonly string[];
    dateDomain: FocusedDateDomain | null;
    dimension: TimelineDimension;
    generatedAt: string;
    granularity: MigrationGranularity;
    machineFreshnessStatus?: string | null;
    navigate?: SearchNavigationIntent<DashboardSearch> | undefined;
    onDimensionFilter?: (dimension: TimelineDimension, key: string) => void;
    onOptionsChange?: (options: {
      dimension: TimelineDimension;
      granularity: MigrationGranularity;
      value: TimelineValue;
    }) => void;
    onRangeChange?: (range: DashboardDateRangeSearch) => void;
    presentCampaignSeries?: (series: FocusedTimelineSeries) => FocusedTimelineSeries;
    presentMachineSeries?: MachineSeriesPresenter;
    range: DashboardDateRangeSearch;
    timeline: FocusedTimelineData | null;
    value: TimelineValue;
  }

  let {
    activeSeriesKeys = [],
    dateDomain,
    dimension,
    generatedAt,
    granularity,
    machineFreshnessStatus = null,
    navigate,
    onDimensionFilter = () => undefined,
    onOptionsChange = () => undefined,
    onRangeChange = () => undefined,
    presentCampaignSeries,
    presentMachineSeries,
    range,
    timeline,
    value,
  }: Props = $props();

  const generatedDate = $derived(new Date(generatedAt));
  const projection = $derived(reportRangeProjection(range, generatedDate, dateDomain));
  const initialControlState = (): TimeRangeControlState =>
    createTimeRangeControlState({
      context: { selectionMaxIndex: projection.maxIndex },
      options: { dimension, granularity, value },
      selectionIndexes: projection.selectionIndexes,
    });
  const initialFrom = (): string => projection.displayFrom;
  const initialTo = (): string => projection.displayTo;
  let controlState: TimeRangeControlState = $state(initialControlState());
  let draftFrom = $state(initialFrom());
  let draftTo = $state(initialTo());
  let cancelledInput = $state<'end' | 'start' | null>(null);
  let editingInput = $state<'end' | 'start' | null>(null);
  const editRun = createSearchEditRun(untrack(() => reportRangeEditKey(range)));
  const currentControlKey = (): string =>
    JSON.stringify({
      dimension,
      granularity,
      maximumIndex: projection.maxIndex,
      range,
      selectionIndexes: projection.selectionIndexes,
      value,
    });
  const initialControlKey = (): string => currentControlKey();
  let synchronizedControlKey = $state(initialControlKey());
  const selectionIndexFor = (edge: 'end' | 'start'): number =>
    edge === 'start' ? controlState.selectionIndexes[0] : controlState.selectionIndexes[1];
  const dateForHandle = (edge: 'end' | 'start'): Date => dateFromIndex(projection.domainFirst, selectionIndexFor(edge));
  const normalizedDraft = (draft: string, display: string, edge: 'end' | 'start'): string =>
    draft === display ? inputValueForRange(dateForHandle(edge)) : draft;

  $effect(() => {
    const key = currentControlKey();
    if (key === synchronizedControlKey || controlState.interaction.type !== 'idle') {
      return;
    }
    controlState = createTimeRangeControlState({
      context: { selectionMaxIndex: projection.maxIndex },
      options: { dimension, granularity, value },
      selectionIndexes: projection.selectionIndexes,
    });
    if (editingInput !== 'start') {
      draftFrom = projection.displayFrom;
    }
    if (editingInput !== 'end') {
      draftTo = projection.displayTo;
    }
    editRun.synchronize(reportRangeEditKey(range));
    synchronizedControlKey = key;
  });

  const percentFor = (index: number): number => (projection.maxIndex > 0 ? (index / projection.maxIndex) * 100 : 0);
  const startPercent = $derived(percentFor(controlState.selectionIndexes[0]));
  const endPercent = $derived(percentFor(controlState.selectionIndexes[1]));
  // The brush addresses calendar days over the whole domain; the chart draws
  // buckets. Translate the live selection into the bucket window it covers so
  // the Activity chart honours the promise printed above it.
  const visibleRange = $derived(
    timeline
      ? timelineRangeForSelection(timeline.buckets, projection.domainFirst, controlState.selectionIndexes)
      : null,
  );
  const dimensionItems = focusedTimelineDimensionDefinitions;
  // Carrying the label with the edge keeps the markup free of repeated
  // `handle === 'start'` branches, and the binding name stays clear of every
  // style constant in this file.
  const rangeHandles = [
    { edge: 'start', label: 'Start date' },
    { edge: 'end', label: 'End date' },
  ] as const satisfies readonly { edge: 'end' | 'start'; label: string }[];
  const pressedAria = (mode: DashboardDateRangeSearch['mode']) => ({ 'aria-pressed': range.mode === mode });
  // A bucket index announces nothing useful on its own, so each handle also
  // exposes the day it resolves to. Assistive technology prefers
  // `aria-valuetext` over `aria-valuenow` whenever both are present.
  const handleValueText = (edge: 'end' | 'start'): string => fmtDateOnly(dateForHandle(edge));
  const granularityItems = [
    { label: 'Day', value: 'day' },
    { label: 'Week', value: 'week' },
    { label: 'Month', value: 'month' },
  ] as const;
  const valueItems = [
    { label: 'Estimated API-equivalent value', value: 'cost' },
    { label: 'Sessions', value: 'sessions' },
    { label: 'Share', value: 'share' },
  ] as const;
  const valueLabels: Record<TimelineValue, string> = {
    cost: 'Estimated API-equivalent value',
    sessions: 'Sessions',
    share: 'Share',
  };
  const chartSummary = $derived(
    `${focusedTimelineDimensionLabel(dimension)} · ${granularity[0]?.toUpperCase()}${granularity.slice(1)} · ${
      valueLabels[value]
    }`,
  );

  const commitRange = (next: DashboardDateRangeSearch, options: SearchNavigationOptions = {}): void => {
    if (navigate) {
      navigate((current) => ({ ...current, range: next }), { ...options, resetScroll: false });
      return;
    }
    onRangeChange(next);
  };

  const synchronizeInputs = (indexes: TimeRangeSelectionIndexes): void => {
    const next = customRangeFromIndexes(projection, indexes);
    const nextProjection = reportRangeProjection(next, generatedDate, dateDomain);
    draftFrom = nextProjection.displayFrom;
    draftTo = nextProjection.displayTo;
    const options = editRun.next(reportRangeEditKey(next));
    if (options) {
      commitRange(next, options);
    }
  };

  const applyTransition = (event: Parameters<typeof transitionTimeRangeControl>[1]): boolean => {
    const transition = transitionTimeRangeControl(controlState, event, { selectionMaxIndex: projection.maxIndex });
    if (!transition.handled) {
      return false;
    }
    controlState = transition.state;
    for (const command of transition.commands) {
      if (command.type === 'setSelectionIndexes') {
        synchronizeInputs(command.indexes);
      } else {
        editRun.commit();
      }
    }
    return true;
  };

  const selectPreset = (mode: DashboardDateRangeSearch['mode']): void => {
    const next = { mode } satisfies DashboardDateRangeSearch;
    commitRange(next);
    const nextProjection = reportRangeProjection(next, generatedDate, dateDomain);
    controlState = createTimeRangeControlState({
      context: { selectionMaxIndex: nextProjection.maxIndex },
      options: { dimension, granularity, value },
      selectionIndexes: nextProjection.selectionIndexes,
    });
    draftFrom = nextProjection.displayFrom;
    draftTo = nextProjection.displayTo;
    editRun.commit();
    editRun.synchronize(reportRangeEditKey(next));
  };

  const commitInputs = (settle: boolean): void => {
    const next = customRangeFromInputs(
      normalizedDraft(draftFrom, projection.displayFrom, 'start'),
      normalizedDraft(draftTo, projection.displayTo, 'end'),
    );
    if (!next) {
      return;
    }
    const options = editRun.next(reportRangeEditKey(next));
    if (options) {
      commitRange(next, options);
    }
    const nextProjection = reportRangeProjection(next, generatedDate, dateDomain);
    controlState = transitionTimeRangeControl(
      controlState,
      { selectionIndexes: nextProjection.selectionIndexes, source: 'input', type: 'selectionSynchronized' },
      { selectionMaxIndex: nextProjection.maxIndex },
    ).state;
    if (settle) {
      draftFrom = nextProjection.displayFrom;
      draftTo = nextProjection.displayTo;
      editRun.commit();
    }
  };

  const finishInput = (field: 'end' | 'start'): void => {
    if (cancelledInput === field) {
      cancelledInput = null;
      if (field === 'start') {
        draftFrom = escapedRangeDraft(projection, field);
      } else {
        draftTo = escapedRangeDraft(projection, field);
      }
      return;
    }
    commitInputs(true);
  };

  const commitInputKey = (event: KeyboardEvent, field: 'end' | 'start'): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelledInput = field;
      if (field === 'start') {
        draftFrom = escapedRangeDraft(projection, field);
      } else {
        draftTo = escapedRangeDraft(projection, field);
      }
      editRun.commit();
      (event.currentTarget as HTMLInputElement).blur();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commitInputs(true);
      editingInput = null;
      (event.currentTarget as HTMLInputElement).blur();
    }
  };

  const captureHandledPointer = (event: PointerEvent, handled: boolean): void => {
    if (!handled) {
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const beginHandle = (event: PointerEvent, handle: 'start' | 'end'): void => {
    const target = event.currentTarget as HTMLElement;
    const trackWidth = target.parentElement?.getBoundingClientRect().width ?? 0;
    captureHandledPointer(
      event,
      applyTransition({
        button: event.button,
        clientX: event.clientX,
        handle,
        interaction: 'selection-handle',
        pointerId: event.pointerId,
        trackWidth,
        type: 'pointerStart',
      }),
    );
  };

  const beginPan = (event: PointerEvent): void => {
    const target = event.currentTarget as HTMLElement;
    const trackWidth = target.parentElement?.getBoundingClientRect().width ?? 0;
    captureHandledPointer(
      event,
      applyTransition({
        button: event.button,
        clientX: event.clientX,
        interaction: 'selection-pan',
        pointerId: event.pointerId,
        trackWidth,
        type: 'pointerStart',
      }),
    );
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (applyTransition({ clientX: event.clientX, pointerId: event.pointerId, type: 'pointerMove' })) {
      event.preventDefault();
    }
  };

  const finishPointer = (event: PointerEvent): void => {
    const finishType = reportRangePointerFinishType(event.type);
    if (!applyTransition({ pointerId: event.pointerId, type: finishType })) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    if (finishType !== 'pointerCaptureLost' && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  // Only claim the key the state module actually consumed, so an unrelated key
  // still reaches the page and the surrounding region never sees a duplicate.
  const onHandleKeydown = (event: KeyboardEvent, edge: 'end' | 'start'): void => {
    if (
      !applyTransition({
        axis: 'selection',
        handle: edge,
        key: event.key,
        shiftKey: event.shiftKey,
        type: 'keyboardMove',
      })
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const changeDimension = (next: string): void => {
    if (!isFocusedTimelineDimension(next)) {
      return;
    }
    onOptionsChange({ dimension: next, granularity, value });
  };
  const changeGranularity = (next: string): void => {
    if (!(next === 'day' || next === 'week' || next === 'month')) {
      return;
    }
    onOptionsChange({ dimension, granularity: next, value });
  };
  const changeValue = (next: string): void => {
    if (!(next === 'cost' || next === 'sessions' || next === 'share')) {
      return;
    }
    onOptionsChange({ dimension, granularity, value: next });
  };
</script>

<section aria-label="Date range" class={panel}>
  <div>
    <h2 class={panelTitle}>Activity</h2>
    <p class={panelSub}>One report range controls every Overview chart</p>
  </div>
  <div class={presetRow}>
    {#each dateRangePresets as item (item.mode)}
      <button
        {...pressedAria(item.mode)}
        class={cx(preset, range.mode === item.mode ? selectedPreset : undefined)}
        onclick={() => selectPreset(item.mode)}
        type="button"
      >
        {item.label}
      </button>
    {/each}
  </div>
  <div class={summary} data-report-range-part="summary">
    <span>{projection.summary}</span>
    <span>Activity range follows report range</span>
  </div>
  <div class={summary}>
    <span>{chartSummary}</span>
    <span>{timeline?.grandSessions ?? 0} sessions</span>
  </div>
  <ActivityTimeline
    {activeSeriesKeys}
    {machineFreshnessStatus}
    {onDimensionFilter}
    {...(presentCampaignSeries ? { presentCampaignSeries } : {})}
    {...(presentMachineSeries ? { presentMachineSeries } : {})}
    {timeline}
    {value}
    {visibleRange}
  />
  <div class={fields} data-report-range-part="adjustments">
    <label class={field}
      >Start date
      <input
        aria-label="Start date"
        class={input}
        onblur={() => {
          if (editingInput !== 'start') {
            return;
          }
          finishInput('start');
          editingInput = null;
        }}
        onfocus={(event) => {
          cancelledInput = null;
          editingInput = 'start';
          const nextDraft = inputValueForRange(dateForHandle('start'));
          flushSync(() => {
            draftFrom = nextDraft;
          });
          event.currentTarget.select();
        }}
        oninput={(event) => {
          draftFrom = event.currentTarget.value;
          if (parseLocalDate(draftFrom)) {
            commitInputs(false);
          }
        }}
        onkeydown={(event) => commitInputKey(event, 'start')}
        type="text"
        value={draftFrom}
      >
    </label>
    <label class={field}
      >End date
      <input
        aria-label="End date"
        class={input}
        onblur={() => {
          if (editingInput !== 'end') {
            return;
          }
          finishInput('end');
          editingInput = null;
        }}
        onfocus={(event) => {
          cancelledInput = null;
          editingInput = 'end';
          const nextDraft = inputValueForRange(dateForHandle('end'));
          flushSync(() => {
            draftTo = nextDraft;
          });
          event.currentTarget.select();
        }}
        oninput={(event) => {
          draftTo = event.currentTarget.value;
          if (parseLocalDate(draftTo)) {
            commitInputs(false);
          }
        }}
        onkeydown={(event) => commitInputKey(event, 'end')}
        type="text"
        value={draftTo}
      >
    </label>
  </div>
  <div class={brush} data-report-range-part="brush">
    <span class={track}></span>
    <button
      aria-label="Selected report window"
      class={selection}
      data-dragging={controlState.interaction.type === 'selection-pan' ? 'true' : undefined}
      onlostpointercapture={finishPointer}
      onpointercancel={finishPointer}
      onpointerdown={beginPan}
      onpointermove={onPointerMove}
      onpointerup={finishPointer}
      tabindex={-1}
      title="Drag selected range"
      type="button"
      style:left={`${startPercent}%`}
      style:width={`${Math.max(0, endPercent - startPercent)}%`}
    ></button>
    {#each rangeHandles as { edge, label } (edge)}
      {@const index = selectionIndexFor(edge)}
      <button
        aria-label={label}
        aria-valuemax={projection.maxIndex}
        aria-valuemin={0}
        aria-valuenow={index}
        aria-valuetext={handleValueText(edge)}
        class={timeSliderThumb}
        onkeydown={(event) => onHandleKeydown(event, edge)}
        onlostpointercapture={finishPointer}
        onpointercancel={finishPointer}
        onpointerdown={(event) => beginHandle(event, edge)}
        onpointermove={onPointerMove}
        onpointerup={finishPointer}
        role="slider"
        type="button"
        style:left={`${percentFor(index)}%`}
      ></button>
    {/each}
  </div>
  <details aria-label="Chart options" class={timeChartOptions} data-report-range-part="chart-options">
    <summary class={timeChartOptionsSummary}>
      <span class={timeChartOptionsTitle}>Chart options</span>
      <span class={timeChartOptionsCurrent}>{chartSummary}</span>
    </summary>
    <div class={timeRangeViewControls}>
      <SegmentedControl
        ariaLabel="Group by"
        items={dimensionItems}
        label="Group by"
        onValueChange={changeDimension}
        value={dimension}
      />
      <SegmentedControl
        ariaLabel="Interval"
        items={granularityItems}
        label="Interval"
        onValueChange={changeGranularity}
        value={granularity}
      />
      <SegmentedControl ariaLabel="Metric" items={valueItems} label="Metric" onValueChange={changeValue} {value} />
    </div>
  </details>
</section>
