import type { MetricPeriodComparison, PeriodRecordedHistory, PeriodWindow } from '../../../../dashboard-model';
import { fmtDateOnly } from '../../../foundation/presentation/format';

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
  /**
   * The change as a clause that continues "… is", such as "12% higher than the previous
   * equal-length period"; null whenever no percentage exists.
   */
  readonly relation: string | null;
  /** One sentence that stands on its own. */
  readonly statement: string;
}

const IN_PROGRESS_CAVEAT = 'This period is still in progress, so the comparison is provisional.';
const NO_PREVIOUS_PERIOD = 'No previous period exists before the full recorded range.';
const PARTLY_RECORDED = 'No percentage: the previous period is only partly recorded.';
const PREVIOUS_EQUAL_PERIOD = 'the previous equal-length period';

// One decimal below ten percent, where it carries information, and grouped whole numbers from ten
// percent up, where it does not: "8.5%", "12%", "1,782%".
const tenthsPercent = new Intl.NumberFormat('en', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
  useGrouping: false,
});
const wholePercent = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const harnessList = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/**
 * The figure and the relation clause of a measured change. A change that is not zero but rounds to
 * zero at the precision shown reads as no meaningful change in either direction.
 */
const changeWording = (percent: number): { readonly figure: string; readonly relation: string } => {
  const magnitude = Math.abs(percent);
  const tenths = tenthsPercent.format(magnitude);
  if (percent === 0) {
    return { figure: '0%', relation: `unchanged from ${PREVIOUS_EQUAL_PERIOD}` };
  }
  if (tenths === '0.0') {
    return { figure: '≈0%', relation: `about the same as ${PREVIOUS_EQUAL_PERIOD}` };
  }
  // A value that rounds up to ten percent follows the whole-number rule as well.
  const label = `${Number(tenths) < 10 ? tenths : wholePercent.format(magnitude)}%`;
  return percent < 0
    ? { figure: `−${label}`, relation: `${label} lower than ${PREVIOUS_EQUAL_PERIOD}` }
    : { figure: `+${label}`, relation: `${label} higher than ${PREVIOUS_EQUAL_PERIOD}` };
};

/** The previous window and, when it was measured, its value: the same filters and the same measure. */
const previousPeriod = (window: PeriodWindow, value?: string): string => {
  const first = fmtDateOnly(window.from);
  const last = fmtDateOnly(window.to);
  const dates = first === last ? first : `${first} – ${last}`;
  return `Previous period, same filters: ${value === undefined ? dates : `${dates} · ${value}`}`;
};

/** Where the deciding history starts, naming the harnesses it is limited to and no other filter. */
const historyStart = ({ first, limitedToHarnesses }: PeriodRecordedHistory): string => {
  const date = fmtDateOnly(first);
  if (limitedToHarnesses.length === 0) {
    return `Recorded history starts ${date}.`;
  }
  return limitedToHarnesses.length === 1
    ? `Recorded ${limitedToHarnesses[0]} history starts ${date}.`
    : `Recorded history of ${harnessList.format(limitedToHarnesses)} starts ${date}.`;
};

type Explanation = Pick<PeriodComparisonPresentation, 'caveat' | 'explanation' | 'figure' | 'relation' | 'statement'>;

const withoutPercentage = (statement: string, explanation: readonly string[]): Explanation => ({
  caveat: null,
  explanation,
  figure: null,
  relation: null,
  statement,
});

const explain = (outcome: MetricPeriodComparison, copy: PeriodComparisonMetricCopy): Explanation => {
  switch (outcome.kind) {
    case 'change': {
      const { figure, relation } = changeWording(outcome.percent);
      return {
        caveat: outcome.provisional ? IN_PROGRESS_CAVEAT : null,
        explanation: [previousPeriod(outcome.window, `${copy.format(outcome.previous)} ${copy.noun}`)],
        figure,
        relation,
        statement: `${relation.charAt(0).toUpperCase()}${relation.slice(1)}.`,
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
        ? withoutPercentage(NO_PREVIOUS_PERIOD, [historyStart(outcome.history)])
        : withoutPercentage(PARTLY_RECORDED, [historyStart(outcome.history), previousPeriod(outcome.window)]);
    case 'harness-not-covering-window':
      return withoutPercentage(PARTLY_RECORDED, [
        ...outcome.harnesses.map(({ label, recordedFirst }) =>
          historyStart({ first: recordedFirst, limitedToHarnesses: [label] }),
        ),
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
