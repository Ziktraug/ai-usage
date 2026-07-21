import { describe, expect, test } from 'bun:test';
import {
  createTimeRangeControlState,
  type TimeRangeControlContext,
  transitionTimeRangeControl,
} from './time-range-control-state';

const context = (selectionMaxIndex: number): TimeRangeControlContext => ({ selectionMaxIndex });

const initialState = (selectionMaxIndex = 20) =>
  createTimeRangeControlState({
    context: context(selectionMaxIndex),
    options: { dimension: 'harness', granularity: 'day', value: 'cost' },
    selectionIndexes: [5, 10],
  });

describe('time range control normalization', () => {
  test('normalizes the single report range against its date domain', () => {
    const state = createTimeRangeControlState({
      context: context(8),
      options: { dimension: 'harness', granularity: 'day', value: 'cost' },
      selectionIndexes: [12, -3],
    });

    expect(state.selectionIndexes).toEqual([0, 8]);
    expect(state).not.toHaveProperty('visualRange');
  });

  test('clamps the report range and cancels interaction when the domain changes', () => {
    const started = transitionTimeRangeControl(
      initialState(),
      {
        button: 0,
        clientX: 20,
        interaction: 'selection-pan',
        pointerId: 1,
        trackWidth: 100,
        type: 'pointerStart',
      },
      context(20),
    );
    const result = transitionTimeRangeControl(
      started.state,
      { selectionIndexesFromDates: [9, 30], type: 'domainChanged' },
      context(12),
    );

    expect(result.state.selectionIndexes).toEqual([9, 12]);
    expect(result.state.interaction.type).toBe('idle');
    expect(result.commands).toEqual([]);
  });
});

describe('time range control report selection', () => {
  test('preset and input selection commit immediately', () => {
    for (const source of ['preset', 'input'] as const) {
      const result = transitionTimeRangeControl(
        initialState(),
        { selectionIndexes: [2, 7], source, type: 'selectionSynchronized' },
        context(20),
      );
      expect(result.state.selectionIndexes).toEqual([2, 7]);
      expect(result.commands).toEqual([{ type: 'commitReportRange' }]);
    }
  });

  test('an external selection sync does not duplicate its URL commit', () => {
    const result = transitionTimeRangeControl(
      initialState(),
      { selectionIndexes: [3, 8], source: 'external', type: 'selectionSynchronized' },
      context(20),
    );

    expect(result.state.selectionIndexes).toEqual([3, 8]);
    expect(result.commands).toEqual([]);
  });

  test('keyboard movement updates and commits the report range immediately', () => {
    const result = transitionTimeRangeControl(
      initialState(),
      { axis: 'selection', handle: 'start', key: 'ArrowRight', shiftKey: false, type: 'keyboardMove' },
      context(20),
    );

    expect(result.state.selectionIndexes).toEqual([6, 10]);
    expect(result.commands).toEqual([{ indexes: [6, 10], type: 'setSelectionIndexes' }, { type: 'commitReportRange' }]);
  });

  test('pointer movement updates without committing until the pointer ends', () => {
    const started = transitionTimeRangeControl(
      initialState(),
      {
        button: 0,
        clientX: 20,
        interaction: 'selection-pan',
        pointerId: 7,
        trackWidth: 100,
        type: 'pointerStart',
      },
      context(20),
    );
    const moved = transitionTimeRangeControl(
      started.state,
      { clientX: 40, pointerId: 7, type: 'pointerMove' },
      context(20),
    );
    const ended = transitionTimeRangeControl(moved.state, { pointerId: 7, type: 'pointerEnd' }, context(20));

    expect(moved.state.selectionIndexes).toEqual([9, 14]);
    expect(moved.commands).toEqual([{ indexes: [9, 14], type: 'setSelectionIndexes' }]);
    expect(ended.commands).toEqual([{ type: 'commitReportRange' }]);
  });

  test('selection handles cannot cross each other', () => {
    const result = transitionTimeRangeControl(
      initialState(),
      { axis: 'selection', handle: 'start', key: 'End', shiftKey: false, type: 'keyboardMove' },
      context(20),
    );

    expect(result.state.selectionIndexes).toEqual([10, 10]);
  });
});

describe('time range control options and inspection', () => {
  test('granularity preserves the date-mapped report selection and clears hover', () => {
    const state = {
      ...initialState(),
      hover: { bucketIndex: 3, key: 'Codex' },
    };
    const result = transitionTimeRangeControl(
      state,
      {
        option: 'granularity',
        selectionIndexesFromDates: [4, 9],
        type: 'optionChanged',
        value: 'week',
      },
      context(20),
    );

    expect(result.state.options.granularity).toBe('week');
    expect(result.state.selectionIndexes).toEqual([4, 9]);
    expect(result.state.hover).toEqual({ bucketIndex: null, key: null });
  });

  test('owns timeline inspection keys and clamps them to the visible range', () => {
    const hovered = transitionTimeRangeControl(
      initialState(),
      { bucketIndex: 8, key: 'Codex', type: 'hoverChanged' },
      context(20),
    );
    const moved = transitionTimeRangeControl(
      hovered.state,
      { key: 'ArrowRight', type: 'timelineKeyboardMove', visibleRange: { from: 4, to: 9 } },
      context(20),
    );
    const clamped = transitionTimeRangeControl(
      moved.state,
      { key: 'ArrowRight', type: 'timelineKeyboardMove', visibleRange: { from: 4, to: 9 } },
      context(20),
    );

    expect(moved.state.hover).toEqual({ bucketIndex: 9, key: null });
    expect(clamped.state.hover).toEqual({ bucketIndex: 9, key: null });
    expect(
      transitionTimeRangeControl(
        clamped.state,
        { key: 'Escape', type: 'timelineKeyboardMove', visibleRange: { from: 4, to: 9 } },
        context(20),
      ).handled,
    ).toBe(false);
  });

  test('treats Home and End as visible-timeline boundaries', () => {
    const home = transitionTimeRangeControl(
      initialState(),
      { key: 'Home', type: 'timelineKeyboardMove', visibleRange: { from: 3, to: 12 } },
      context(20),
    );
    const end = transitionTimeRangeControl(
      home.state,
      { key: 'End', type: 'timelineKeyboardMove', visibleRange: { from: 3, to: 12 } },
      context(20),
    );

    expect(home.state.hover.bucketIndex).toBe(3);
    expect(end.state.hover.bucketIndex).toBe(12);
  });

  test('ignores foreign pointers and commits every owned finish event once', () => {
    const started = transitionTimeRangeControl(
      initialState(),
      {
        button: 0,
        clientX: 20,
        interaction: 'selection-handle',
        handle: 'start',
        pointerId: 7,
        trackWidth: 100,
        type: 'pointerStart',
      },
      context(20),
    );
    expect(
      transitionTimeRangeControl(started.state, { clientX: 50, pointerId: 8, type: 'pointerMove' }, context(20))
        .handled,
    ).toBe(false);

    for (const type of ['pointerEnd', 'pointerCancel', 'pointerCaptureLost'] as const) {
      const finished = transitionTimeRangeControl(started.state, { pointerId: 7, type }, context(20));
      expect(finished.state.interaction.type).toBe('idle');
      expect(finished.commands).toEqual([{ type: 'commitReportRange' }]);
    }
  });
});
