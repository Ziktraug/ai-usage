import type { MigrationGranularity, TimelineDimension, TimelineValue } from './overview-model';

export type TimeRangeHandle = 'start' | 'end';
export type TimeRangeIndexRange = Readonly<{ from: number; to: number }>;
export type TimeRangeSelectionIndexes = readonly [number, number];

export interface TimeRangeControlContext {
  selectionMaxIndex: number;
  visualBucketMaxIndex: number;
}

export interface TimeRangeControlOptions {
  dimension: TimelineDimension;
  granularity: MigrationGranularity;
  value: TimelineValue;
}

interface IdleInteraction {
  type: 'idle';
}

interface SelectionPanInteraction {
  pointerId: number;
  selectionMaxIndex: number;
  startClientX: number;
  startIndexes: TimeRangeSelectionIndexes;
  trackWidth: number;
  type: 'selection-pan';
}

interface SelectionHandleInteraction {
  handle: TimeRangeHandle;
  pointerId: number;
  selectionMaxIndex: number;
  startClientX: number;
  startIndex: number;
  trackWidth: number;
  type: 'selection-handle';
}

interface ViewPanInteraction {
  pointerId: number;
  scaleBucketCount: number;
  startClientX: number;
  startRange: TimeRangeIndexRange;
  trackWidth: number;
  type: 'view-pan';
  visualBucketMaxIndex: number;
}

interface ViewHandleInteraction {
  handle: TimeRangeHandle;
  pointerId: number;
  startClientX: number;
  startIndex: number;
  trackWidth: number;
  type: 'view-handle';
  visualBucketMaxIndex: number;
}

export type TimeRangeControlInteraction =
  | IdleInteraction
  | SelectionPanInteraction
  | SelectionHandleInteraction
  | ViewPanInteraction
  | ViewHandleInteraction;

export interface TimeRangeControlState {
  hover: Readonly<{ bucketIndex: number | null; key: string | null }>;
  interaction: TimeRangeControlInteraction;
  options: TimeRangeControlOptions;
  selectionIndexes: TimeRangeSelectionIndexes;
  viewControlsOpen: boolean;
  /** `null` is the full visual bucket domain, including after that domain grows. */
  visualRange: TimeRangeIndexRange | null;
}

type OptionChangedEvent =
  | { option: 'dimension'; type: 'optionChanged'; value: TimelineDimension }
  | {
      option: 'granularity';
      selectionIndexesFromDates: TimeRangeSelectionIndexes;
      type: 'optionChanged';
      value: MigrationGranularity;
    }
  | { option: 'value'; type: 'optionChanged'; value: TimelineValue };

type PointerStartEvent =
  | {
      button: number;
      clientX: number;
      interaction: 'selection-pan';
      pointerId: number;
      trackWidth: number;
      type: 'pointerStart';
    }
  | {
      button: number;
      clientX: number;
      handle: TimeRangeHandle;
      interaction: 'selection-handle';
      pointerId: number;
      trackWidth: number;
      type: 'pointerStart';
    }
  | {
      button: number;
      clientX: number;
      interaction: 'view-pan';
      pointerId: number;
      scaleBucketCount: number;
      trackWidth: number;
      type: 'pointerStart';
    }
  | {
      button: number;
      clientX: number;
      handle: TimeRangeHandle;
      interaction: 'view-handle';
      pointerId: number;
      trackWidth: number;
      type: 'pointerStart';
    };

