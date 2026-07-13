import type { SerializedRow } from '@ai-usage/report-core/report-data';
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
  maxDay: Date;
  maxIndex: number;
  minDay: Date;
}

export interface DateRangeController {
  bounds: Accessor<DateBounds>;
  clear: () => void;
  domain: Accessor<DateRangeDomain | null>;
  inputValues: Accessor<{ from: string; to: string }>;
  label: Accessor<string>;
  mode: Accessor<DateRangeMode>;
  selectedIndexes: Accessor<[number, number]>;
  setCustom: (from: string, to: string) => void;
  setFromInput: (from: string) => void;
  setIndexes: (from: number, to: number) => void;
  setPreset: (mode: TimeRangePreset) => void;
  setRange: (mode: DateRangeMode, from?: string, to?: string) => void;
  setToInput: (to: string) => void;
  shiftSelection: (delta: number) => void;
}

export const createDateRangeController = (options: {
  generatedAt: Date | Accessor<Date>;
  rows: Accessor<SerializedRow[]>;
  domain?: Accessor<{ maxDay: Date; minDay: Date } | null>;
  defaultFrom: string;
  defaultTo: string;
  formatDate: (value: Date | string | null) => string;
  initialFrom?: string;
  initialMode?: DateRangeMode;
  initialTo?: string;
}): DateRangeController => {
  const generatedAt = () => (typeof options.generatedAt === 'function' ? options.generatedAt() : options.generatedAt);
  const [mode, setMode] = createSignal<DateRangeMode>(options.initialMode ?? 'all');
  const [customFrom, setCustomFrom] = createSignal(options.initialFrom ?? options.defaultFrom);
  const [customTo, setCustomTo] = createSignal(options.initialTo ?? options.defaultTo);

  let rowSpanCache: {
    maxTime: number | null;
    minTime: number | null;
    rows: SerializedRow[];
  } | null = null;
  const rowTimeSpan = () => {
    const rows = options.rows();
    const domain = options.domain?.();
    if (domain) {
      return {
        maxTime: domain.maxDay.getTime(),
        minTime: domain.minDay.getTime(),
        rows,
      };
    }
    if (rowSpanCache?.rows === rows) {
      return rowSpanCache;
    }

    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      const time = rowTime(row);
      if (time == null) {
        continue;
      }
      minTime = Math.min(minTime, time);
      maxTime = Math.max(maxTime, time);
    }

    rowSpanCache = Number.isFinite(minTime) ? { rows, minTime, maxTime } : { rows, minTime: null, maxTime: null };
    return rowSpanCache;
  };

  let boundsCache: {
    customFrom: string;
    customTo: string;
    generatedAtTime: number;
    latestRowTime: number | null;
    mode: DateRangeMode;
    value: DateBounds;
  } | null = null;
  const bounds = () => {
    const currentMode = mode();
    const currentFrom = customFrom();
    const currentTo = customTo();
    const currentGeneratedAt = generatedAt();
    const generatedAtTime = currentGeneratedAt.getTime();
    const latestRowTime = currentMode === 'today' ? rowTimeSpan().maxTime : null;
    if (
      boundsCache &&
      boundsCache.mode === currentMode &&
      boundsCache.customFrom === currentFrom &&
      boundsCache.customTo === currentTo &&
      boundsCache.generatedAtTime === generatedAtTime &&
      boundsCache.latestRowTime === latestRowTime
    ) {
      return boundsCache.value;
    }

    const referenceDate =
      currentMode === 'today' && latestRowTime != null && latestRowTime > generatedAtTime
        ? new Date(latestRowTime)
        : currentGeneratedAt;
    const value = dateBoundsForRange(currentMode, referenceDate, currentFrom, currentTo);
    boundsCache = {
      customFrom: currentFrom,
      customTo: currentTo,
      generatedAtTime,
      latestRowTime,
      mode: currentMode,
      value,
    };
    return value;
  };

  const finiteTime = (date: Date | null) => {
    const time = date?.getTime();
    return time != null && Number.isFinite(time) ? time : null;
  };

  let domainCache: {
    boundsFrom: number | null;
    boundsTo: number | null;
    rowMaxTime: number | null;
    rowMinTime: number | null;
    rows: SerializedRow[];
    value: DateRangeDomain | null;
  } | null = null;
  const domain = (): DateRangeDomain | null => {
    const rowSpan = rowTimeSpan();
    const rows = rowSpan.rows;
    const currentBounds = bounds();
    const boundsFrom = finiteTime(currentBounds.from);
    const boundsTo = finiteTime(currentBounds.to);
    if (
      domainCache &&
      domainCache.rows === rows &&
      domainCache.boundsFrom === boundsFrom &&
      domainCache.boundsTo === boundsTo &&
      domainCache.rowMinTime === rowSpan.minTime &&
      domainCache.rowMaxTime === rowSpan.maxTime
    ) {
      return domainCache.value;
    }

    if (rowSpan.minTime == null || rowSpan.maxTime == null) {
      domainCache = {
        boundsFrom,
        boundsTo,
        rowMaxTime: rowSpan.maxTime,
        rowMinTime: rowSpan.minTime,
        rows,
        value: null,
      };
      return null;
    }

    const boundTimes = [boundsFrom, boundsTo].filter((time): time is number => time != null);
    const times = [rowSpan.minTime, rowSpan.maxTime, ...boundTimes];
    const minDay = startOfDay(new Date(Math.min(...times)));
    const maxDay = startOfDay(new Date(Math.max(...times)));

    const value = {
      minDay,
      maxDay,
      maxIndex: Math.max(0, dateIndexFrom(maxDay, minDay)),
    };
    domainCache = {
      boundsFrom,
      boundsTo,
      rowMaxTime: rowSpan.maxTime,
      rowMinTime: rowSpan.minTime,
      rows,
      value,
    };
    return value;
  };

  const selectedIndexes = (): [number, number] => {
    const currentDomain = domain();
    if (!currentDomain) {
      return [0, 0];
    }
    const currentBounds = bounds();
    const from = currentBounds.from ? dateIndexFrom(currentBounds.from, currentDomain.minDay) : 0;
    const to = currentBounds.to ? dateIndexFrom(currentBounds.to, currentDomain.minDay) : currentDomain.maxIndex;
    return normalizeDateIndexRange([from, to], currentDomain.maxIndex);
  };

  const inputValues = () => {
    const currentDomain = domain();
    if (!currentDomain) {
      return { from: customFrom(), to: customTo() };
    }
    const [from, to] = selectedIndexes();
    return {
      from: toDateInputValue(dateFromIndex(currentDomain.minDay, from)),
      to: toDateInputValue(dateFromIndex(currentDomain.minDay, to)),
    };
  };

  const label = () => {
    if (mode() === 'all') {
      return 'all dates';
    }
    if (mode() === 'today') {
      return 'today';
    }
    if (mode() === '7d') {
      return 'last 7 days';
    }
    if (mode() === '30d') {
      return 'last 30 days';
    }
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

  const setRange = (nextMode: DateRangeMode, from?: string, to?: string) => {
    setMode(nextMode);
    if (nextMode !== 'custom') {
      return;
    }
    setCustomFrom(from ?? '');
    setCustomTo(to ?? '');
  };

  const setIndexes = (from: number, to: number) => {
    const currentDomain = domain();
    if (!currentDomain) {
      return;
    }
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
    setRange,
    setPreset: setMode,
    setCustom,
    setFromInput,
    setToInput,
    setIndexes,
    shiftSelection: (delta: number) => {
      const currentDomain = domain();
      if (!currentDomain) {
        return;
      }
      const [from, to] = selectedIndexes();
      const span = to - from;
      const nextFrom = Math.min(Math.max(from + delta, 0), Math.max(0, currentDomain.maxIndex - span));
      setIndexes(nextFrom, nextFrom + span);
    },
    clear: () => setMode('all'),
  };
};
