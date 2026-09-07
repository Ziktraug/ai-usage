import { type AnalyticsGroup, processedTokensForAnalytics } from '@ai-usage/report-core/analytics';
import type { AnalyticsExportRow } from '@ai-usage/report-core/csv';
import { type ApiPriceMeasurementState, PARTIALLY_MEASURED_LABEL } from '@ai-usage/report-core/provenance';
import type { BreakdownSort } from '../../../../dashboard-search';
import {
  breakdownBarPresentation,
  breakdownModelLabel,
  breakdownPriceStateLabel,
  filterAndSortBreakdownGroups,
} from '../../../../group-panel-presentation';
import { fmtCompact, fmtCount, fmtMoney, fmtNum, fmtPct } from '../../../foundation/presentation/format';
import {
  type ApiValuePresentation,
  aggregateApiValuePresentation,
  USAGE_UNAVAILABLE_HINT,
} from '../../../foundation/presentation/report-value';

export interface BreakdownRowView {
  readonly ariaLabel: string;
  readonly cacheLabel: string;
  readonly freshLabel: string;
  readonly freshTitle: string;
  readonly group: AnalyticsGroup;
  readonly label: string;
  readonly priceState: 'measured' | 'partially measured' | 'unavailable' | 'zero';
  readonly pricingCoverage: string;
  readonly sessionSummary: string;
  readonly valueLabel: string;
  readonly valueTitle: string;
  readonly widthPercent: number | null;
}

export interface ModelAnalysisRowView {
  readonly group: AnalyticsGroup;
  readonly label: string;
  readonly priceState: BreakdownRowView['priceState'];
  readonly pricingCoverageLabel: string;
  readonly pricingQualification: string | null;
  readonly processedTokens: number;
  readonly processedTokensLabel: string;
  readonly processedTokensQualification: string | null;
  readonly processedTokensTitle: string;
  readonly shareLabel: string;
  readonly value: ApiValuePresentation;
  readonly valuePerMillion: ApiValuePresentation;
  /** Visible note under the API value when its counters, not its rates, make it a lower bound. */
  readonly valueQualification: string | null;
}

const usageUnavailableOnly = (group: AnalyticsGroup): boolean =>
  group.sessions > 0 && group.usageUnavailable === group.sessions;

const missingCounterSubtotalTitle = (): string => `Known API-value subtotal. ${USAGE_UNAVAILABLE_HINT}`;

const PROCESSED_TOKENS_DEFINITION = 'Processed tokens: cache read + cache write + input + output.';

const modelPriceState = (group: AnalyticsGroup): BreakdownRowView['priceState'] => {
  if (usageUnavailableOnly(group)) {
    return 'unavailable';
  }
  if (group.unpriced > 0 || group.usageUnavailable > 0) {
    return 'partially measured';
  }
  return group.costSum === 0 ? 'zero' : 'measured';
};

const processedTokensTitle = (group: AnalyticsGroup): string => {
  if (usageUnavailableOnly(group)) {
    return USAGE_UNAVAILABLE_HINT;
  }
  if (group.usageUnavailable > 0) {
    return `${PROCESSED_TOKENS_DEFINITION} Known subtotal; ${USAGE_UNAVAILABLE_HINT}`;
  }
  return PROCESSED_TOKENS_DEFINITION;
};

const modelValueState = (group: AnalyticsGroup): ApiPriceMeasurementState => {
  if (group.unpriced > 0) {
    return 'partially measured';
  }
  return group.costSum === 0 ? 'zero' : 'measured';
};

export const projectBreakdownRow = (group: AnalyticsGroup, label: string, maxKnownCost: number): BreakdownRowView => {
  const unavailable = usageUnavailableOnly(group);
  const presentation = breakdownBarPresentation({
    knownCost: group.costSum,
    maxKnownCost,
    unpricedCount: group.unpriced,
    usageUnavailable: unavailable,
  });
  const value = aggregateApiValuePresentation({
    knownCost: group.costSum,
    state: presentation.state === 'partially measured' ? 'partially measured' : 'measured',
    unpricedFreshTokens: group.unpricedFreshTokens,
  });
  return {
    ariaLabel: `${breakdownPriceStateLabel(presentation.state)} API-value bar`,
    cacheLabel: unavailable ? '— cache' : `${fmtPct(group.cacheHitPct)} cache`,
    freshLabel: unavailable ? '— fresh' : `${fmtCompact(group.fresh)} fresh`,
    freshTitle: unavailable ? USAGE_UNAVAILABLE_HINT : `${fmtNum(group.fresh)} fresh tokens`,
    group,
    label,
    priceState: presentation.state,
    pricingCoverage:
      group.unpriced > 0
        ? ` · ${PARTIALLY_MEASURED_LABEL} (${fmtNum(group.priced)}/${fmtNum(group.sessions)} fully priced)`
        : '',
    sessionSummary: `${fmtCount(group.sessions, 'session')}${
      group.ambiguous ? ` · ${fmtNum(group.ambiguous)} ambiguous` : ''
    }`,
    valueLabel: unavailable ? '—' : value.label,
    valueTitle: unavailable ? USAGE_UNAVAILABLE_HINT : value.title,
    widthPercent: presentation.widthPercent,
  };
};

