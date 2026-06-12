import type { SerializedRow } from '@ai-usage/core/report-data';
import { type Accessor, createSignal } from 'solid-js';
import {
  type DateBounds,
  type DateRangeMode,
  dateBoundsForRange,
  dateFromIndex,
  dateIndexFrom,
  normalizeDateIndexRange,
  parseLocalDate,
  rowTime,
  startOfDay,
  type TimeRangePreset,
  toDateInputValue,
} from './date-range';

export interface DateRangeDomain {
  minDay: Date;
  maxDay: Date;
  maxIndex: number;
}

export interface DateRangeController {
  mode: Accessor<DateRangeMode>;
  bounds: Accessor<DateBounds>;
  domain: Accessor<DateRangeDomain | null>;
  inputValues: Accessor<{ from: string; to: string }>;
  label: Accessor<string>;
  selectedIndexes: Accessor<[number, number]>;
  setPreset: (mode: TimeRangePreset) => void;
  setCustom: (from: string, to: string) => void;
  setFromInput: (from: string) => void;
  setToInput: (to: string) => void;
  setIndexes: (from: number, to: number) => void;
  shiftSelection: (delta: number) => void;
  clear: () => void;
}

export const createDateRangeController = (options: {
  generatedAt: Date;
  rows: Accessor<SerializedRow[]>;
  defaultFrom: string;
  defaultTo: string;
  formatDate: (value: Date | string | null) => string;
}): DateRangeController => {
  const [mode, setMode] = createSignal<DateRangeMode>('all');
  const [customFrom, setCustomFrom] = createSignal(options.defaultFrom);
  const [customTo, setCustomTo] = createSignal(options.defaultTo);

  const bounds = () => dateBoundsForRange(mode(), options.generatedAt, customFrom(), customTo());

  const domain = (): DateRangeDomain | null => {
    const datedTimes = options
      .rows()
      .map(rowTime)
      .filter((time): time is number => time != null);
    if (!datedTimes.length) return null;

    const boundTimes = [bounds().from?.getTime(), bounds().to?.getTime()].filter(
      (time): time is number => time != null && Number.isFinite(time),
    );
    const times = [...datedTimes, ...boundTimes];
    const minDay = startOfDay(new Date(Math.min(...times)));
    const maxDay = startOfDay(new Date(Math.max(...times)));

    return {
      minDay,
      maxDay,
      maxIndex: Math.max(0, dateIndexFrom(maxDay, minDay)),
    };
  };

  const selectedIndexes = (): [number, number] => {
    const currentDomain = domain();
    if (!currentDomain) return [0, 0];
    const currentBounds = bounds();
    const from = currentBounds.from ? dateIndexFrom(currentBounds.from, currentDomain.minDay) : 0;
    const to = currentBounds.to ? dateIndexFrom(currentBounds.to, currentDomain.minDay) : currentDomain.maxIndex;
    return normalizeDateIndexRange([from, to], currentDomain.maxIndex);
  };

  const inputValues = () => {
    const currentDomain = domain();
    if (!currentDomain) return { from: customFrom(), to: customTo() };
    const [from, to] = selectedIndexes();
    return {
      from: toDateInputValue(dateFromIndex(currentDomain.minDay, from)),
      to: toDateInputValue(dateFromIndex(currentDomain.minDay, to)),
    };
  };

  const label = () => {
    if (mode() === 'all') return 'all dates';
    if (mode() === 'today') return 'today';
    if (mode() === '7d') return 'last 7 days';
    if (mode() === '30d') return 'last 30 days';
    const values = inputValues();
    return `${values.from ? options.formatDate(parseLocalDate(values.from)) : 'start'} – ${
      values.to ? options.formatDate(parseLocalDate(values.to, true)) : 'end'
    }`;
  };

  const setCustom = (from: string, to: string) => {
    setMode('custom');
    setCustomFrom(from);
    setCustomTo(to);
  };

  const setIndexes = (from: number, to: number) => {
    const currentDomain = domain();
    if (!currentDomain) return;
    const [nextFrom, nextTo] = normalizeDateIndexRange([from, to], currentDomain.maxIndex);
    setCustom(
      toDateInputValue(dateFromIndex(currentDomain.minDay, nextFrom)),
      toDateInputValue(dateFromIndex(currentDomain.minDay, nextTo)),
    );
  };

  const setFromInput = (from: string) => {
    const current = inputValues();
    const fromDate = parseLocalDate(from);
    const toDate = parseLocalDate(current.to);
    setCustom(from, fromDate && toDate && fromDate > toDate ? from : current.to);
  };

  const setToInput = (to: string) => {
    const current = inputValues();
    const fromDate = parseLocalDate(current.from);
    const toDate = parseLocalDate(to);
    setCustom(fromDate && toDate && toDate < fromDate ? to : current.from, to);
  };

  return {
    mode,
    bounds,
    domain,
    inputValues,
    label,
    selectedIndexes,
    setPreset: setMode,
    setCustom,
    setFromInput,
    setToInput,
    setIndexes,
    shiftSelection: (delta: number) => {
      const currentDomain = domain();
      if (!currentDomain) return;
      const [from, to] = selectedIndexes();
      const span = to - from;
      const nextFrom = Math.min(Math.max(from + delta, 0), Math.max(0, currentDomain.maxIndex - span));
      setIndexes(nextFrom, nextFrom + span);
    },
    clear: () => setMode('all'),
  };
};