export type TimeRangeControlEvent =
  | OptionChangedEvent
  | PointerStartEvent
  | {
      dimension: TimelineDimension;
      granularity: MigrationGranularity;
      type: 'optionsSynchronized';
    }
  | {
      selectionIndexesFromDates: TimeRangeSelectionIndexes;
      type: 'domainChanged';
    }
  | {
      selectionIndexes: TimeRangeSelectionIndexes;
      source: 'external' | 'input' | 'preset';
      type: 'selectionSynchronized';
    }
  | {
      axis: 'selection' | 'visual';
      handle: TimeRangeHandle;
      key: string;
      shiftKey: boolean;
      type: 'keyboardMove';
    }
  | { clientX: number; pointerId: number; type: 'pointerMove' }
  | { pointerId: number; type: 'pointerEnd' | 'pointerCancel' | 'pointerCaptureLost' }
  | { anchorRatio?: number; factor: number; type: 'zoom' }
  | { destination: 'end' | 'start'; type: 'pan' }
  | { range: TimeRangeIndexRange; type: 'setVisualRange' }
  | { type: 'resetVisualRange' }
  | { open: boolean; type: 'viewControlsChanged' }
  | { bucketIndex: number | null; key: string | null; type: 'hoverChanged' }
  | { type: 'clearHover' };

export type TimeRangeControlCommand =
  | { indexes: TimeRangeSelectionIndexes; type: 'setSelectionIndexes' }
  | { type: 'commitReportRange' }
  | { type: 'clearHover' };

export interface TimeRangeControlTransition {
  commands: readonly TimeRangeControlCommand[];
  handled: boolean;
  state: TimeRangeControlState;
}

const IDLE_INTERACTION = { type: 'idle' } as const;
const EMPTY_HOVER = { bucketIndex: null, key: null } as const;
const PAGE_KEY_STEP = 30;

const boundedMaximum = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

const clampIndex = (value: number, maximum: number): number =>
  Math.min(boundedMaximum(maximum), Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));

const normalizeSelectionIndexes = (
  indexes: TimeRangeSelectionIndexes,
  selectionMaxIndex: number,
): TimeRangeSelectionIndexes => {
  const first = clampIndex(indexes[0], selectionMaxIndex);
  const second = clampIndex(indexes[1], selectionMaxIndex);
  return first <= second ? [first, second] : [second, first];
};

const normalizeVisualRange = (range: TimeRangeIndexRange, visualBucketMaxIndex: number): TimeRangeIndexRange => {
  const first = clampIndex(range.from, visualBucketMaxIndex);
  const second = clampIndex(range.to, visualBucketMaxIndex);
  return first <= second ? { from: first, to: second } : { from: second, to: first };
};

const rangeSize = (range: TimeRangeIndexRange): number => range.to - range.from + 1;

const storedVisualRange = (range: TimeRangeIndexRange, visualBucketMaxIndex: number): TimeRangeIndexRange | null => {
  const normalized = normalizeVisualRange(range, visualBucketMaxIndex);
  return rangeSize(normalized) >= boundedMaximum(visualBucketMaxIndex) + 1 ? null : normalized;
};

export const visualRangeFor = (
  state: Pick<TimeRangeControlState, 'visualRange'>,
  context: Pick<TimeRangeControlContext, 'visualBucketMaxIndex'>,
): TimeRangeIndexRange =>
  state.visualRange === null
    ? { from: 0, to: boundedMaximum(context.visualBucketMaxIndex) }
    : normalizeVisualRange(state.visualRange, context.visualBucketMaxIndex);

export const visualRangeSize = (
  state: Pick<TimeRangeControlState, 'visualRange'>,
  context: Pick<TimeRangeControlContext, 'visualBucketMaxIndex'>,
): number => rangeSize(visualRangeFor(state, context));

export const isVisualRangeZoomed = (
  state: Pick<TimeRangeControlState, 'visualRange'>,
  context: Pick<TimeRangeControlContext, 'visualBucketMaxIndex'>,
): boolean => visualRangeSize(state, context) < boundedMaximum(context.visualBucketMaxIndex) + 1;

