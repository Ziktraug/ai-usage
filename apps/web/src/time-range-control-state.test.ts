import { describe, expect, test } from 'bun:test';
import {
  createTimeRangeControlState,
  type TimeRangeControlContext,
  transitionTimeRangeControl,
  visualRangeFor,
} from './time-range-control-state';

const context = (selectionMaxIndex: number, visualBucketMaxIndex: number): TimeRangeControlContext => ({
  selectionMaxIndex,
  visualBucketMaxIndex,
});

const initialState = (currentContext: TimeRangeControlContext = context(30, 4)) =>
  createTimeRangeControlState({
    context: currentContext,
    options: { dimension: 'harness', granularity: 'day', value: 'cost' },
    selectionIndexes: [5, 20],
  });

const commandTypes = (commands: ReturnType<typeof transitionTimeRangeControl>['commands']) =>
  commands.map((command) => command.type);

describe('time range control state normalization', () => {
  test('normalizes report days and visual buckets against their distinct axes', () => {
    const currentContext = context(30, 2);
    const state = createTimeRangeControlState({
      context: currentContext,
      options: { dimension: 'harness', granularity: 'week', value: 'cost' },
      selectionIndexes: [28, 3],
      visualRange: { from: 9, to: -3 },
    });

    expect(state.selectionIndexes).toEqual([3, 28]);
    expect(visualRangeFor(state, currentContext)).toEqual({ from: 0, to: 2 });
    expect(state.visualRange).toBeNull();
  });

  test('clamps both axes and cancels an active interaction on a domain change', () => {
    const started = transitionTimeRangeControl(
      initialState(),
      {
        type: 'pointerStart',
        interaction: 'selection-pan',
        button: 0,
        clientX: 20,
        pointerId: 7,
        trackWidth: 100,
      },
      context(30, 4),
    ).state;

    const result = transitionTimeRangeControl(
      started,
      { type: 'domainChanged', selectionIndexesFromDates: [18, 40] },
      context(20, 1),
    );

    expect(result.state.selectionIndexes).toEqual([18, 20]);
    expect(visualRangeFor(result.state, context(20, 1))).toEqual({ from: 0, to: 1 });
    expect(result.state.interaction).toEqual({ type: 'idle' });
    expect(commandTypes(result.commands)).toEqual(['clearHover']);
  });
});

describe('time range control report selection', () => {
  test.each(['preset', 'input'] as const)('%s selection commits immediately', (source) => {
    const result = transitionTimeRangeControl(
      initialState(),
      { type: 'selectionSynchronized', selectionIndexes: [1, 3], source },
      context(30, 4),
    );

    expect(result.state.selectionIndexes).toEqual([1, 3]);
    expect(commandTypes(result.commands)).toEqual(['commitReportRange']);
  });

  test('an external selection sync does not duplicate its existing URL commit', () => {
    const result = transitionTimeRangeControl(
      initialState(),
      { type: 'selectionSynchronized', selectionIndexes: [4, 8], source: 'external' },
      context(30, 4),
    );

    expect(result.state.selectionIndexes).toEqual([4, 8]);
    expect(result.commands).toEqual([]);
  });

  test('keyboard movement updates and commits the report range immediately', () => {
    const result = transitionTimeRangeControl(
      initialState(),
      { type: 'keyboardMove', axis: 'selection', handle: 'start', key: 'ArrowRight', shiftKey: true },
      context(30, 4),
    );

    expect(result.state.selectionIndexes).toEqual([12, 20]);
    expect(result.commands).toEqual([
      { type: 'setSelectionIndexes', indexes: [12, 20] },
      { type: 'commitReportRange' },
    ]);
  });

  test('selection pointer movement updates without committing until the pointer ends', () => {
    const started = transitionTimeRangeControl(
      initialState(),
      {
        type: 'pointerStart',
        interaction: 'selection-pan',
        button: 0,
        clientX: 20,
        pointerId: 7,
        trackWidth: 100,
      },
      context(30, 4),
    );
    const moved = transitionTimeRangeControl(
      started.state,
      { type: 'pointerMove', clientX: 40, pointerId: 7 },
      context(30, 4),
    );

    expect(moved.state.selectionIndexes).toEqual([11, 26]);
    expect(moved.commands).toEqual([{ type: 'setSelectionIndexes', indexes: [11, 26] }]);

    const ended = transitionTimeRangeControl(moved.state, { type: 'pointerEnd', pointerId: 7 }, context(30, 4));
    expect(ended.state.interaction).toEqual({ type: 'idle' });
    expect(ended.commands).toEqual([{ type: 'commitReportRange' }]);
  });

  test('selection handle movement cannot cross the other handle', () => {
    const started = transitionTimeRangeControl(
      initialState(),
      {
        type: 'pointerStart',
        interaction: 'selection-handle',
        button: 0,
        clientX: 0,
        handle: 'start',
        pointerId: 3,
        trackWidth: 100,
      },
      context(30, 4),
    ).state;
    const moved = transitionTimeRangeControl(
      started,
      { type: 'pointerMove', clientX: 100, pointerId: 3 },
      context(30, 4),
    );

    expect(moved.state.selectionIndexes).toEqual([20, 20]);
    expect(moved.commands).toEqual([{ type: 'setSelectionIndexes', indexes: [20, 20] }]);
  });
});

