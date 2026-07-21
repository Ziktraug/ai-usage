import { describe, expect, test } from 'bun:test';
import { calculateSessionRowWindow } from './session-row-window';

const windowFor = (overrides: Partial<Parameters<typeof calculateSessionRowWindow>[0]> = {}) =>
  calculateSessionRowWindow({
    maxRows: 600,
    overscanRows: 2,
    rowCount: 100,
    rowHeight: 10,
    scrollTop: 0,
    viewportHeight: 50,
    ...overrides,
  });

describe('session row window', () => {
  test('returns an empty window for an empty collection', () => {
    expect(windowFor({ rowCount: 0 })).toEqual({
      bottomHeight: 0,
      endIndex: 0,
      startIndex: 0,
      topHeight: 0,
    });
  });

  test('starts at the first row with bottom space for the remaining rows', () => {
    expect(windowFor()).toEqual({
      bottomHeight: 930,
      endIndex: 7,
      startIndex: 0,
      topHeight: 0,
    });
  });

  test('keeps overscan around a middle viewport', () => {
    expect(windowFor({ scrollTop: 400 })).toEqual({
      bottomHeight: 530,
      endIndex: 47,
      startIndex: 38,
      topHeight: 380,
    });
  });

  test('clamps the window to the end of the collection', () => {
    expect(windowFor({ scrollTop: 10_000 })).toEqual({
      bottomHeight: 0,
      endIndex: 100,
      startIndex: 93,
      topHeight: 930,
    });
  });

  test('clamps invalid bounds and never exceeds the configured DOM limit', () => {
    expect(windowFor({ maxRows: 6, overscanRows: 20, scrollTop: -500 }).startIndex).toBe(0);
    expect(windowFor({ maxRows: 6, overscanRows: 20, scrollTop: -500 }).endIndex).toBe(6);

    const bounded = windowFor({ maxRows: 12, overscanRows: 100, scrollTop: 500, viewportHeight: 100 });
    expect(bounded.endIndex - bounded.startIndex).toBe(12);
    expect(bounded.topHeight + (bounded.endIndex - bounded.startIndex) * 10 + bounded.bottomHeight).toBe(1000);
  });
});