export const sliderIndexForKey = (key: string, current: number, maximum: number, step: number): number | null => {
  if (key === 'ArrowLeft' || key === 'ArrowDown') {
    return current - step;
  }
  if (key === 'ArrowRight' || key === 'ArrowUp') {
    return current + step;
  }
  if (key === 'PageDown') {
    return current - PAGE_KEY_STEP;
  }
  if (key === 'PageUp') {
    return current + PAGE_KEY_STEP;
  }
  if (key === 'Home') {
    return 0;
  }
  if (key === 'End') {
    return boundedMaximum(maximum);
  }
  return null;
};

export const pointerIndexDelta = (options: {
  clientX: number;
  scale: number;
  startClientX: number;
  trackWidth: number;
}): number => {
  if (!(Number.isFinite(options.clientX) && Number.isFinite(options.startClientX) && options.trackWidth > 0)) {
    return 0;
  }
  return Math.round(((options.clientX - options.startClientX) / options.trackWidth) * options.scale);
};

export const createTimeRangeControlState = (options: {
  context: TimeRangeControlContext;
  options: TimeRangeControlOptions;
  selectionIndexes: TimeRangeSelectionIndexes;
  visualRange?: TimeRangeIndexRange | null;
}): TimeRangeControlState => ({
  hover: EMPTY_HOVER,
  interaction: IDLE_INTERACTION,
  options: options.options,
  selectionIndexes: normalizeSelectionIndexes(options.selectionIndexes, options.context.selectionMaxIndex),
  visualRange:
    options.visualRange == null ? null : storedVisualRange(options.visualRange, options.context.visualBucketMaxIndex),
  viewControlsOpen: false,
});

const unchanged = (state: TimeRangeControlState): TimeRangeControlTransition => ({
  commands: [],
  handled: false,
  state,
});

const changed = (
  state: TimeRangeControlState,
  commands: readonly TimeRangeControlCommand[] = [],
): TimeRangeControlTransition => ({ commands, handled: true, state });

const clearHoverState = (state: TimeRangeControlState): TimeRangeControlState => ({
  ...state,
  hover: EMPTY_HOVER,
});

const changeVisualRange = (
  state: TimeRangeControlState,
  range: TimeRangeIndexRange,
  context: TimeRangeControlContext,
): TimeRangeControlTransition =>
  changed(
    clearHoverState({
      ...state,
      visualRange: storedVisualRange(range, context.visualBucketMaxIndex),
    }),
    [{ type: 'clearHover' }],
  );

const selectionIndexesForHandle = (
  indexes: TimeRangeSelectionIndexes,
  handle: TimeRangeHandle,
  index: number,
  selectionMaxIndex: number,
): TimeRangeSelectionIndexes => {
  const nextIndex = clampIndex(index, selectionMaxIndex);
  return handle === 'start'
    ? [Math.min(nextIndex, indexes[1]), indexes[1]]
    : [indexes[0], Math.max(nextIndex, indexes[0])];
};

const visualRangeForHandle = (
  range: TimeRangeIndexRange,
  handle: TimeRangeHandle,
  index: number,
  visualBucketMaxIndex: number,
): TimeRangeIndexRange => {
  const nextIndex = clampIndex(index, visualBucketMaxIndex);
  return handle === 'start'
    ? { from: Math.min(nextIndex, range.to), to: range.to }
    : { from: range.from, to: Math.max(nextIndex, range.from) };
};

