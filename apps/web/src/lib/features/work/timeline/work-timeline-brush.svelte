<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits numeric slider bounds and position from typed state; work-timeline.ssr.test.ts asserts the rendered values -->
<script lang="ts" module>
  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  /** A calendar key names a day, not an instant: noon UTC keeps it on that day whatever the zone. */
  const dayText = (key: string): string => {
    const day = new Date(`${key}T12:00:00Z`);
    // Formatting an invalid date throws; a key that is not a day is shown as it is instead.
    return Number.isNaN(day.getTime()) ? key : dayFormatter.format(day);
  };
</script>

<script lang="ts">
  import {
    monthGridline,
    timeSliderBrushColumn,
    timeSliderBrushTrack,
    timeSliderDimLeft,
    timeSliderDimRight,
    timeSliderRange,
    timeSliderRangeDrag,
    timeSliderThumb,
  } from '@ai-usage/design-system/svelte';
  import {
    createTimeRangeControlState,
    type TimeRangeControlEvent,
    type TimeRangeControlState,
    type TimeRangeHandle,
    type TimeRangeSelectionIndexes,
    transitionTimeRangeControl,
  } from '../../../foundation/time-range-control-state';
  import { brushAxisTicks, reportRangePointerFinishType } from '../../report/range/report-range-model';
  import {
    brushIndexesOfWindow,
    type TimelineWindow,
    type TimelineWindowIndexes,
    windowOfBrushIndexes,
  } from './work-timeline-model';

  interface Props {
    /** Every day the window can reach, oldest first. */
    domain: readonly string[];
    /** Called once per gesture: on pointer end and on each keyboard move. */
    onChange: (window: TimelineWindow) => void;
    /** Sessions started per domain day, drawn faintly behind the selection. */
    overview: readonly number[];
    selection: TimelineWindowIndexes;
  }

  let { domain, onChange, overview, selection }: Props = $props();

  // The control state machine also carries chart options; this brush never emits option
  // transitions, so the stored values are inert.
  const inertOptions = { dimension: 'harness', granularity: 'day', value: 'cost' } as const;
  const committedControlState = (): TimeRangeControlState =>
    createTimeRangeControlState({
      context: { selectionMaxIndex: domain.length },
      options: inertOptions,
      selectionIndexes: brushIndexesOfWindow(selection),
    });
  const committedKey = (): string => `${domain[0]}:${domain.length}:${selection.fromIndex}:${selection.toIndex}`;
  let controlState = $state<TimeRangeControlState>(committedControlState());
  let synchronizedKey = committedKey();
  // A drag keeps its own selection; the committed window takes over again once the gesture ended.
  $effect(() => {
    const key = committedKey();
    if (key === synchronizedKey || controlState.interaction.type !== 'idle') {
      return;
    }
    controlState = committedControlState();
    synchronizedKey = key;
  });

  // Dragging pins the domain so a refreshed read cannot move the index origin under the pointer.
  let pinnedDomain = $state<readonly string[] | null>(null);
  let axisWidth = $state<number | undefined>();
  const activeDomain = $derived(pinnedDomain ?? domain);
  const maxIndex = $derived(activeDomain.length);
  const domainFirst = $derived.by(() => {
    const [year = 1970, month = 1, day = 1] = (activeDomain[0] ?? '').split('-').map(Number);
    return new Date(year, month - 1, day);
  });
  const ticks = $derived(
    brushAxisTicks(domainFirst, maxIndex, axisWidth ? Math.max(2, Math.floor(axisWidth / 44)) : undefined),
  );
  const percentFor = (index: number): number => (maxIndex > 0 ? (index / maxIndex) * 100 : 0);
  const startPercent = $derived(percentFor(controlState.selectionIndexes[0]));
  const endPercent = $derived(percentFor(controlState.selectionIndexes[1]));
  const selected = $derived(windowOfBrushIndexes(activeDomain, controlState.selectionIndexes));
  const overviewMax = $derived(Math.max(1, ...overview));
  const rangeHandles = [
    { edge: 'start', label: 'Window start' },
    { edge: 'end', label: 'Window end' },
  ] as const satisfies readonly { edge: TimeRangeHandle; label: string }[];
  const selectionIndexFor = (edge: TimeRangeHandle): number =>
    edge === 'start' ? controlState.selectionIndexes[0] : controlState.selectionIndexes[1];

  // The handles sit on day boundaries, so two handles on one boundary would select no day at all:
  // the moving handle stops one boundary short of the other and the selection stays one day wide.
  const atLeastOneDay = (
    indexes: TimeRangeSelectionIndexes,
    moving: TimeRangeHandle | null,
    maximum: number,
  ): TimeRangeSelectionIndexes => {
    if (indexes[0] !== indexes[1] || maximum < 1) {
      return indexes;
    }
    if (moving === 'start') {
      const end = Math.max(1, indexes[1]);
      return [end - 1, end];
    }
    const start = Math.min(maximum - 1, indexes[0]);
    return [start, start + 1];
  };

  const movingHandle = (event: TimeRangeControlEvent): TimeRangeHandle | null => {
    if (event.type === 'keyboardMove') {
      return event.handle;
    }
    return controlState.interaction.type === 'selection-handle' ? controlState.interaction.handle : null;
  };

  const applyTransition = (event: TimeRangeControlEvent): boolean => {
    const basis = pinnedDomain ?? domain;
    const moving = movingHandle(event);
    const transition = transitionTimeRangeControl(controlState, event, { selectionMaxIndex: basis.length });
    if (!transition.handled) {
      return false;
    }
    controlState = {
      ...transition.state,
      selectionIndexes: atLeastOneDay(transition.state.selectionIndexes, moving, basis.length),
    };
    pinnedDomain = controlState.interaction.type === 'idle' ? null : basis;
    if (transition.commands.some((command) => command.type === 'commitReportRange')) {
      const next = windowOfBrushIndexes(basis, controlState.selectionIndexes);
      if (next.from !== domain[selection.fromIndex] || next.to !== domain[selection.toIndex]) {
        onChange(next);
      }
    }
    return true;
  };

  const elementOf = (event: Event): HTMLElement | null =>
    event.currentTarget instanceof HTMLElement ? event.currentTarget : null;

  const beginPointer = (event: PointerEvent, handle: TimeRangeHandle | null): void => {
    const target = elementOf(event);
    const pointer = {
      button: event.button,
      clientX: event.clientX,
      pointerId: event.pointerId,
      trackWidth: target?.parentElement?.getBoundingClientRect().width ?? 0,
      type: 'pointerStart',
    } as const;
    const handled = applyTransition(
      handle === null
        ? { ...pointer, interaction: 'selection-pan' }
        : { ...pointer, handle, interaction: 'selection-handle' },
    );
    if (!(handled && target)) {
      return;
    }
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
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
    const target = elementOf(event);
    if (finishType !== 'pointerCaptureLost' && target?.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const onHandleKeydown = (event: KeyboardEvent, edge: TimeRangeHandle): void => {
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
</script>

<div class={`${timeSliderBrushColumn} wtl-brush`}>
  <div
    class={timeSliderBrushTrack}
    style:--slider-range-end={`${100 - endPercent}%`}
    style:--slider-range-start={`${startPercent}%`}
  >
    <div aria-hidden="true" class="wtl-brush-overview">
      {#each overview as count, index}
        {#if count > 0}
          <span
            style:height={`${(count / overviewMax) * 100}%`}
            style:left={`${percentFor(index)}%`}
            style:width={`${percentFor(1)}%`}
          ></span>
        {/if}
      {/each}
    </div>
    {#each ticks as tick (tick.index)}
      <span aria-hidden="true" class={monthGridline} style:left={`${tick.pct}%`}></span>
    {/each}
    <div aria-hidden="true" class={timeSliderRange}></div>
    <div aria-hidden="true" class={timeSliderDimLeft}></div>
    <div aria-hidden="true" class={timeSliderDimRight}></div>
    <button
      aria-label="Selected time window"
      class={timeSliderRangeDrag}
      data-dragging={controlState.interaction.type === 'selection-pan' ? 'true' : undefined}
      onlostpointercapture={finishPointer}
      onpointercancel={finishPointer}
      onpointerdown={(event) => beginPointer(event, null)}
      onpointermove={onPointerMove}
      onpointerup={finishPointer}
      tabindex={-1}
      title="Drag the selected window"
      type="button"
    ></button>
    {#each rangeHandles as { edge, label } (edge)}
      {@const index = selectionIndexFor(edge)}
      <button
        aria-label={label}
        aria-valuemax={maxIndex}
        aria-valuemin={0}
        aria-valuenow={index}
        aria-valuetext={dayText(edge === 'start' ? selected.from : selected.to)}
        class={timeSliderThumb}
        onkeydown={(event) => onHandleKeydown(event, edge)}
        onlostpointercapture={finishPointer}
        onpointercancel={finishPointer}
        onpointerdown={(event) => beginPointer(event, edge)}
        onpointermove={onPointerMove}
        onpointerup={finishPointer}
        role="slider"
        type="button"
        style:left={`${percentFor(index)}%`}
      ></button>
    {/each}
  </div>
  <div aria-hidden="true" class="wtl-brush-axis" bind:clientWidth={axisWidth}>
    {#each ticks as tick (tick.index)}
      <span style:left={`${tick.pct}%`}>{tick.label}</span>
    {/each}
  </div>
</div>
