import type { MetricPeriodComparison, PeriodWindow } from '../../../../dashboard-model';
import { fmtDateOnly, fmtPct } from '../../../foundation/presentation/format';

/** How one metric is worded when it is compared with the previous period. */
export interface PeriodComparisonMetricCopy {
  readonly format: (value: number) => string;
  /** The measure in running text, such as "processed tokens". */
  readonly noun: string;
  /** What an incomplete reading lacks, completing "only partly …". */
  readonly partly: string;
}

export interface PeriodComparisonPresentation {
  /** Present only with a percentage, while the selected period is still in progress. */
  readonly caveat: string | null;
  /** The on-demand explanation, one line each: the previous window, its value, where history starts. */
  readonly explanation: readonly string[];
  /** The signed change, such as "+12%" or "−8.5%"; null whenever no percentage exists. */
  readonly figure: string | null;
  readonly outcome: MetricPeriodComparison;
  /** One sentence that stands on its own. */
  readonly statement: string;
}

const IN_PROGRESS_CAVEAT = 'This period is still in progress, so the comparison is provisional.';
const NO_PREVIOUS_PERIOD = 'No previous period exists before the full recorded range.';
const PARTLY_RECORDED = 'No percentage: the previous period is only partly recorded.';

/** The previous window and, when it was measured, its value: the same filters and the same measure. */
const previousPeriod = (window: PeriodWindow, value?: string): string => {
  const first = fmtDateOnly(window.from);
  const last = fmtDateOnly(window.to);
  const dates = first === last ? first : `${first} – ${last}`;
  return `Previous period, same filters: ${value === undefined ? dates : `${dates} · ${value}`}`;
};

const historyStart = (recordedFirst: Date, subject = 'Recorded history'): string =>
  `${subject} starts ${fmtDateOnly(recordedFirst)} under the current filters.`;

type Explanation = Pick<PeriodComparisonPresentation, 'caveat' | 'explanation' | 'figure' | 'statement'>;

const withoutPercentage = (statement: string, explanation: readonly string[]): Explanation => ({
  caveat: null,
  explanation,
  figure: null,
  statement,
});

const explain = (outcome: MetricPeriodComparison, copy: PeriodComparisonMetricCopy): Explanation => {
  switch (outcome.kind) {
    case 'change': {
      // An unchanged value keeps the wording the headline always had: "0% higher".
      const lower = outcome.percent < 0;
      const label = fmtPct(Math.abs(outcome.percent));
      return {
        caveat: outcome.provisional ? IN_PROGRESS_CAVEAT : null,
        explanation: [previousPeriod(outcome.window, `${copy.format(outcome.previous)} ${copy.noun}`)],
        figure: `${lower ? '−' : '+'}${label}`,
        statement: `${label} ${lower ? 'lower' : 'higher'} than the previous equal-length period.`,
      };
    }
    case 'zero-baseline':
      return withoutPercentage(`No percentage: the previous period has no ${copy.noun}.`, [
        previousPeriod(outcome.window),
      ]);
    case 'partial-measurement':
      return withoutPercentage(`No percentage: the ${copy.noun} is only partly ${copy.partly}.`, [
        previousPeriod(
          outcome.window,
          `${outcome.previous.complete ? '' : '≥ '}${copy.format(outcome.previous.value)} ${copy.noun}`,
        ),
      ]);
    case 'full-range':
      return withoutPercentage(NO_PREVIOUS_PERIOD, []);
    case 'history-shorter-than-window':
      return outcome.previousPeriod === 'unrecorded'
        ? withoutPercentage(NO_PREVIOUS_PERIOD, [historyStart(outcome.recordedFirst)])
        : withoutPercentage(PARTLY_RECORDED, [historyStart(outcome.recordedFirst), previousPeriod(outcome.window)]);
    case 'source-not-covering-window':
      return withoutPercentage(PARTLY_RECORDED, [
        ...outcome.sources.map(({ label, recordedFirst }) => historyStart(recordedFirst, `${label} history`)),
        previousPeriod(outcome.window),
      ]);
    case 'no-previous-sessions':
      return withoutPercentage('No sessions exist in the previous period.', [previousPeriod(outcome.window)]);
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
};

export const presentPeriodComparison = (
  outcome: MetricPeriodComparison,
  copy: PeriodComparisonMetricCopy,
): PeriodComparisonPresentation => ({ ...explain(outcome, copy), outcome });

/** Every explanation line for a surface that does not write the caveat out beside the figure. */
export const explanationWithCaveat = ({ caveat, explanation }: PeriodComparisonPresentation): readonly string[] =>
  caveat === null ? explanation : [...explanation, caveat];
