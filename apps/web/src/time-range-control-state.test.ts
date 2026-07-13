import { describe, expect, test } from 'bun:test';
import {
  createTimeRangeControlState,
  pointerIndexDelta,
  sliderIndexForKey,
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
    expect(result.commands).toEqual([{ type: 'clearHover' }]);
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

  test('keeps pointer and keyboard calculations deterministic', () => {
    expect(pointerIndexDelta({ clientX: 70, scale: 20, startClientX: 20, trackWidth: 100 })).toBe(10);
    expect(sliderIndexForKey('PageUp', 5, 100, 1)).toBe(35);
    expect(sliderIndexForKey('Escape', 5, 100, 1)).toBeNull();
  });
});
