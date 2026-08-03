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
  const handle = css({
    position: 'absolute',
    top: '7px',
    w: '22px',
    h: '22px',
    border: '2px solid token(colors.accent)',
    borderRadius: 'full',
    bg: 'surface',
    transform: 'translateX(-50%)',
  });
  const details = css({ borderTop: '1px solid token(colors.line)', pt: '10px' });
  const detailsSummary = css({ color: 'muted', cursor: 'pointer', fontSize: '12px' });
  const optionGrid = css({ display: 'grid', gap: '12px', mt: '12px' });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { panel, panelSub, panelTitle, SegmentedControl } from '@ai-usage/design-system/svelte';
  import {
    type FocusedDateDomain,
    type FocusedTimelineData,
    type FocusedTimelineSeries,
    focusedTimelineDimensionDefinitions,
    focusedTimelineDimensionLabel,
    isFocusedTimelineDimension,
  } from '@ai-usage/report-core/focused-report-query';
  import type { DashboardDateRangeSearch, DashboardSearch } from '../../../../dashboard-search';
  import { dateFromIndex, dateRangePresets, parseLocalDate } from '../../../../date-range';
  import type { MigrationGranularity, TimelineDimension, TimelineValue } from '../../../../overview-model';
  import {
    createTimeRangeControlState,
    type TimeRangeControlState,
    type TimeRangeSelectionIndexes,
    transitionTimeRangeControl,
  } from '../../../../time-range-control-state';
  import type { SearchNavigationIntent } from '../../../foundation/navigation/search-intent';
  import { createSearchEditRun } from '../../../foundation/navigation/svelte/dashboard-url';
  import ActivityTimeline from '../overview/activity-timeline.svelte';
  import type { MachineSeriesPresenter } from '../overview/timeline-model';
  import {
    customRangeFromIndexes,
    customRangeFromInputs,
    escapedRangeDraft,
    inputValueForRange,
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
  const editRun = createSearchEditRun();
  const currentRangeKey = (): string => JSON.stringify(range);
  const initialRangeKey = (): string => currentRangeKey();
  let synchronizedRangeKey = $state(initialRangeKey());
  const dateForHandle = (handle: 'start' | 'end'): Date =>
    dateFromIndex(
      projection.domainFirst,
      handle === 'start' ? controlState.selectionIndexes[0] : controlState.selectionIndexes[1],
    );
  const normalizedDraft = (draft: string, display: string, handle: 'start' | 'end'): string =>
    draft === display ? inputValueForRange(dateForHandle(handle)) : draft;

  $effect(() => {
    const key = currentRangeKey();
    if (key === synchronizedRangeKey || controlState.interaction.type !== 'idle') {
      return;
    }
    controlState = createTimeRangeControlState({
      context: { selectionMaxIndex: projection.maxIndex },
      options: { dimension, granularity, value },
      selectionIndexes: projection.selectionIndexes,
    });
    draftFrom = projection.displayFrom;
    draftTo = projection.displayTo;
    synchronizedRangeKey = key;
  });

  const percentFor = (index: number): number => (projection.maxIndex > 0 ? (index / projection.maxIndex) * 100 : 0);
  const startPercent = $derived(percentFor(controlState.selectionIndexes[0]));
  const endPercent = $derived(percentFor(controlState.selectionIndexes[1]));
  const dimensionItems = focusedTimelineDimensionDefinitions;
  const rangeHandles = ['start', 'end'] as const;
  const pressedAria = (mode: DashboardDateRangeSearch['mode']) => ({ 'aria-pressed': range.mode === mode });
  const sliderAria = (index: number) => ({
    'aria-valuemax': projection.maxIndex,
    'aria-valuemin': 0,
    'aria-valuenow': index,
  });
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

  const commitRange = (next: DashboardDateRangeSearch, replace = false): void => {
    if (navigate) {
      navigate((current) => ({ ...current, range: next }), { replace, resetScroll: false });
      return;
    }
    onRangeChange(next);
  };

  const synchronizeInputs = (indexes: TimeRangeSelectionIndexes): void => {
    const next = customRangeFromIndexes(projection, indexes);
    const nextProjection = reportRangeProjection(next, generatedDate, dateDomain);
    draftFrom = nextProjection.displayFrom;
    draftTo = nextProjection.displayTo;
    commitRange(next, editRun.next().replace);
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
  };

  const commitInputs = (settle: boolean): void => {
    const next = customRangeFromInputs(
      normalizedDraft(draftFrom, projection.displayFrom, 'start'),
      normalizedDraft(draftTo, projection.displayTo, 'end'),
    );
    if (!next) {
      return;
    }
    commitRange(next, editRun.next().replace);
    if (settle) {
      const nextProjection = reportRangeProjection(next, generatedDate, dateDomain);
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
      commitInputs(true);
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

  const onHandleKeydown = (event: KeyboardEvent, handle: 'start' | 'end'): void => {
    applyTransition({ axis: 'selection', handle, key: event.key, shiftKey: event.shiftKey, type: 'keyboardMove' });
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
    }
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
  <div class={summary} data-report-range-part="total-legend">
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
  />
  <div class={fields} data-report-range-part="adjustments">
    <label class={field}
      >Start date
      <input
        aria-label="Start date"
        class={input}
        onblur={() => finishInput('start')}
        onfocus={() => { cancelledInput = null; draftFrom = inputValueForRange(dateForHandle('start')); }}
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
        onblur={() => finishInput('end')}
        onfocus={() => { cancelledInput = null; draftTo = inputValueForRange(dateForHandle('end')); }}
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
      type="button"
      style:left={`${startPercent}%`}
      style:width={`${Math.max(0, endPercent - startPercent)}%`}
    ></button>
    {#each rangeHandles as handle (handle)}
      {@const index = handle === 'start' ? controlState.selectionIndexes[0] : controlState.selectionIndexes[1]}
      <input
        aria-label={handle === 'start' ? 'Start date' : 'End date'}
        {...sliderAria(index)}
        class={handle}
        max={projection.maxIndex}
        min={0}
        onkeydown={(event) => onHandleKeydown(event, handle)}
        onlostpointercapture={finishPointer}
        onpointercancel={finishPointer}
        onpointerdown={(event) => beginHandle(event, handle)}
        onpointermove={onPointerMove}
        onpointerup={finishPointer}
        type="range"
        value={index}
        style:left={`${percentFor(index)}%`}
      >
    {/each}
  </div>
  <details aria-label="Chart options" class={details} data-report-range-part="chart-options">
    <summary class={detailsSummary}>{chartSummary}</summary>
    <div class={optionGrid}>
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