describe('time range control visual view', () => {
  test('keyboard movement changes visual buckets without committing the report', () => {
    const currentContext = context(30, 4);
    const state = { ...initialState(currentContext), visualRange: { from: 1, to: 3 } };
    const result = transitionTimeRangeControl(
      state,
      { type: 'keyboardMove', axis: 'visual', handle: 'start', key: 'ArrowRight', shiftKey: false },
      currentContext,
    );

    expect(visualRangeFor(result.state, currentContext)).toEqual({ from: 2, to: 3 });
    expect(commandTypes(result.commands)).toEqual(['clearHover']);
    expect(commandTypes(result.commands)).not.toContain('commitReportRange');
  });

  test('zooms around an anchor, pans, and resets without changing selection', () => {
    const currentContext = context(30, 9);
    const original = initialState(currentContext);
    const zoomed = transitionTimeRangeControl(original, { type: 'zoom', anchorRatio: 1, factor: 0.5 }, currentContext);
    expect(visualRangeFor(zoomed.state, currentContext)).toEqual({ from: 5, to: 9 });

    const panned = transitionTimeRangeControl(zoomed.state, { type: 'pan', destination: 'start' }, currentContext);
    expect(visualRangeFor(panned.state, currentContext)).toEqual({ from: 0, to: 4 });

    const reset = transitionTimeRangeControl(panned.state, { type: 'resetVisualRange' }, currentContext);
    expect(reset.state.selectionIndexes).toEqual(original.selectionIndexes);
    expect(reset.state.visualRange).toBeNull();
    expect(commandTypes([...zoomed.commands, ...panned.commands, ...reset.commands])).not.toContain(
      'commitReportRange',
    );
  });

  test('visual pointer pan and resize never emit report commands', () => {
    const currentContext = context(30, 9);
    const zoomed = { ...initialState(currentContext), visualRange: { from: 2, to: 6 } };
    const panStarted = transitionTimeRangeControl(
      zoomed,
      {
        type: 'pointerStart',
        interaction: 'view-pan',
        button: 0,
        clientX: 10,
        pointerId: 4,
        scaleBucketCount: 10,
        trackWidth: 100,
      },
      currentContext,
    ).state;
    const panned = transitionTimeRangeControl(
      panStarted,
      { type: 'pointerMove', clientX: 30, pointerId: 4 },
      currentContext,
    );
    expect(visualRangeFor(panned.state, currentContext)).toEqual({ from: 4, to: 8 });

    const panEnded = transitionTimeRangeControl(panned.state, { type: 'pointerEnd', pointerId: 4 }, currentContext);
    expect(panEnded.commands).toEqual([]);

    const handleStarted = transitionTimeRangeControl(
      panEnded.state,
      {
        type: 'pointerStart',
        interaction: 'view-handle',
        button: 0,
        clientX: 0,
        handle: 'end',
        pointerId: 5,
        trackWidth: 100,
      },
      currentContext,
    ).state;
    const resized = transitionTimeRangeControl(
      handleStarted,
      { type: 'pointerMove', clientX: -100, pointerId: 5 },
      currentContext,
    );
    expect(visualRangeFor(resized.state, currentContext)).toEqual({ from: 4, to: 4 });
    expect(commandTypes(resized.commands)).not.toContain('setSelectionIndexes');
    expect(commandTypes(resized.commands)).not.toContain('commitReportRange');
  });
});