const transitionPointerStart = (
  state: TimeRangeControlState,
  event: PointerStartEvent,
  context: TimeRangeControlContext,
): TimeRangeControlTransition => {
  if (
    event.button !== 0 ||
    state.interaction.type !== 'idle' ||
    !Number.isFinite(event.clientX) ||
    !Number.isFinite(event.pointerId) ||
    !(event.trackWidth > 0)
  ) {
    return unchanged(state);
  }

  if (event.interaction === 'selection-pan') {
    const selectionMaxIndex = boundedMaximum(context.selectionMaxIndex);
    if (selectionMaxIndex <= 0) {
      return unchanged(state);
    }
    return changed({
      ...state,
      interaction: {
        pointerId: event.pointerId,
        selectionMaxIndex,
        startClientX: event.clientX,
        startIndexes: state.selectionIndexes,
        trackWidth: event.trackWidth,
        type: 'selection-pan',
      },
    });
  }

  if (event.interaction === 'selection-handle') {
    const selectionMaxIndex = boundedMaximum(context.selectionMaxIndex);
    if (selectionMaxIndex <= 0) {
      return unchanged(state);
    }
    return changed({
      ...state,
      interaction: {
        handle: event.handle,
        pointerId: event.pointerId,
        selectionMaxIndex,
        startClientX: event.clientX,
        startIndex: event.handle === 'start' ? state.selectionIndexes[0] : state.selectionIndexes[1],
        trackWidth: event.trackWidth,
        type: 'selection-handle',
      },
    });
  }

  const visualBucketMaxIndex = boundedMaximum(context.visualBucketMaxIndex);
  if (visualBucketMaxIndex <= 0) {
    return unchanged(state);
  }

  if (event.interaction === 'view-pan') {
    const startRange = visualRangeFor(state, context);
    if (!(isVisualRangeZoomed(state, context) && event.scaleBucketCount > 0)) {
      return unchanged(state);
    }
    return changed(
      clearHoverState({
        ...state,
        interaction: {
          pointerId: event.pointerId,
          scaleBucketCount: event.scaleBucketCount,
          startClientX: event.clientX,
          startRange,
          trackWidth: event.trackWidth,
          type: 'view-pan',
          visualBucketMaxIndex,
        },
      }),
      [{ type: 'clearHover' }],
    );
  }

  const range = visualRangeFor(state, context);
  return changed(
    clearHoverState({
      ...state,
      interaction: {
        handle: event.handle,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startIndex: event.handle === 'start' ? range.from : range.to,
        trackWidth: event.trackWidth,
        type: 'view-handle',
        visualBucketMaxIndex,
      },
    }),
    [{ type: 'clearHover' }],
  );
};

const transitionPointerMove = (
  state: TimeRangeControlState,
  event: Extract<TimeRangeControlEvent, { type: 'pointerMove' }>,
): TimeRangeControlTransition => {
  const { interaction } = state;
  if (interaction.type === 'idle' || interaction.pointerId !== event.pointerId) {
    return unchanged(state);
  }

  if (interaction.type === 'selection-pan') {
    const span = interaction.startIndexes[1] - interaction.startIndexes[0];
    const delta = pointerIndexDelta({
      clientX: event.clientX,
      scale: interaction.selectionMaxIndex,
      startClientX: interaction.startClientX,
      trackWidth: interaction.trackWidth,
    });
    const from = clampIndex(interaction.startIndexes[0] + delta, Math.max(0, interaction.selectionMaxIndex - span));
    const selectionIndexes: TimeRangeSelectionIndexes = [from, from + span];
    return changed({ ...state, selectionIndexes }, [{ indexes: selectionIndexes, type: 'setSelectionIndexes' }]);
  }

  if (interaction.type === 'selection-handle') {
    const delta = pointerIndexDelta({
      clientX: event.clientX,
      scale: interaction.selectionMaxIndex,
      startClientX: interaction.startClientX,
      trackWidth: interaction.trackWidth,
    });
    const selectionIndexes = selectionIndexesForHandle(
      state.selectionIndexes,
      interaction.handle,
      interaction.startIndex + delta,
      interaction.selectionMaxIndex,
    );
    return changed({ ...state, selectionIndexes }, [{ indexes: selectionIndexes, type: 'setSelectionIndexes' }]);
  }

  if (interaction.type === 'view-pan') {
    const visibleCount = rangeSize(interaction.startRange);
    const delta = pointerIndexDelta({
      clientX: event.clientX,
      scale: interaction.scaleBucketCount,
      startClientX: interaction.startClientX,
      trackWidth: interaction.trackWidth,
    });
    const from = clampIndex(
      interaction.startRange.from + delta,
      Math.max(0, interaction.visualBucketMaxIndex - visibleCount + 1),
    );
    return changed({
      ...state,
      visualRange: storedVisualRange({ from, to: from + visibleCount - 1 }, interaction.visualBucketMaxIndex),
    });
  }

  const currentRange =
    state.visualRange === null
      ? { from: 0, to: interaction.visualBucketMaxIndex }
      : normalizeVisualRange(state.visualRange, interaction.visualBucketMaxIndex);
  const delta = pointerIndexDelta({
    clientX: event.clientX,
    scale: interaction.visualBucketMaxIndex,
    startClientX: interaction.startClientX,
    trackWidth: interaction.trackWidth,
  });
  return changed({
    ...state,
    visualRange: storedVisualRange(
      visualRangeForHandle(
        currentRange,
        interaction.handle,
        interaction.startIndex + delta,
        interaction.visualBucketMaxIndex,
      ),
      interaction.visualBucketMaxIndex,
    ),
  });
};

