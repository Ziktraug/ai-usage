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
  const qualifications: string[] = [];
  if (group.unpriced > 0) {
    qualifications.push(`${PARTIALLY_MEASURED_LABEL} · ${fmtNum(group.unpricedFreshTokens)} unpriced fresh tokens`);
  }
  const unavailableQualification = unavailableCounterQualification(group);
  if (unavailableQualification) {
    qualifications.push(`${unavailableQualification} · API value is a lower bound`);
  }
  return {
    label: `${fmtNum(group.priced)} / ${fmtNum(group.sessions)} · ${fmtPct((group.priced / group.sessions) * 100)}`,
    qualification: qualifications.length > 0 ? qualifications.join(' · ') : null,
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
    return {
      group,
      label: breakdownModelLabel(group.key),
      priceState: modelPriceState(group),
      pricingCoverageLabel: pricingCoverage.label,
      pricingQualification: pricingCoverage.qualification,
      processedTokens,
      processedTokensLabel: unavailable ? '—' : fmtCompact(processedTokens),
      processedTokensQualification: unavailable ? USAGE_UNAVAILABLE_HINT : unavailableCounterQualification(group),
      processedTokensTitle: processedTokensTitle(group),
      shareLabel: unavailable ? '—' : fmtPct(group.costPercent),
      value: modelValue(group),
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
