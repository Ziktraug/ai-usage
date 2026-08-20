<!-- biome-ignore-all lint/a11y/useValidAriaValues: Svelte emits numeric slider bounds and position from typed state; time-range.spec.ts asserts the rendered values -->
<script lang="ts">
  import {
    timeSliderBrushColumn,
    timeSliderBrushTrack,
    timeSliderDimLeft,
    timeSliderDimRight,
    timeSliderRange,
    timeSliderRangeDrag,
    timeSliderThumb,
  } from '@ai-usage/design-system/svelte';
  import type { FocusedDateDomain } from '@ai-usage/report-core/focused-report-query';
  import { untrack } from 'svelte';
  import type { DashboardDateRangeSearch, DashboardSearch } from '../../../../dashboard-search';
  import { dateFromIndex } from '../../../../date-range';
  import {
    createTimeRangeControlState,
    type TimeRangeControlState,
    type TimeRangeSelectionIndexes,
    transitionTimeRangeControl,
  } from '../../../../time-range-control-state';
  import type { SearchNavigationIntent, SearchNavigationOptions } from '../../../foundation/navigation/search-intent';
  import { createSearchEditRun } from '../../../foundation/navigation/svelte/dashboard-url';
  import { fmtDateOnly } from '../../../foundation/presentation/format';
  import {
    customRangeFromIndexes,
    type ReportRangeProjection,
    reportRangeEditKey,
    reportRangePointerFinishType,
    reportRangeProjection,
  } from './report-range-model';

  interface Props {
    dateDomain: FocusedDateDomain | null;
    generatedAt: string;
    navigate?: SearchNavigationIntent<DashboardSearch>;
    onRangeChange?: (range: DashboardDateRangeSearch) => void;
    range: DashboardDateRangeSearch;
  }

  let { dateDomain, generatedAt, navigate, onRangeChange = () => undefined, range }: Props = $props();

  const generatedDate = $derived(new Date(generatedAt));
  const projection = $derived(reportRangeProjection(range, generatedDate, dateDomain));
  // The control state machine also carries chart options; this brush never emits option
  // transitions, so the stored values are inert.
  const inertOptions = { dimension: 'harness', granularity: 'day', value: 'cost' } as const;
  const initialControlState = (): TimeRangeControlState =>
    createTimeRangeControlState({
      context: { selectionMaxIndex: projection.maxIndex },
      options: inertOptions,
      selectionIndexes: projection.selectionIndexes,
    });
  let controlState = $state<TimeRangeControlState>(initialControlState());
  const editRun = createSearchEditRun(untrack(() => reportRangeEditKey(range)));
  const currentControlKey = (): string =>
    JSON.stringify({
      maximumIndex: projection.maxIndex,
      range,
      selectionIndexes: projection.selectionIndexes,
    });
  const initialControlKey = (): string => currentControlKey();
  let synchronizedControlKey = $state(initialControlKey());

  $effect(() => {
    const key = currentControlKey();
    if (key === synchronizedControlKey || controlState.interaction.type !== 'idle') {
      return;
    }
    controlState = createTimeRangeControlState({
      context: { selectionMaxIndex: projection.maxIndex },
      options: inertOptions,
      selectionIndexes: projection.selectionIndexes,
    });
    editRun.synchronize(reportRangeEditKey(range));
    synchronizedControlKey = key;
  });

  // Dragging pins the projection so the index origin — and with it the scale — cannot move
  // underneath the pointer when the committed range starts before the data.
  let pinnedProjection = $state<ReportRangeProjection | null>(null);
  const activeProjection = $derived(pinnedProjection ?? projection);
  const selectionIndexFor = (edge: 'end' | 'start'): number =>
    edge === 'start' ? controlState.selectionIndexes[0] : controlState.selectionIndexes[1];
  const percentFor = (index: number): number =>
    activeProjection.maxIndex > 0 ? (index / activeProjection.maxIndex) * 100 : 0;
  const startPercent = $derived(percentFor(controlState.selectionIndexes[0]));
  const endPercent = $derived(percentFor(controlState.selectionIndexes[1]));
  const rangeHandles = [
    { edge: 'start', label: 'Start date' },
    { edge: 'end', label: 'End date' },
  ] as const satisfies readonly { edge: 'end' | 'start'; label: string }[];
  const handleValueText = (edge: 'end' | 'start'): string =>
    fmtDateOnly(dateFromIndex(activeProjection.domainFirst, selectionIndexFor(edge)));

  const commitRange = (next: DashboardDateRangeSearch, options: SearchNavigationOptions): void => {
    if (navigate) {
      navigate((current) => ({ ...current, range: next }), { ...options, resetScroll: false });
      return;
    }
    onRangeChange(next);
  };

  const commitSelection = (next: DashboardDateRangeSearch): void => {
    const options = editRun.next(reportRangeEditKey(next));
    if (!options) {
      return;
    }
    commitRange(next, options);
  };

  let uncommittedPointerRange: DashboardDateRangeSearch | undefined;

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
        if (uncommittedPointerRange !== undefined) {
          commitSelection(uncommittedPointerRange);
          uncommittedPointerRange = undefined;
        }
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
</script>

<div class={timeSliderBrushColumn} data-report-range-part="period-brush">
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