const transitionPointerFinish = (
  state: TimeRangeControlState,
  event: Extract<TimeRangeControlEvent, { type: 'pointerCancel' | 'pointerCaptureLost' | 'pointerEnd' }>,
): TimeRangeControlTransition => {
  if (state.interaction.type === 'idle' || state.interaction.pointerId !== event.pointerId) {
    return unchanged(state);
  }
  const commitReportRange = state.interaction.type === 'selection-pan' || state.interaction.type === 'selection-handle';
  return changed({ ...state, interaction: IDLE_INTERACTION }, commitReportRange ? [{ type: 'commitReportRange' }] : []);
};

const transitionKeyboardMove = (
  state: TimeRangeControlState,
  event: Extract<TimeRangeControlEvent, { type: 'keyboardMove' }>,
  context: TimeRangeControlContext,
): TimeRangeControlTransition => {
  if (event.axis === 'selection') {
    const current = event.handle === 'start' ? state.selectionIndexes[0] : state.selectionIndexes[1];
    const next = sliderIndexForKey(event.key, current, context.selectionMaxIndex, event.shiftKey ? 7 : 1);
    if (next === null) {
      return unchanged(state);
    }
    const selectionIndexes = selectionIndexesForHandle(
      state.selectionIndexes,
      event.handle,
      next,
      context.selectionMaxIndex,
    );
    return changed({ ...state, selectionIndexes }, [
      { indexes: selectionIndexes, type: 'setSelectionIndexes' },
      { type: 'commitReportRange' },
    ]);
  }

  const range = visualRangeFor(state, context);
  const current = event.handle === 'start' ? range.from : range.to;
  const next = sliderIndexForKey(event.key, current, context.visualBucketMaxIndex, event.shiftKey ? 7 : 1);
  if (next === null) {
    return unchanged(state);
  }
  return changeVisualRange(
    state,
    visualRangeForHandle(range, event.handle, next, context.visualBucketMaxIndex),
    context,
  );
};

const transitionZoom = (
  state: TimeRangeControlState,
  event: Extract<TimeRangeControlEvent, { type: 'zoom' }>,
  context: TimeRangeControlContext,
): TimeRangeControlTransition => {
  const totalBuckets = boundedMaximum(context.visualBucketMaxIndex) + 1;
  if (totalBuckets <= 1 || !(Number.isFinite(event.factor) && event.factor > 0)) {
    return unchanged(state);
  }
  const currentRange = visualRangeFor(state, context);
  const nextCount = Math.min(totalBuckets, Math.max(1, Math.round(rangeSize(currentRange) * event.factor)));
  if (nextCount >= totalBuckets) {
    return changed(clearHoverState({ ...state, visualRange: null }), [{ type: 'clearHover' }]);
  }
  const anchorRatio = Math.min(1, Math.max(0, event.anchorRatio ?? 0.5));
  const anchor = currentRange.from + (rangeSize(currentRange) - 1) * anchorRatio;
  const from = clampIndex(anchor - (nextCount - 1) * anchorRatio, Math.max(0, totalBuckets - nextCount));
  return changeVisualRange(state, { from, to: from + nextCount - 1 }, context);
};