export const breakdownRows = (
  groups: readonly AnalyticsGroup[],
  query: string,
  sort: BreakdownSort,
  dimension: 'harnesses' | 'models' | 'providers',
): readonly BreakdownRowView[] => {
  const labelFor = (group: AnalyticsGroup): string =>
    dimension === 'models' ? breakdownModelLabel(group.key) : group.key;
  const visible = filterAndSortBreakdownGroups(groups, query, sort, labelFor);
  const maxKnownCost = Math.max(0, ...visible.map((group) => group.costSum));
  return visible.map((group) => projectBreakdownRow(group, labelFor(group), maxKnownCost));
};

const modelValue = (group: AnalyticsGroup): ApiValuePresentation => {
  if (usageUnavailableOnly(group)) {
    return { label: '—', status: 'unknown', title: USAGE_UNAVAILABLE_HINT };
  }
  if (group.usageUnavailable > 0) {
    return {
      label: group.costSum > 0 ? `≥ ${fmtMoney(group.costSum)}` : '—',
      status: group.costSum > 0 ? 'lower-bound' : 'unknown',
      title: missingCounterSubtotalTitle(),
    };
  }
  return aggregateApiValuePresentation({
    knownCost: group.costSum,
    state: modelValueState(group),
    unpricedFreshTokens: group.unpricedFreshTokens,
  });
};

const modelValuePerMillion = (group: AnalyticsGroup, processedTokens: number): ApiValuePresentation => {
  const definition = 'Known API-equivalent value divided by processed tokens, multiplied by 1,000,000.';
  if (group.usageUnavailable > 0) {
    return { label: '—', status: 'unknown', title: USAGE_UNAVAILABLE_HINT };
  }
  if (processedTokens === 0) {
    return {
      label: '—',
      status: 'unknown',
      title: 'API value / 1M tokens is unavailable because this model has zero processed tokens.',
    };
  }
  const value = (group.costSum / processedTokens) * 1_000_000;
  if (group.unpriced > 0) {
    return {
      label: `≥ ${fmtMoney(value)}`,
      status: 'lower-bound',
      title: `${modelValue(group).title} ${definition}`,
    };
  }
  return {
    label: fmtMoney(value),
    status: 'exact',
    title: definition,
  };
};

const unavailableCounterQualification = (group: AnalyticsGroup): string | null => {
  if (group.usageUnavailable <= 0) {
    return null;
  }
  return `${fmtNum(group.usageUnavailable)} of ${fmtNum(group.sessions)} sessions without token counters`;
};

const pricingCoveragePresentation = (
  group: AnalyticsGroup,
): { readonly label: string; readonly qualification: string | null } => {
  if (usageUnavailableOnly(group)) {
    return { label: '—', qualification: USAGE_UNAVAILABLE_HINT };
  }
  if (group.sessions === 0) {
    return { label: '0 / 0 · —', qualification: 'Pricing coverage unavailable · no model sessions' };
  }
  // Rates known and counters present are two different facts. This column answers the first; the
  // missing-counter note lives under the values it actually bounds (API value, processed tokens).
  return {
    label: `${fmtNum(group.priced)} / ${fmtNum(group.sessions)} · ${fmtPct((group.priced / group.sessions) * 100)}`,
    qualification:
      group.unpriced > 0
        ? `${PARTIALLY_MEASURED_LABEL} · ${fmtNum(group.unpricedFreshTokens)} unpriced fresh tokens`
        : null,
  };
};

