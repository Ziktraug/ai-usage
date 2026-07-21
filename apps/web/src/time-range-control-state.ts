import type { MigrationGranularity, TimelineDimension, TimelineValue } from './overview-model';

export type TimeRangeHandle = 'start' | 'end';
export type TimeRangeIndexRange = Readonly<{ from: number; to: number }>;
export type TimeRangeSelectionIndexes = readonly [number, number];

export interface TimeRangeControlContext {
  selectionMaxIndex: number;
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

export type TimeRangeControlInteraction = IdleInteraction | SelectionPanInteraction | SelectionHandleInteraction;

export interface TimeRangeControlState {
  hover: Readonly<{ bucketIndex: number | null; key: string | null }>;
  interaction: TimeRangeControlInteraction;
  options: TimeRangeControlOptions;
  selectionIndexes: TimeRangeSelectionIndexes;
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
      axis: 'selection';
      handle: TimeRangeHandle;
      key: string;
      shiftKey: boolean;
      type: 'keyboardMove';
    }
  | {
      key: string;
      type: 'timelineKeyboardMove';
      visibleRange: TimeRangeIndexRange;
    }
  | { clientX: number; pointerId: number; type: 'pointerMove' }
  | { pointerId: number; type: 'pointerEnd' | 'pointerCancel' | 'pointerCaptureLost' }
  | { bucketIndex: number | null; key: string | null; type: 'hoverChanged' }
  | { type: 'clearHover' };

export type TimeRangeControlCommand =
  | { indexes: TimeRangeSelectionIndexes; type: 'setSelectionIndexes' }
  | { type: 'commitReportRange' };

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

const sliderIndexForKey = (key: string, current: number, maximum: number, step: number): number | null => {
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

const pointerIndexDelta = (options: {
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
}): TimeRangeControlState => ({
  hover: EMPTY_HOVER,
  interaction: IDLE_INTERACTION,
  options: options.options,
  selectionIndexes: normalizeSelectionIndexes(options.selectionIndexes, options.context.selectionMaxIndex),
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

const transitionPointerStart = (
  state: TimeRangeControlState,
  event: PointerStartEvent,
  context: TimeRangeControlContext,
): TimeRangeControlTransition => {
  const selectionMaxIndex = boundedMaximum(context.selectionMaxIndex);
  if (
    event.button !== 0 ||
    state.interaction.type !== 'idle' ||
    !Number.isFinite(event.clientX) ||
    !Number.isFinite(event.pointerId) ||
    !(event.trackWidth > 0) ||
    selectionMaxIndex <= 0
  ) {
    return unchanged(state);
  }

  if (event.interaction === 'selection-pan') {
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
};

const transitionPointerFinish = (
  state: TimeRangeControlState,
  event: Extract<TimeRangeControlEvent, { type: 'pointerCancel' | 'pointerCaptureLost' | 'pointerEnd' }>,
): TimeRangeControlTransition => {
  if (state.interaction.type === 'idle' || state.interaction.pointerId !== event.pointerId) {
    return unchanged(state);
  }
  return changed({ ...state, interaction: IDLE_INTERACTION }, [{ type: 'commitReportRange' }]);
};

const transitionKeyboardMove = (
  state: TimeRangeControlState,
  event: Extract<TimeRangeControlEvent, { type: 'keyboardMove' }>,
  context: TimeRangeControlContext,
): TimeRangeControlTransition => {
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
};

const transitionTimelineKeyboardMove = (
  state: TimeRangeControlState,
  event: Extract<TimeRangeControlEvent, { type: 'timelineKeyboardMove' }>,
): TimeRangeControlTransition => {
  const from = Math.min(event.visibleRange.from, event.visibleRange.to);
  const to = Math.max(event.visibleRange.from, event.visibleRange.to);
  const current = Math.min(to, Math.max(from, state.hover.bucketIndex ?? from));
  let bucketIndex: number | null = null;
  if (event.key === 'ArrowLeft') {
    bucketIndex = Math.max(from, current - 1);
  } else if (event.key === 'ArrowRight') {
    bucketIndex = Math.min(to, current + 1);
  } else if (event.key === 'Home') {
    bucketIndex = from;
  } else if (event.key === 'End') {
    bucketIndex = to;
  }
  return bucketIndex === null ? unchanged(state) : changed({ ...state, hover: { bucketIndex, key: null } });
};

export const transitionTimeRangeControl = (
  state: TimeRangeControlState,
  event: TimeRangeControlEvent,
  context: TimeRangeControlContext,
): TimeRangeControlTransition => {
  switch (event.type) {
    case 'domainChanged':
      return changed(
        clearHoverState({
          ...state,
          interaction: IDLE_INTERACTION,
          selectionIndexes: normalizeSelectionIndexes(event.selectionIndexesFromDates, context.selectionMaxIndex),
        }),
      );
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
          }),
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
    case 'timelineKeyboardMove':
      return transitionTimelineKeyboardMove(state, event);
    case 'hoverChanged':
      return changed({ ...state, hover: { bucketIndex: event.bucketIndex, key: event.key } });
    case 'clearHover':
      return changed(clearHoverState(state));
    default:
      return unchanged(state);
  }
};