describe('time range control interaction lifecycle', () => {
  test('ignores foreign pointer IDs without changing state or commands', () => {
    const started = transitionTimeRangeControl(
      initialState(),
      {
        type: 'pointerStart',
        interaction: 'selection-pan',
        button: 0,
        clientX: 0,
        pointerId: 2,
        trackWidth: 100,
      },
      context(30, 4),
    ).state;

    for (const event of [
      { type: 'pointerMove', clientX: 90, pointerId: 99 } as const,
      { type: 'pointerEnd', pointerId: 99 } as const,
      { type: 'pointerCancel', pointerId: 99 } as const,
      { type: 'pointerCaptureLost', pointerId: 99 } as const,
    ]) {
      const result = transitionTimeRangeControl(started, event, context(30, 4));
      expect(result.state).toBe(started);
      expect(result.commands).toEqual([]);
      expect(result.handled).toBe(false);
    }
  });

  test.each([
    'pointerCancel',
    'pointerCaptureLost',
  ] as const)('%s finishes a report drag and commits its current selection', (type) => {
    const started = transitionTimeRangeControl(
      initialState(),
      {
        type: 'pointerStart',
        interaction: 'selection-handle',
        button: 0,
        clientX: 0,
        handle: 'end',
        pointerId: 8,
        trackWidth: 100,
      },
      context(30, 4),
    ).state;
    const result = transitionTimeRangeControl(started, { type, pointerId: 8 }, context(30, 4));

    expect(result.state.interaction).toEqual({ type: 'idle' });
    expect(result.commands).toEqual([{ type: 'commitReportRange' }]);
    expect(result.handled).toBe(true);
  });

  test.each([
    'pointerCancel',
    'pointerCaptureLost',
  ] as const)('%s finishes a visual drag without committing the report', (type) => {
    const currentContext = context(30, 4);
    const started = transitionTimeRangeControl(
      { ...initialState(currentContext), visualRange: { from: 1, to: 3 } },
      {
        type: 'pointerStart',
        interaction: 'view-handle',
        button: 0,
        clientX: 0,
        handle: 'end',
        pointerId: 8,
        trackWidth: 100,
      },
      currentContext,
    ).state;
    const result = transitionTimeRangeControl(started, { type, pointerId: 8 }, currentContext);

    expect(result.state.interaction).toEqual({ type: 'idle' });
    expect(result.commands).toEqual([]);
  });
});

describe('time range control option transitions', () => {
  test('granularity takes date-remapped selection indexes and resets bucket view explicitly', () => {
    const oldContext = context(90, 90);
    const state = {
      ...initialState(oldContext),
      selectionIndexes: [30, 60] as [number, number],
      visualRange: { from: 30, to: 60 },
    };
    const weeklyContext = context(90, 12);
    const result = transitionTimeRangeControl(
      state,
      {
        type: 'optionChanged',
        option: 'granularity',
        selectionIndexesFromDates: [30, 60],
        value: 'week',
      },
      weeklyContext,
    );

    expect(result.state.options.granularity).toBe('week');
    expect(result.state.selectionIndexes).toEqual([30, 60]);
    expect(visualRangeFor(result.state, weeklyContext)).toEqual({ from: 0, to: 12 });
    expect(result.state.visualRange).toBeNull();
    expect(result.state.viewControlsOpen).toBe(false);
  });

  test('tracks disclosure and hover while option changes clear hover', () => {
    const opened = transitionTimeRangeControl(
      initialState(),
      { type: 'viewControlsChanged', open: true },
      context(30, 4),
    );
    const hovered = transitionTimeRangeControl(
      opened.state,
      { type: 'hoverChanged', bucketIndex: 2, key: 'Codex' },
      context(30, 4),
    );
    const changed = transitionTimeRangeControl(
      hovered.state,
      { type: 'optionChanged', option: 'dimension', value: 'project' },
      context(30, 4),
    );

    expect(changed.state.viewControlsOpen).toBe(true);
    expect(changed.state.hover).toEqual({ bucketIndex: null, key: null });
    expect(commandTypes(changed.commands)).toEqual(['clearHover']);
  });
});
