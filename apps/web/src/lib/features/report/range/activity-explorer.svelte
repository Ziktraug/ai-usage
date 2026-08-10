<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits numeric slider bounds and position from typed state; time-range.spec.ts asserts the rendered values -->
<script lang="ts" module>
  import { css } from '@ai-usage/design-system/css';

  const heading = css({ display: 'grid', gap: '3px' });
  const summaryRow = css({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: '8px',
    color: 'muted',
    fontSize: '12px',
  });
  const explorerContent = css({ display: 'grid', gap: '12px', pt: '12px' });
  const activityPanel = css({ display: 'grid', gap: '12px', p: { base: '14px', md: '18px' } });
  const executiveMetricGroup = css({ border: 0, m: 0, minW: 0, p: 0 });
  const executiveMetricButton = css({ minH: '44px' });
</script>

<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { containedInteractive } from '@ai-usage/design-system/report';
  import {
    panelSub,
    panelTitle,
    presetButton,
    presetGroup,
    SegmentedControl,
    timeChartOptions,
    timeChartOptionsCurrent,
    timeChartOptionsSummary,
    timeChartOptionsTitle,
    timeRangeViewControls,
    timeSliderBrushColumn,
    timeSliderBrushTrack,
    timeSliderDimLeft,
    timeSliderDimRight,
    timeSliderRange,
    timeSliderRangeDrag,
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
  import { untrack } from 'svelte';
  import type { DashboardDateRangeSearch, DashboardSearch } from '../../../../dashboard-search';
  import { dateFromIndex } from '../../../../date-range';
  import type {
    MigrationGranularity,
    ResolvedTimelineMetric,
    TimelineDimension,
    TimelineValue,
  } from '../../../../overview-model';
  import {
    createTimeRangeControlState,
    type TimeRangeControlState,
    type TimeRangeSelectionIndexes,
    transitionTimeRangeControl,
  } from '../../../../time-range-control-state';
  import type { SearchNavigationIntent, SearchNavigationOptions } from '../../../foundation/navigation/search-intent';
  import { createSearchEditRun } from '../../../foundation/navigation/svelte/dashboard-url';
  import { fmtDateOnly, fmtNum, fmtPct } from '../../../foundation/presentation/format';
  import ActivityTimeline from '../overview/activity-timeline.svelte';
  import {
    executiveTimelineValue,
    type MachineSeriesPresenter,
    presentTimelineValue,
    resolveTimelineMetric,
  } from '../overview/timeline-model';
  import { timelineRangeForSelection, visibleTimelineSummary } from '../overview/timeline-window';
  import {
    customRangeFromIndexes,
    type ReportRangeProjection,
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
    navigate?: SearchNavigationIntent<DashboardSearch>;
    onDimensionFilter?: (dimension: TimelineDimension, key: string) => void;
    onOptionsChange?: (options: {
      dimension: TimelineDimension;
      granularity: MigrationGranularity;
      value: TimelineValue;
    }) => void;
    onRangeChange?: (range: DashboardDateRangeSearch) => void;
    /** Estimated API-equivalent value of the window being dragged, or null once the committed result arrives. */
    onWindowPreview?: (apiValue: number | null) => void;
    presentCampaignSeries?: (series: FocusedTimelineSeries) => FocusedTimelineSeries;
    presentMachineSeries?: MachineSeriesPresenter;
    range: DashboardDateRangeSearch;
    revision: string;
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
    onWindowPreview = () => undefined,
    presentCampaignSeries,
    presentMachineSeries,
    range,
    revision,
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
  let controlState = $state<TimeRangeControlState>(initialControlState());
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
  const initialRevision = (): string => revision;
  let synchronizedControlKey = $state(initialControlKey());
  let synchronizedRevision = $state(initialRevision());
  let previewAwaitsCommit = false;

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
    editRun.synchronize(reportRangeEditKey(range));
    synchronizedControlKey = key;
  });

  $effect(() => {
    if (revision === synchronizedRevision) {
      return;
    }
    synchronizedRevision = revision;
    previewAwaitsCommit = false;
    onWindowPreview(null);
  });

  let pinnedProjection = $state<ReportRangeProjection | null>(null);
  const activeProjection = $derived(pinnedProjection ?? projection);
  const selectionIndexFor = (edge: 'end' | 'start'): number =>
    edge === 'start' ? controlState.selectionIndexes[0] : controlState.selectionIndexes[1];
  const dateForHandle = (edge: 'end' | 'start'): Date =>
    dateFromIndex(activeProjection.domainFirst, selectionIndexFor(edge));
  const percentFor = (index: number): number =>
    activeProjection.maxIndex > 0 ? (index / activeProjection.maxIndex) * 100 : 0;
  const startPercent = $derived(percentFor(controlState.selectionIndexes[0]));
  const endPercent = $derived(percentFor(controlState.selectionIndexes[1]));
  const visibleRange = $derived(
    timeline
      ? timelineRangeForSelection(timeline.buckets, activeProjection.domainFirst, controlState.selectionIndexes)
      : null,
  );
  const draggedWindowApiValue = $derived(
    timeline && visibleRange && controlState.interaction.type !== 'idle'
      ? visibleTimelineSummary(timeline, visibleRange, 'cost').total
      : null,
  );

  $effect(() => {
    const apiValue = draggedWindowApiValue;
    if (apiValue === null && previewAwaitsCommit) {
      return;
    }
    onWindowPreview(apiValue);
  });

  const dimensionItems = focusedTimelineDimensionDefinitions;
  const rangeHandles = [
    { edge: 'start', label: 'Start date' },
    { edge: 'end', label: 'End date' },
  ] as const satisfies readonly { edge: 'end' | 'start'; label: string }[];
  const handleValueText = (edge: 'end' | 'start'): string => fmtDateOnly(dateForHandle(edge));
  const granularityItems = [
    { label: 'Day', value: 'day' },
    { label: 'Week', value: 'week' },
    { label: 'Month', value: 'month' },
  ] as const;
  const valueItems = [
    { label: 'Estimated API-equivalent value', value: 'cost' },
    { label: 'Tokens', value: 'tokens' },
    { label: 'Sessions', value: 'sessions' },
    { label: 'Share', value: 'share' },
  ] as const;
  const executiveValueItems = [
    { label: 'API value', value: 'cost' },
    { label: 'Tokens', value: 'tokens' },
  ] as const;
  const valueLabels: Record<TimelineValue, string> = {
    cost: 'Estimated API-equivalent value',
    sessions: 'Sessions',
    share: 'Share',
    tokens: 'Tokens',
  };
  const executiveValue = $derived(executiveTimelineValue(value));
  const resolvedMetric = $derived<ResolvedTimelineMetric>(resolveTimelineMetric(timeline, value));
  const selectedWindowSummary = $derived(
    timeline && visibleRange ? visibleTimelineSummary(timeline, visibleRange, resolvedMetric) : null,
  );
  const selectedMetricSummary = $derived.by(() => {
    const total = selectedWindowSummary?.total ?? 0;
    if (value === 'share') {
      return { label: `${fmtPct(total > 0 ? 100 : 0)} of selected activity`, title: null };
    }
    if (resolvedMetric === 'cost') {
      const presentation = presentTimelineValue(
        total,
        total,
        value,
        resolvedMetric,
        selectedWindowSummary?.priceMeasurement ?? {
          knownCost: 0,
          state: 'zero',
          unpricedFreshTokens: 0,
        },
      );
      return {
        label: `${presentation.label} API value${presentation.provenance ? ` · ${presentation.provenance.label}` : ''}`,
        title: presentation.provenance?.description ?? presentation.title,
      };
    }
    return { label: `${fmtNum(total)} ${resolvedMetric}`, title: null };
  });
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

  let uncommittedPointerRange: DashboardDateRangeSearch | undefined;

  const commitSelection = (next: DashboardDateRangeSearch): boolean => {
    const options = editRun.next(reportRangeEditKey(next));
    if (!options) {
      return false;
    }
    commitRange(next, options);
    return true;
  };

  const synchronizeSelection = (
    indexes: TimeRangeSelectionIndexes,
    basis: ReportRangeProjection,
    dragging: boolean,
  ): void => {
    const next = customRangeFromIndexes(basis, indexes);
    if (dragging) {
      uncommittedPointerRange = next;
      return;
    }
    commitSelection(next);
  };

  const applyTransition = (event: Parameters<typeof transitionTimeRangeControl>[1]): boolean => {
    const basis = pinnedProjection ?? projection;
    const transition = transitionTimeRangeControl(controlState, event, { selectionMaxIndex: basis.maxIndex });
    if (!transition.handled) {
      return false;
    }
    controlState = transition.state;
    pinnedProjection = controlState.interaction.type === 'idle' ? null : basis;
    const dragging = controlState.interaction.type !== 'idle';
    for (const command of transition.commands) {
      if (command.type === 'setSelectionIndexes') {
        synchronizeSelection(command.indexes, basis, dragging);
      } else {
        previewAwaitsCommit = uncommittedPointerRange !== undefined && commitSelection(uncommittedPointerRange);
        uncommittedPointerRange = undefined;
        editRun.commit();
      }
    }
    return true;
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
    if (isFocusedTimelineDimension(next)) {
      onOptionsChange({ dimension: next, granularity, value });
    }
  };
  const changeGranularity = (next: string): void => {
    if (next === 'day' || next === 'week' || next === 'month') {
      onOptionsChange({ dimension, granularity: next, value });
    }
  };
  const changeValue = (next: string): void => {
    if (next === 'cost' || next === 'sessions' || next === 'share' || next === 'tokens') {
      onOptionsChange({ dimension, granularity, value: next });
    }
  };
