import { describe, expect, test } from 'bun:test';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import { createRoot, createSignal } from 'solid-js';
import { rowMatchesDateBounds, toDateInputValue } from './date-range';
import { createDateRangeController } from './date-range-controller';

const rowAt = (activeDate: string): SerializedRow => ({
  date: activeDate,
  endDate: activeDate,
  activeDate,
  harness: 'Codex',
  provider: 'Codex API',
  name: activeDate,
  sessionLabel: activeDate,
  model: 'gpt-5.5',
  project: 'ai-usage',
  tokIn: 1,
  tokOut: 0,
  tokCr: 0,
  tokCw: 0,
  tokenTotal: 1,
  freshTokens: 1,
  costActual: null,
  costApprox: 0,
  costKnown: false,
  calls: 1,
  durationMs: null,
  turns: 0,
  tools: 0,
  linesAdded: null,
  linesDeleted: null,
  lineDelta: null,
});

const formatDate = (value: Date | string | null) =>
  value ? toDateInputValue(value instanceof Date ? value : new Date(value)) : '-';

describe('date range controller', () => {
  test('keeps inputs, indexes, bounds, and label behind one signal model', () => {
    createRoot((dispose) => {
      const controller = createDateRangeController({
        generatedAt: new Date(2026, 5, 12, 12),
        rows: () => [rowAt('2026-06-01T12:00:00.000Z'), rowAt('2026-06-10T12:00:00.000Z')],
        defaultFrom: '2026-06-06',
        defaultTo: '2026-06-12',
        formatDate,
      });

      expect(controller.mode()).toBe('all');
      expect(controller.inputValues()).toEqual({ from: '2026-06-01', to: '2026-06-10' });
      expect(controller.selectedIndexes()).toEqual([0, 9]);

      controller.setIndexes(2, 4);

      expect(controller.mode()).toBe('custom');
      expect(controller.inputValues()).toEqual({ from: '2026-06-03', to: '2026-06-05' });
      expect(controller.label()).toBe('2026-06-03 – 2026-06-05');
      expect(controller.bounds().from?.getDate()).toBe(3);
      expect(controller.bounds().to?.getDate()).toBe(5);

      controller.setFromInput('2026-06-11');

      expect(controller.inputValues()).toEqual({ from: '2026-06-11', to: '2026-06-11' });

      controller.clear();

      expect(controller.mode()).toBe('all');
      expect(controller.bounds()).toEqual({ from: null, to: null });

      dispose();
    });
  });

  test('can start from and replace a URL-backed custom range', () => {
    createRoot((dispose) => {
      const controller = createDateRangeController({
        generatedAt: new Date(2026, 5, 12, 12),
        rows: () => [rowAt('2026-06-01T12:00:00.000Z'), rowAt('2026-06-10T12:00:00.000Z')],
        defaultFrom: '2026-06-06',
        defaultTo: '2026-06-12',
        formatDate,
        initialFrom: '2026-06-02',
        initialMode: 'custom',
        initialTo: '2026-06-04',
      });

      expect(controller.mode()).toBe('custom');
      expect(controller.inputValues()).toEqual({ from: '2026-06-02', to: '2026-06-04' });

      controller.setRange('30d');

      expect(controller.mode()).toBe('30d');

      controller.setRange('custom', '2026-06-07', '2026-06-09');

      expect(controller.inputValues()).toEqual({ from: '2026-06-07', to: '2026-06-09' });

      dispose();
    });
  });

  test('keeps today aligned with newer loaded sessions when generatedAt is stale', () => {
    createRoot((dispose) => {
      const todaysRow = rowAt('2026-06-12T12:00:00.000Z');
      const controller = createDateRangeController({
        generatedAt: new Date(2026, 5, 11, 12),
        rows: () => [todaysRow],
        defaultFrom: '2026-06-05',
        defaultTo: '2026-06-11',
        formatDate,
      });

      controller.setPreset('today');

      expect(controller.inputValues()).toEqual({ from: '2026-06-12', to: '2026-06-12' });
      expect(rowMatchesDateBounds(todaysRow, controller.bounds())).toBe(true);

      dispose();
    });
  });

  test('anchors rolling presets to the last available report day', () => {
    createRoot((dispose) => {
      const controller = createDateRangeController({
        domain: () => ({
          minDay: new Date(2026, 5, 13),
          maxDay: new Date(2026, 5, 29),
        }),
        generatedAt: new Date(2026, 6, 13, 12),
        rows: () => [],
        defaultFrom: '2026-07-07',
        defaultTo: '2026-07-13',
        formatDate,
      });

      controller.setPreset('7d');

      expect(controller.inputValues()).toEqual({ from: '2026-06-22', to: '2026-06-29' });

      dispose();
    });
  });

  test('reacts when a focused report date domain arrives after hydration', () => {
    createRoot((dispose) => {
      const [focusedDomain, setFocusedDomain] = createSignal<{ maxDay: Date; minDay: Date } | null>(null);
      const rows: SerializedRow[] = [];
      const controller = createDateRangeController({
        domain: focusedDomain,
        generatedAt: new Date(2026, 5, 30, 12),
        rows: () => rows,
        defaultFrom: '2026-06-24',
        defaultTo: '2026-06-30',
        formatDate,
      });

      expect(controller.domain()).toBeNull();

      setFocusedDomain({
        minDay: new Date(2026, 5, 1),
        maxDay: new Date(2026, 5, 28),
      });

      expect(controller.inputValues()).toEqual({ from: '2026-06-01', to: '2026-06-28' });
      expect(controller.selectedIndexes()).toEqual([0, 27]);

      dispose();
    });
  });
});
