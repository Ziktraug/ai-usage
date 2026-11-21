import type {
  FocusedDateDomain,
  FocusedOverviewResult,
  FocusedReportQueryScope,
} from '@ai-usage/report-core/focused-report-query';
import type { SessionQueryRange } from '@ai-usage/report-core/session-query';
import type { DateRangeMode, TimeRangePreset } from '../../../../date-range';
import { periodRecordedHistory } from '../../../foundation/dashboard/dashboard-model';
import type { DashboardDateRangeSearch } from '../../../foundation/dashboard/dashboard-search';
import { rangeBounds } from '../range/report-range-model';
import type { ExecutiveOverviewModelInput } from './executive-overview-model';

type AnsweredQuery = Pick<FocusedReportQueryScope, 'filters' | 'range'>;

/**
 * What the Overview result on screen answers. A destination keeps its last committed result on
 * screen while a new period or filter set loads, and after that refresh fails, so the URL can name
 * another period than the figures do. Everything that describes the figures follows this scope.
 */
export interface OverviewResultScope {
  /** The filters and the range, as instants, that the server aggregated the result over. */
  readonly query: AnsweredQuery;
  /** The selection mode that names that range in prose. */
  readonly rangeMode: DateRangeMode;
  /** Earliest dated activity of the result's revision under no filter; null when none is dated. */
  readonly unfilteredFirst: string | null;
}

export interface OverviewResultScopeInput {
  /** The query the committed result answers. */
  readonly answered: AnsweredQuery;
  /** The generation instant every report query of this destination was resolved from. */
  readonly queryGeneratedAt: string;
  /** The selection in the URL and the range it resolves to. */
  readonly requested: { readonly range: SessionQueryRange; readonly selection: DashboardDateRangeSearch };
  /** The date domain of the committed result's revision under no filter (the bootstrap support's). */
  readonly revisionDateDomain: FocusedDateDomain | null;
}

const PRESETS: readonly TimeRangePreset[] = ['today', '7d', '30d', '90d', 'all'];

const sameRange = (left: SessionQueryRange, right: SessionQueryRange): boolean =>
  left.from === right.from && left.to === right.to;

/** The instants a selection resolves to, as the report queries are built (`reportDestinationForSearch`). */
export const queriedRangeFor = (selection: DashboardDateRangeSearch, generatedAt: Date): SessionQueryRange => {
  const { from, to } = rangeBounds(selection, generatedAt);
  return { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null };
};

/**
 * The mode that names the answered range. It is the requested selection's once the result answers
 * it; until then, the preset that resolves to the same instants, or a custom period.
 */
const answeredRangeMode = ({ answered, queryGeneratedAt, requested }: OverviewResultScopeInput): DateRangeMode => {
  if (sameRange(answered.range, requested.range)) {
    return requested.selection.mode;
  }
  const generatedAt = new Date(queryGeneratedAt);
  return PRESETS.find((mode) => sameRange(queriedRangeFor({ mode }, generatedAt), answered.range)) ?? 'custom';
};

export const overviewResultScope = (input: OverviewResultScopeInput): OverviewResultScope => ({
  query: input.answered,
  rangeMode: answeredRangeMode(input),
  unfilteredFirst: input.revisionDateDomain?.first ?? null,
});

const instant = (value: string | null): Date | null => (value === null ? null : new Date(value));

/**
 * The period the executive model compares, taken from the query the result answers rather than from
 * the URL. The server ends an open range at its revision's generation instant, so the result's own
 * instant closes it here too.
 */
export const executivePeriodFor = (
  scope: OverviewResultScope,
  result: Pick<FocusedOverviewResult, 'dateDomain' | 'metadata'>,
): Pick<ExecutiveOverviewModelInput, 'comparisonPeriod' | 'periodInProgress' | 'rangeMode'> => {
  const generatedAt = new Date(result.metadata.generatedAt);
  const bounds = { from: instant(scope.query.range.from), to: instant(scope.query.range.to) };
  return {
    comparisonPeriod: {
      bounds,
      generatedAt,
      recordedHistory: periodRecordedHistory({
        filteredFirst: result.dateDomain?.first ?? null,
        filters: scope.query.filters,
        unfilteredFirst: scope.unfilteredFirst,
      }),
    },
    periodInProgress: bounds.to !== null && bounds.to.getTime() > generatedAt.getTime(),
    rangeMode: scope.rangeMode,
  };
};
