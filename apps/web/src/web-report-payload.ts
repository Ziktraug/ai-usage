import type { UsageReportPayload } from '@ai-usage/report-core/report-data';
import { parseReportDatasets } from '@ai-usage/report-core/datasets';

export type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

export type WebReportPayload = Omit<UsageReportPayload, 'datasets' | 'facets' | 'tableRows'> & {
  datasets?: Record<string, JsonValue>;
  facets?: Record<string, JsonValue>;
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
};

const isJsonRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);

export const toWebReportPayload = (payload: UsageReportPayload): WebReportPayload => {
  const { datasets, facets, tableRows: _tableRows, ...webPayload } = payload;
  if (datasets !== undefined && !isJsonRecord(datasets)) {
    throw new Error('Report datasets must contain only JSON-serializable values');
  }
  if (facets !== undefined && !isJsonRecord(facets)) {
    throw new Error('Report facets must contain only JSON-serializable values');
  }
  return {
    ...webPayload,
    ...(datasets === undefined ? {} : { datasets }),
    ...(facets === undefined ? {} : { facets }),
  };
};

export const toExportReportPayload = (payload: WebReportPayload): UsageReportPayload => {
  const limit = payload.filters.limit;
  const datasets = parseReportDatasets(payload.datasets);
  return {
    ...payload,
    ...(datasets === undefined ? {} : { datasets }),
    tableRows: limit ? payload.rows.slice(0, limit) : payload.rows,
  };
};