const transitionPan = (
  state: TimeRangeControlState,
  event: Extract<TimeRangeControlEvent, { type: 'pan' }>,
  context: TimeRangeControlContext,
): TimeRangeControlTransition => {
  if (!isVisualRangeZoomed(state, context)) {
    return unchanged(state);
  }
  const range = visualRangeFor(state, context);
  const count = rangeSize(range);
  const from = event.destination === 'start' ? 0 : boundedMaximum(context.visualBucketMaxIndex) - count + 1;
  return changeVisualRange(state, { from, to: from + count - 1 }, context);
};

export const transitionTimeRangeControl = (
  state: TimeRangeControlState,
  event: TimeRangeControlEvent,
  context: TimeRangeControlContext,
): TimeRangeControlTransition => {
  switch (event.type) {
    case 'domainChanged': {
      const visualRange =
        state.visualRange === null ? null : storedVisualRange(state.visualRange, context.visualBucketMaxIndex);
      return changed(
        clearHoverState({
          ...state,
          interaction: IDLE_INTERACTION,
          selectionIndexes: normalizeSelectionIndexes(event.selectionIndexesFromDates, context.selectionMaxIndex),
          visualRange,
        }),
        [{ type: 'clearHover' }],
      );
    }
    case 'selectionSynchronized': {
      const nextState = {
        ...state,
        interaction: event.source === 'external' ? IDLE_INTERACTION : state.interaction,
        selectionIndexes: normalizeSelectionIndexes(event.selectionIndexes, context.selectionMaxIndex),
      };
      return changed(nextState, event.source === 'external' ? [] : [{ type: 'commitReportRange' }]);
    }
    case 'optionsSynchronized':
      return changed(
        clearHoverState({
          ...state,
          interaction: IDLE_INTERACTION,
          options: { ...state.options, dimension: event.dimension, granularity: event.granularity },
          visualRange: null,
          viewControlsOpen: false,
        }),
      );
    case 'optionChanged': {
      if (event.option === 'granularity') {
        return changed(
          clearHoverState({
            ...state,
            interaction: IDLE_INTERACTION,
            options: { ...state.options, granularity: event.value },
            selectionIndexes: normalizeSelectionIndexes(event.selectionIndexesFromDates, context.selectionMaxIndex),
            visualRange: null,
            viewControlsOpen: false,
          }),
          [{ type: 'clearHover' }],
        );
      }
      return changed(
        clearHoverState({
          ...state,
          options:
            event.option === 'dimension'
              ? { ...state.options, dimension: event.value }
              : { ...state.options, value: event.value },
        }),
        [{ type: 'clearHover' }],
      );
    }
    case 'pointerStart':
      return transitionPointerStart(state, event, context);
    case 'pointerMove':
      return transitionPointerMove(state, event);
    case 'pointerEnd':
    case 'pointerCancel':
    case 'pointerCaptureLost':
      return transitionPointerFinish(state, event);
    case 'keyboardMove':
      return transitionKeyboardMove(state, event, context);
    case 'zoom':
      return transitionZoom(state, event, context);
    case 'pan':
      return transitionPan(state, event, context);
    case 'setVisualRange':
      return changeVisualRange(state, event.range, context);
    case 'resetVisualRange':
      return changed(clearHoverState({ ...state, visualRange: null }), [{ type: 'clearHover' }]);
    case 'viewControlsChanged':
      return changed({ ...state, viewControlsOpen: event.open });
    case 'hoverChanged':
      return changed({ ...state, hover: { bucketIndex: event.bucketIndex, key: event.key } });
    case 'clearHover':
      return changed(clearHoverState(state), [{ type: 'clearHover' }]);
    default:
      return unchanged(state);
  }
};
