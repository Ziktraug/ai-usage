import { describe, expect, test } from 'bun:test';
import { calculateSessionRowWindow, calculateSessionViewportHeight } from './session-row-window';

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
  test('sizes the desktop surface between its document position and the page bottom', () => {
    expect(
      calculateSessionViewportHeight({
        anchorTop: 0,
        bottomInset: 32,
        minimumHeight: 129,
        surfaceTop: 364,
        viewportHeight: 1080,
      }),
    ).toBe(684);
  });

  test('sizes the mobile surface from its region anchor', () => {
    expect(
      calculateSessionViewportHeight({
        anchorTop: 304,
        bottomInset: 96,
        minimumHeight: 188,
        surfaceTop: 364,
        viewportHeight: 844,
      }),
    ).toBe(688);
  });

  test('is invariant when both document offsets move together', () => {
    const height = calculateSessionViewportHeight({
      anchorTop: 304,
      bottomInset: 96,
      minimumHeight: 188,
      surfaceTop: 364,
      viewportHeight: 844,
    });
    const shiftedHeight = calculateSessionViewportHeight({
      anchorTop: 804,
      bottomInset: 96,
      minimumHeight: 188,
      surfaceTop: 864,
      viewportHeight: 844,
    });

    expect(shiftedHeight).toBe(height);
  });

  test('keeps a usable surface in a viewport shorter than the minimum', () => {
    expect(
      calculateSessionViewportHeight({
        anchorTop: 0,
        bottomInset: 32,
        minimumHeight: 129,
        surfaceTop: 364,
        viewportHeight: 220,
      }),
    ).toBe(129);
    expect(
      calculateSessionViewportHeight({
        anchorTop: 0,
        bottomInset: 32,
        minimumHeight: 188,
        surfaceTop: 700,
        viewportHeight: 300,
      }),
    ).toBe(188);
  });

  test('treats invalid document offsets as no chrome above the surface', () => {
    expect(
      calculateSessionViewportHeight({
        anchorTop: -20,
        bottomInset: 32,
        minimumHeight: 129,
        surfaceTop: Number.NaN,
        viewportHeight: 900,
      }),
    ).toBe(868);
    expect(
      calculateSessionViewportHeight({
        anchorTop: 500,
        bottomInset: 32,
        minimumHeight: 129,
        surfaceTop: 300,
        viewportHeight: 900,
      }),
    ).toBe(868);
  });

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