export const modelAnalysisRows = (
  groups: readonly AnalyticsGroup[],
  query: string,
  sort: BreakdownSort,
): readonly ModelAnalysisRowView[] => {
  const visible = filterAndSortBreakdownGroups(groups, query, sort, (group) => breakdownModelLabel(group.key));
  return visible.map((group) => {
    const processedTokens = processedTokensForAnalytics(group);
    const unavailable = usageUnavailableOnly(group);
    const pricingCoverage = pricingCoveragePresentation(group);
    const countersMissing = !unavailable && group.usageUnavailable > 0;
    const counterQualification = unavailableCounterQualification(group);
    return {
      group,
      label: breakdownModelLabel(group.key),
      priceState: modelPriceState(group),
      pricingCoverageLabel: pricingCoverage.label,
      pricingQualification: pricingCoverage.qualification,
      processedTokens,
      // A missing counter bounds the token total the same way it bounds the value: mark the number,
      // state the reason once, under the value.
      processedTokensLabel: unavailable ? '—' : `${countersMissing ? '≥ ' : ''}${fmtCompact(processedTokens)}`,
      processedTokensQualification: unavailable ? USAGE_UNAVAILABLE_HINT : null,
      processedTokensTitle: processedTokensTitle(group),
      shareLabel: unavailable ? '—' : fmtPct(group.costPercent),
      value: modelValue(group),
      valueQualification:
        countersMissing && counterQualification ? `${counterQualification} · API value is a lower bound` : null,
      valuePerMillion: modelValuePerMillion(group, processedTokens),
    };
  });
};

export const modelAnalysisEmptyMessage = (query: string): string =>
  query.trim() ? 'No breakdown rows match this search' : 'No models';

export const analyticsExportRows = (
  rows: readonly Pick<BreakdownRowView, 'group' | 'label'>[],
): readonly AnalyticsExportRow[] => rows.map(({ group, label }) => ({ group, label }));

export { breakdownLabelMatchesSearch } from '../../../../group-panel-presentation';

export interface ModelComparisonBar {
  readonly key: string;
  readonly label: string;
  /** True when the plotted measure is itself a lower bound; the bar is drawn hatched. */
  readonly lowerBound: boolean;
  readonly measureLabel: string;
  /** Position in the sorted list; drives the ranked model palette so colours stay stable per rank. */
  readonly rank: number;
  /** Share of the largest known measure, 0–100; null when the measure is unknown for this model. */
  readonly widthPercent: number | null;
}

// Sessions are counted even when their token counters are missing; only the token-derived measures
// become unknown for a counterless model (ADR 0016: qualify per metric, not per row).
const comparisonMeasure = (row: ModelAnalysisRowView, sort: BreakdownSort): number | null => {
  if (sort === 'sessions') {
    return row.group.sessions;
  }
  if (usageUnavailableOnly(row.group)) {
    return null;
  }
  if (sort === 'tokens') {
    return row.processedTokens;
  }
  return row.value.status === 'unknown' ? null : row.group.costSum;
};

const comparisonLowerBound = (row: ModelAnalysisRowView, sort: BreakdownSort): boolean => {
  if (sort === 'sessions') {
    return false;
  }
  if (sort === 'tokens') {
    return row.processedTokensLabel.startsWith('≥');
  }
  return row.value.status === 'lower-bound';
};

// A measured zero is a zero-length bar, not an unknown: null is reserved for values nobody knows.
const comparisonWidth = (measure: number | null, max: number): number | null => {
  if (measure === null) {
    return null;
  }
  return max === 0 ? 0 : (measure / max) * 100;
};

const comparisonMeasureLabel = (row: ModelAnalysisRowView, sort: BreakdownSort): string => {
  switch (sort) {
    case 'sessions':
      return `${fmtNum(row.group.sessions)} ${row.group.sessions === 1 ? 'session' : 'sessions'}`;
    case 'tokens':
      return row.processedTokensLabel;
    default:
      return row.value.label;
  }
};

/**
 * The visual half of the Models table: one bar per model for the measure the table is sorted by,
 * every model with its own colour, no rollup. Bars reuse the table rows, so the numbers are the
 * canonical ones (ADR 0018); a lower-bound measure hatches its bar instead of pretending precision,
 * and an unknown measure keeps its row with no bar at all.
 */
export const modelComparisonBars = (
  rows: readonly ModelAnalysisRowView[],
  sort: BreakdownSort,
): readonly ModelComparisonBar[] => {
  const measures = rows.map((row) => comparisonMeasure(row, sort));
  const max = Math.max(0, ...measures.map((measure) => measure ?? 0));
  return rows.map((row, index) => {
    const measure = measures[index] ?? null;
    return {
      key: row.group.key,
      label: row.label,
      lowerBound: comparisonLowerBound(row, sort),
      measureLabel: comparisonMeasureLabel(row, sort),
      rank: index,
      widthPercent: comparisonWidth(measure, max),
    };
  });
};
