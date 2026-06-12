import { describe, expect, test } from 'bun:test';
import type { SerializedRow } from '@ai-usage/core/report-data';
import { createRoot } from 'solid-js';
import { toDateInputValue } from './date-range';
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
});