</script>

<section
  aria-labelledby="activity-title"
  class={cx(containedInteractive, activityPanel)}
  data-activity-explorer
  data-executive-chart
>
  <div class={heading}>
    <h3 class={panelTitle} id="activity-title">Activity</h3>
    <p class={panelSub}>Daily evidence for the selected report period</p>
  </div>
  <div class={summaryRow}>
    <span>{chartSummary}</span>
    <span title={selectedMetricSummary.title ?? undefined}>{selectedMetricSummary.label}</span>
  </div>
  <fieldset aria-label="Activity metric" class={cx(presetGroup, executiveMetricGroup)}>
    {#each executiveValueItems as item (item.value)}
      <button
        aria-pressed={executiveValue === item.value}
        class={cx(presetButton, executiveMetricButton)}
        data-active={executiveValue === item.value ? 'true' : 'false'}
        onclick={() => changeValue(item.value)}
        type="button"
      >
        {item.label}
      </button>
    {/each}
  </fieldset>
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
  <details aria-label="Explore activity" class={timeChartOptions} data-report-range-part="activity-explorer">
    <summary class={timeChartOptionsSummary}>
      <span class={timeChartOptionsTitle}>Explore activity</span>
      <!-- The current dimension/interval/metric already reads above the chart; repeating it here
           would spend the disclosure label on something the reader can see. Name what is inside. -->
      <span class={timeChartOptionsCurrent}>Grouping, interval, metric, exact dates</span>
    </summary>
    <div class={explorerContent}>
      <div class={summaryRow}>
        <span>Exact report window</span>
        <span>{projection.summary}</span>
      </div>
      <div class={timeSliderBrushColumn} data-report-range-part="brush">
        <div
          class={timeSliderBrushTrack}
          style:--slider-range-end={`${100 - endPercent}%`}
          style:--slider-range-start={`${startPercent}%`}
        >
          <div aria-hidden="true" class={timeSliderRange}></div>
          <div aria-hidden="true" class={timeSliderDimLeft}></div>
          <div aria-hidden="true" class={timeSliderDimRight}></div>
          <button
            aria-label="Selected report window"
            class={timeSliderRangeDrag}
            data-dragging={controlState.interaction.type === 'selection-pan' ? 'true' : undefined}
            onlostpointercapture={finishPointer}
            onpointercancel={finishPointer}
            onpointerdown={beginPan}
            onpointermove={onPointerMove}
            onpointerup={finishPointer}
            tabindex={-1}
            title="Drag selected range"
            type="button"
          ></button>
          {#each rangeHandles as { edge, label: handleLabel } (edge)}
            {@const index = selectionIndexFor(edge)}
            <button
              aria-label={handleLabel}
              aria-valuemax={activeProjection.maxIndex}
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
      </div>
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
    </div>
  </details>
</section>
