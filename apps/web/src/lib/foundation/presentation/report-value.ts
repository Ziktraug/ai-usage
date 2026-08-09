import { modelGroupKey } from '@ai-usage/report-core/model-identity';
import {
  type ApiPriceMeasurement,
  apiPriceMeasurement,
  combineApiPriceMeasurements,
  PARTIALLY_MEASURED_LABEL,
  partiallyMeasuredApiPriceDescription,
} from '@ai-usage/report-core/provenance';
import { enrichSessionPresentationRow, type SessionPresentationRow } from '@ai-usage/report-core/session-query';
import { usageRowApiPriceMeasurement } from '@ai-usage/report-core/usage-row';
import { fmtCompact, fmtMoney } from './format';

export const UNKNOWN_PRICE_HINT = 'No pricing data for this model';
export const PARTIAL_PRICE_HINT = 'Known API-value subtotal; one or more model prices are unavailable';
export const USAGE_UNAVAILABLE_HINT = 'Session found in prompt history; detailed local token counters are missing';

// Harnesses report the same upstream model under different ids and mode suffixes
// (gpt-5.4 vs openai/gpt-5.4-high); group on the shared base model.
export const normalizeModelKey = (model: string): string => modelGroupKey(model);

// "(OC)" is collector shorthand for sessions proxied through OpenCode.
const OPENCODE_PROVIDER_SUFFIX = /\s*\(OC\)\s*$/;

export const providerLabel = (provider: string): string =>
  provider.replace(OPENCODE_PROVIDER_SUFFIX, ' · via OpenCode');

export type DashboardRow = SessionPresentationRow;

export interface ApiValuePresentation {
  label: string;
  status: 'exact' | 'lower-bound' | 'unknown';
  title: string;
}

export const apiValuePresentation = (row: { costApprox: number; costKnown: boolean }): ApiValuePresentation => {
  if (row.costKnown) {
    return {
      label: fmtMoney(row.costApprox),
      status: 'exact',
      title: 'Estimated API-equivalent value at standard prices',
    };
  }
  if (row.costApprox > 0) {
    return { label: `≥ ${fmtMoney(row.costApprox)}`, status: 'lower-bound', title: PARTIAL_PRICE_HINT };
  }
  return { label: '—', status: 'unknown', title: UNKNOWN_PRICE_HINT };
};

export const aggregateApiValuePresentation = (measurement: ApiPriceMeasurement): ApiValuePresentation => {
  if (measurement.state !== 'partially measured') {
    return {
      label: fmtMoney(measurement.knownCost),
      status: 'exact',
      title: 'Estimated API-equivalent value at standard prices',
    };
  }
  return {
    label: measurement.knownCost > 0 ? `≥ ${fmtMoney(measurement.knownCost)}` : '—',
    status: measurement.knownCost > 0 ? 'lower-bound' : 'unknown',
    title: partiallyMeasuredApiPriceDescription(fmtCompact(measurement.unpricedFreshTokens)),
  };
};

export const aggregateApiPriceProvenance = (measurement: ApiPriceMeasurement) =>
  measurement.state === 'partially measured'
    ? {
        description: partiallyMeasuredApiPriceDescription(fmtCompact(measurement.unpricedFreshTokens)),
        label: PARTIALLY_MEASURED_LABEL,
        severity: 'warning' as const,
      }
    : null;

export const enrichReportRow = enrichSessionPresentationRow;

export const rowKey = (row: DashboardRow): string => row.rowId;

export interface ReportSummary {
  actualCost: number;
  cacheRead: number;
  cacheWrite: number;
  costQuota: number;
  fresh: number;
  meanCost: number;
  pricedSessions: number;
  priceMeasurement: ApiPriceMeasurement;
  rtkInput: number;
  rtkOutput: number;
  rtkSaved: number;
  rtkSessions: number;
  sessionCount: number;
  tokIn: number;
  tokOut: number;
  tools: number;
  totalCost: number;
  turns: number;
  unknownActual: number;
}

const createReportSummary = (): ReportSummary => ({
  actualCost: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costQuota: 0,
  fresh: 0,
  meanCost: 0,
  priceMeasurement: apiPriceMeasurement({ costKnown: true, freshTokens: 0, knownCost: 0 }),
  pricedSessions: 0,
  rtkInput: 0,
  rtkOutput: 0,
  rtkSaved: 0,
  rtkSessions: 0,
  sessionCount: 0,
  tokIn: 0,
  tokOut: 0,
  tools: 0,
  totalCost: 0,
  turns: 0,
  unknownActual: 0,
});

export const buildReportSummary = (
  rows: readonly DashboardRow[],
  acceptsRow: (row: DashboardRow) => boolean,
): ReportSummary => {
  const summary = createReportSummary();
  const priceMeasurements: ApiPriceMeasurement[] = [];
  let fullyPricedCost = 0;

  for (const row of rows) {
    if (!acceptsRow(row)) {
      continue;
    }
    summary.sessionCount += 1;
    priceMeasurements.push(usageRowApiPriceMeasurement(row));
    if (row.costKnown) {
      fullyPricedCost += row.costApprox;
      summary.pricedSessions += 1;
    }
    summary.actualCost += row.costActual ?? 0;
    summary.costQuota += row.costQuota ?? 0;
    if (row.costActual == null) {
      summary.unknownActual += 1;
    }
    summary.fresh += row.freshTokens;
    summary.cacheRead += row.tokCr;
    summary.cacheWrite += row.tokCw;
    summary.tokIn += row.tokIn;
    summary.tokOut += row.tokOut;
    summary.rtkSaved += row.rtkSavedTokens ?? 0;
    summary.rtkInput += row.rtkInputTokens ?? 0;
    summary.rtkOutput += row.rtkOutputTokens ?? 0;
    if (row.rtkSavedTokens) {
      summary.rtkSessions += 1;
    }
    summary.turns += row.turns;
    summary.tools += row.tools;
  }

  summary.priceMeasurement = combineApiPriceMeasurements(priceMeasurements);
  summary.totalCost = summary.priceMeasurement.knownCost;
  summary.meanCost = fullyPricedCost / (summary.pricedSessions || 1);
  return summary;
};
