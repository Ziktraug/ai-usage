import { Tooltip } from '@ai-usage/design-system';
import { css, cx } from '@ai-usage/design-system/css';
import {
  accentFill,
  advancedAnalysis,
  advancedAnalysisContent,
  advancedAnalysisHeader,
  advancedAnalysisHeaderText,
  anatomyHeadline,
  anatomyLegend,
  anatomyLegendItem,
  anatomyLegendLabel,
  anatomyLegendPercentage,
  anatomyLegendSwatch,
  anatomyLegendValue,
  anatomyLegendValues,
  emptyPanel,
  HarnessBadge,
  harnessSvgFillFor,
  heatBody,
  heatCell,
  heatCellToday,
  heatCellZero,
  heatDayControl,
  heatDayDetail,
  heatGrid,
  heatLegend,
  heatLegendCell,
  heatMonths,
  heatScroll,
  heatWeekColumn,
  heatWeekdays,
  heroLabel,
  heroLegend,
  heroLegendValue,
  heroMultiple,
  heroPanel,
  heroSide,
  heroText,
  heroValue,
  muted,
  overviewGrid,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  punchCell,
  punchCellButton,
  punchDayLabel,
  punchDot,
  punchGrid,
  punchHourLabel,
  punchIntensityKey,
  punchIntensityKeyCell,
  recordCard,
  recordLabel,
  recordSub,
  recordsGrid,
  recordValue,
  rtkNote,
  scatterAxisText,
  scatterDistribution,
  scatterDistributionList,
  scatterDistributionMeta,
  scatterDistributionRow,
  scatterGridline,
  scatterLegend,
  scatterOutlierButton,
  scatterOutlierMeta,
  scatterOutliers,
  scatterPoint,
  scatterSummary,
  scatterWrap,
  tokenSegmentClasses,
  topList,
  topMoney,
  topRank,
  topRow,
  topTitle,
  twoColumns,
} from '@ai-usage/design-system/report';
import type {
  FocusedCalendarHeatmap,
  FocusedOverviewRecords,
  FocusedOverviewSessionItem,
  FocusedPunchcard,
  FocusedSessionShape,
} from '@ai-usage/report-core/focused-report-query';
import {
  isLocalTimeHour,
  isLocalTimeWeekday,
  type LocalTimeCell,
  localTimeCellLabel,
  localTimeWeekdayNames,
} from '@ai-usage/report-core/session-query';
import { createEffect, createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import {
  type CampaignLabelContext,
  focusedCampaignLabelContext,
  presentFocusedOverviewSessionItem,
} from './campaign-label-overrides';
import type { CampaignView } from './dashboard-model';
import { toDateInputValue } from './date-range';
import type { FocusedOverviewDisplayModel } from './focused-report-client';
import {
  buildAdvancedAnalysisSummary,
  buildCalendarHeatmapData,
  buildOverviewHeroData,
  buildOverviewRecords,
  buildPunchcardData,
  buildSessionShapeData,
  buildTopSessions,
  type HeatDay,
  nextHeatmapFocusIndex,
  type OverviewSessionItem,
  PUNCH_DAYS,
  PUNCHCARD_MIN_SESSION_OPACITY,
  punchcardSessionOpacity,
  SESSION_SHAPE_POINT_RADIUS,
} from './overview-model';
import {
  aggregateApiPriceProvenance,
  aggregateApiValuePresentation,
  apiValuePresentation,
  type DashboardRow,
  fmtCompact,
  fmtDateOnly,
  fmtDuration,
  fmtMoney,
  fmtNum,
  fmtPct,
  type ReportSummary,
} from './shared';

export interface OverviewProps {
  advancedAnalysisError?: string | null;
  advancedAnalysisLoading?: boolean;
  campaigns: CampaignView[];
  focused?: FocusedOverviewDisplayModel | undefined;
  labelFor: (campaignKey: string, derivedLabel: string) => string;
  onSelectDay: (day: Date) => void;
  onSelectSession: (row: DashboardRow, campaignLabelContext?: CampaignLabelContext | null) => void;
  onSelectTimeCell: (cell: LocalTimeCell) => void;
  rangeLabel: string;
  rows: DashboardRow[];
  summary: ReportSummary;
  timelineRows: DashboardRow[];
}

const campaignLabelContextForOverviewItem = (
  item: FocusedOverviewSessionItem | OverviewSessionItem,
): CampaignLabelContext | null => {
  if (item.kind !== 'campaign') {
    return null;
  }
  if ('campaign' in item) {
    return {
      campaignKey: item.campaign.campaignKey,
      derivedLabel: item.campaign.root.sessionLabel,
    };
  }
  return focusedCampaignLabelContext(item);
};

const visuallyHidden = css({ srOnly: true });
const Panel = (props: { title: string; sub?: string; children: JSX.Element; headingId?: string }) => (
  <section class={panel}>
    <header class={panelHeader}>
      <h2 class={panelTitle} id={props.headingId}>
        {props.title}
      </h2>
      <Show when={props.sub}>
        <div class={panelSub}>{props.sub}</div>
      </Show>
    </header>
    {props.children}
  </section>
);

// ---------------------------------------------------------------------------
// Hero — the API-equivalent comparison is useful, but it is neither savings
// nor ROI. Keep the estimated value and reported spend as separate facts and
// make both coverage limits explicit.

const Hero = (props: { summary: ReportSummary; rangeLabel: string }) => {
  const data = createMemo(() => buildOverviewHeroData(props.summary));

  return (
    <Show when={data()}>
      {(hero) => (
        <section aria-label="API-equivalent value" class={heroPanel}>
          <div>
            <div class={heroLabel}>Estimated API-equivalent value</div>
            <div class={heroValue}>{aggregateApiValuePresentation(hero().priceMeasurement).label}</div>
            <Show when={aggregateApiPriceProvenance(hero().priceMeasurement)}>
              {(fact) => (
                <Tooltip content={fact().description}>
                  <span class={heroText}>{fact().label}</span>
                </Tooltip>
              )}
            </Show>
            <div class={heroText}>
              Standard API-price estimate for {fmtNum(hero().apiPricedSessions)} of {fmtNum(hero().sessionCount)}{' '}
              sessions ({props.rangeLabel}). This is a comparison value, not savings or ROI.
            </div>
          </div>
          <div class={heroSide}>
            <span class={heroMultiple} data-reported-actual-spend>
              Reported actual spend · {fmtMoney(hero().actualSpend)}
            </span>
            <div class={heroLegend} data-spend-coverage-legend>
              <span>
                Spend coverage
                <span class={heroLegendValue}>
                  {fmtNum(hero().actualSpendKnownSessions)}/{fmtNum(hero().sessionCount)} sessions
                </span>
              </span>
              <Show when={hero().subscriptionValue > 0}>
                <span>
                  Quota-covered value reported
                  <span class={heroLegendValue}>{fmtMoney(hero().subscriptionValue)}</span>
                </span>
              </Show>
            </div>
          </div>
        </section>
      )}
    </Show>
  );
};

// ---------------------------------------------------------------------------
// Calendar heatmap — the contribution-graph view of agentic activity. Always
// spans the full filtered history (not the brushed range) so it doubles as a
// date navigator: clicking a day focuses the dashboard on it.

const HEAT_OPACITY = [0.28, 0.52, 0.76, 1];
const HEAT_DAY_DETAIL_ID = 'overview-heatmap-day-detail';

const focusedCalendarHeatmap = (data: FocusedCalendarHeatmap | null) =>
  data && {
    ...data,
    weeks: data.weeks.map((week) => ({
      days: week.days.map((day) => (day ? { ...day, date: new Date(day.date) } : null)),
    })),
  };

const CalendarHeatmap = (props: {
  focused: FocusedCalendarHeatmap | null | undefined;
  onSelectDay: (day: Date) => void;
  rows: DashboardRow[];
}) => {
  let scrollEl: HTMLDivElement | undefined;
  const cellElements = new Map<string, HTMLButtonElement>();
  const [focusedDayKey, setFocusedDayKey] = createSignal<string | null>(null);

  const data = createMemo(() =>
    props.focused === undefined ? buildCalendarHeatmapData(props.rows) : focusedCalendarHeatmap(props.focused),
  );
  const heatDays = createMemo(
    () =>
      data()
        ?.weeks.flatMap((week) => week.days)
        .filter((day): day is HeatDay => day !== null) ?? [],
  );

  createEffect(() => {
    const days = heatDays();
    const currentKey = focusedDayKey();
    if (days.length === 0) {
      setFocusedDayKey(null);
      return;
    }
    if (!(currentKey && days.some((day) => toDateInputValue(day.date) === currentKey))) {
      setFocusedDayKey(toDateInputValue(days.at(-1)?.date ?? days[0]?.date ?? new Date()));
    }
  });

  const heatDayForKey = (key: string) => heatDays().find((day) => toDateInputValue(day.date) === key);
  const describeHeatDay = (day: HeatDay) => {
    const value = aggregateApiValuePresentation(day.priceMeasurement).label;
    const provenance = aggregateApiPriceProvenance(day.priceMeasurement);
    return `${fmtDateOnly(day.date)} — ${value} · ${fmtNum(day.sessions)} sessions${
      provenance ? ` · ${provenance.label}` : ''
    }`;
  };
  const describeHeatDayWithProvenance = (day: HeatDay) => {
    const description = describeHeatDay(day);
    const provenance = aggregateApiPriceProvenance(day.priceMeasurement);
    return provenance ? `${description}. ${provenance.description}` : description;
  };
  const focusedHeatDay = createMemo(() => {
    const key = focusedDayKey();
    return key ? heatDayForKey(key) : undefined;
  });
  const focusedHeatDayDescription = createMemo(() => {
    const day = focusedHeatDay();
    return day ? describeHeatDay(day) : 'Choose a day in the activity range.';
  });
  const focusHeatDay = (key: string, moveDomFocus = false): void => {
    if (!heatDayForKey(key)) {
      return;
    }
    setFocusedDayKey(key);
    if (moveDomFocus) {
      cellElements.get(key)?.focus();
    }
  };
  const selectHeatDay = (key: string): void => {
    const day = heatDayForKey(key);
    if (!day) {
      return;
    }
    setFocusedDayKey(key);
    props.onSelectDay(day.date);
  };

  const moveHeatmapFocus = (event: KeyboardEvent, currentKey: string) => {
    const days = heatDays();
    const currentIndex = days.findIndex((day) => toDateInputValue(day.date) === currentKey);
    const nextIndex = nextHeatmapFocusIndex(currentIndex, days.length, event.key);
    if (nextIndex === null) {
      return;
    }
    const nextDay = days[nextIndex];
    if (!nextDay) {
      return;
    }
    event.preventDefault();
    const nextKey = toDateInputValue(nextDay.date);
    focusHeatDay(nextKey, true);
  };

  // Most recent activity matters most: keep the right edge in view.
  createEffect(() => {
    if (data() && scrollEl) {
      scrollEl.scrollLeft = scrollEl.scrollWidth;
    }
  });

  return (
    <Panel
      sub="Daily activity across the whole filtered history — choose a day to focus the dashboard on it"
      title="Rhythm"
    >
      <Show fallback={<div class={emptyPanel}>No dated sessions match the current filters</div>} when={data()}>
        {(heat) => (
          <>
            <div class={heatBody}>
              <div aria-hidden="true" class={heatWeekdays}>
                <span>Mon</span>
                <span />
                <span>Wed</span>
                <span />
                <span>Fri</span>
                <span />
                <span />
              </div>
              <div
                class={heatScroll}
                ref={(element) => {
                  scrollEl = element;
                }}
              >
                <div aria-hidden="true" class={heatMonths}>
                  <For each={heat().monthLabels}>{(label) => <span>{label}</span>}</For>
                </div>
                <div
                  aria-label="Daily activity calendar. Use arrow keys to move by day or week."
                  class={heatGrid}
                  role="toolbar"
                >
                  <For each={heat().weeks}>
                    {(week) => (
                      <div class={heatWeekColumn}>
                        <For each={week.days}>
                          {(day) => (
                            <Show fallback={<span />} when={day}>
                              {(cell) => {
                                const key = () => toDateInputValue(cell().date);
                                const description = () => describeHeatDayWithProvenance(cell());
                                return (
                                  <button
                                    aria-current={key() === heat().todayKey ? 'date' : undefined}
                                    aria-label={`${description()}. Focus dashboard on this day.`}
                                    class={cx(
                                      heatCell,
                                      cell().level === 0 ? heatCellZero : accentFill,
                                      key() === heat().todayKey ? heatCellToday : undefined,
                                    )}
                                    data-heatmap-day={key()}
                                    onClick={() => selectHeatDay(key())}
                                    onFocus={() => focusHeatDay(key())}
                                    onKeyDown={(event) => moveHeatmapFocus(event, key())}
                                    ref={(element) => cellElements.set(key(), element)}
                                    style={cell().level > 0 ? { opacity: HEAT_OPACITY[cell().level - 1] } : undefined}
                                    tabIndex={focusedDayKey() === key() ? 0 : -1}
                                    title={description()}
                                    type="button"
                                  />
                                );
                              }}
                            </Show>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
            <div class={heatDayControl}>
              <span class={heatDayDetail} id={HEAT_DAY_DETAIL_ID}>
                {focusedHeatDayDescription()}
              </span>
            </div>
            <div class={heatLegend}>
              <span>Less</span>
              <span class={cx(heatLegendCell, heatCellZero)} />
              <For each={HEAT_OPACITY}>
                {(opacity) => <span class={cx(heatLegendCell, accentFill)} style={{ opacity }} />}
              </For>
              <span>More</span>
              <span style={{ 'margin-left': 'auto' }}>scaled by sessions</span>
            </div>
          </>
        )}
      </Show>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Token anatomy — cache reads dwarf everything else in agentic workloads;
// showing the proportion makes the cache-hit superpower legible. The RTK
// aggregate lives here too instead of a mostly-empty table column.

const TokenAnatomy = (props: { summary: ReportSummary }) => {
  const segments = createMemo(() => [
    { label: 'Cache read', value: props.summary.cacheRead, class: tokenSegmentClasses.cacheRead },
    { label: 'Cache write', value: props.summary.cacheWrite, class: tokenSegmentClasses.cacheWrite },
    { label: 'Input', value: props.summary.tokIn, class: tokenSegmentClasses.input },
    { label: 'Output', value: props.summary.tokOut, class: tokenSegmentClasses.output },
  ]);
  const total = createMemo(() => segments().reduce((sum, segment) => sum + segment.value, 0));
  const cachePct = () => (total() > 0 ? (props.summary.cacheRead / total()) * 100 : 0);

  return (
    <Panel sub="Where the volume actually goes" title="Token anatomy">
      <Show fallback={<div class={emptyPanel}>No token data in range</div>} when={total() > 0}>
        <div class={anatomyHeadline}>
          <strong>{fmtPct(cachePct())}</strong> of all token volume was read from cache — context reuse is what makes
          agentic sessions affordable.
        </div>
        <dl class={anatomyLegend} data-overview-token-legend>
          <For each={segments()}>
            {(segment) => (
              <div
                class={anatomyLegendItem}
                data-token-anatomy-row
                title={`${segment.label}: ${fmtNum(segment.value)} tokens`}
              >
                <dt class={anatomyLegendLabel}>
                  <span class={cx(anatomyLegendSwatch, segment.class)} />
                  <span>{segment.label}</span>
                </dt>
                <dd class={anatomyLegendValues}>
                  <span class={anatomyLegendValue} data-token-exact-value>
                    {fmtNum(segment.value)}
                  </span>
                  <span class={anatomyLegendPercentage} data-token-percentage>
                    {fmtPct((segment.value / total()) * 100)}
                  </span>
                </dd>
              </div>
            )}
          </For>
        </dl>
        <Show when={props.summary.rtkSaved > 0}>
          <div class={rtkNote}>
            <span>
              RTK saved <strong>{fmtCompact(props.summary.rtkSaved)}</strong> tokens (
              {fmtPct(props.summary.rtkInput ? (props.summary.rtkSaved / props.summary.rtkInput) * 100 : 0)} of matched
              input) across <strong>{fmtNum(props.summary.rtkSessions)}</strong> sessions.
            </span>
          </div>
        </Show>
      </Show>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Session shape — duration × cost scatter on log scales. Micro-questions,
// working sessions and marathons separate into visible clusters.

export const SessionShape = (props: {
  campaigns: CampaignView[];
  focused: FocusedSessionShape | null | undefined;
  labelFor: (campaignKey: string, derivedLabel: string) => string;
  rows: DashboardRow[];
  onSelectSession: (row: DashboardRow, campaignLabelContext?: CampaignLabelContext | null) => void;
}) => {
  const data = createMemo(() => {
    const focused = props.focused;
    if (focused === undefined) {
      return buildSessionShapeData(props.rows, props.campaigns);
    }
    if (focused === null) {
      return null;
    }
    const logRatio = (value: number, domain: { max: number; min: number }): number =>
      (Math.log10(Math.max(value, Number.EPSILON)) - domain.min) / Math.max(Number.EPSILON, domain.max - domain.min);
    return {
      ...focused,
      outliers: focused.outliers.map((item) => presentFocusedOverviewSessionItem(item, props.labelFor)),
      points: focused.points.map((item) => presentFocusedOverviewSessionItem(item, props.labelFor)),
      xPct: (value: number) => 4 + logRatio(value, focused.xDomain) * 92,
      yPct: (value: number) => 92 - logRatio(value, focused.yDomain) * 84,
    };
  });

  return (
    <Panel
      sub="Duration × API value (log scales) — fixed-size marks show plotted sessions or campaigns"
      title="Session shape"
    >
      <Show fallback={<div class={emptyPanel}>Not enough timed, fully priced sessions in range</div>} when={data()}>
        {(chart) => (
          <>
            <div class={scatterWrap}>
              <svg aria-hidden="true" height="100%" width="100%">
                <For each={chart().xTicks}>
                  {(tick) => (
                    <>
                      <line
                        class={scatterGridline}
                        x1={`${chart().xPct(tick.value)}%`}
                        x2={`${chart().xPct(tick.value)}%`}
                        y1="0"
                        y2="100%"
                      />
                      <text class={scatterAxisText} dx="3" dy="-5" x={`${chart().xPct(tick.value)}%`} y="100%">
                        {tick.label}
                      </text>
                    </>
                  )}
                </For>
                <For each={chart().yTicks}>
                  {(tick) => (
                    <>
                      <line
                        class={scatterGridline}
                        x1="0"
                        x2="100%"
                        y1={`${chart().yPct(tick.value)}%`}
                        y2={`${chart().yPct(tick.value)}%`}
                      />
                      <text class={scatterAxisText} dy="-3" x="4" y={`${chart().yPct(tick.value)}%`}>
                        {tick.label}
                      </text>
                    </>
                  )}
                </For>
                <For each={chart().points}>
                  {(item) => (
                    <circle
                      class={cx(harnessSvgFillFor(item.harness), scatterPoint)}
                      cx={`${chart().xPct(item.durationMs ?? 0)}%`}
                      cy={`${chart().yPct(item.costApprox)}%`}
                      data-session-shape-point
                      r={String(SESSION_SHAPE_POINT_RADIUS)}
                    >
                      <title>
                        {[
                          `${item.label} — ${fmtMoney(item.costApprox)} · ${fmtDuration(item.durationMs)} · ${item.harness}`,
                          item.kind === 'campaign' ? `${fmtNum(item.sessionCount)} sessions` : '',
                          item.aggregateCount > 1 ? `${fmtNum(item.aggregateCount)} nearby sessions` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </title>
                    </circle>
                  )}
                </For>
              </svg>
            </div>
            <div class={scatterSummary} data-session-shape-summary>
              {fmtNum(chart().totalPoints)} timed, fully priced sessions · {fmtNum(chart().points.length)} plotted
              session/campaign groups
            </div>
            <details class={scatterDistribution}>
              <summary>Distribution by harness</summary>
              <ul class={scatterDistributionList}>
                <For each={chart().harnessSummaries}>
                  {(summary) => (
                    <li class={scatterDistributionRow}>
                      <span>
                        <HarnessBadge name={summary.harness} /> · {fmtNum(summary.sessions)} sessions in{' '}
                        {fmtNum(summary.groups)} {summary.groups === 1 ? 'group' : 'groups'}
                      </span>
                      <span class={scatterDistributionMeta}>
                        Duration {fmtDuration(summary.durationMin)}–{fmtDuration(summary.durationMax)} · API value{' '}
                        {fmtMoney(summary.costMin)}–{fmtMoney(summary.costMax)}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </details>
            <section aria-label="Standout sessions" class={scatterOutliers}>
              <For each={chart().outliers}>
                {(item) => (
                  <button
                    aria-label={`Inspect ${item.kind === 'campaign' ? 'campaign' : 'session'}: ${item.label}`}
                    class={scatterOutlierButton}
                    onClick={() => props.onSelectSession(item.row, campaignLabelContextForOverviewItem(item))}
                    type="button"
                  >
                    <span>{item.label}</span>
                    <span class={scatterOutlierMeta}>
                      {fmtMoney(item.costApprox)} · {fmtDuration(item.durationMs)} · {item.harness}
                    </span>
                  </button>
                )}
              </For>
            </section>
            <ul
              aria-label="Session Shape harness key"
              class={scatterLegend}
              data-session-shape-harness-key
              style={{ 'list-style': 'none', margin: 0, padding: 0 }}
            >
              <For each={chart().harnesses}>
                {(name) => (
                  <li>
                    <HarnessBadge name={name} />
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Punchcard — hour × weekday density. Nightly auto-review bots and weekend
// streaks show up immediately.

const PUNCHCARD_HEADING_ID = 'overview-punchcard-title';

const punchcardTimeCellFor = (weekday: number, hour: number): LocalTimeCell | null => {
  if (!(isLocalTimeWeekday(weekday) && isLocalTimeHour(hour))) {
    return null;
  }
  return { hour, weekday };
};

const punchcardTimeCellAriaLabel = (cell: LocalTimeCell, sessionCount: number): string =>
  `Filter report to ${localTimeCellLabel(cell)}, ${fmtNum(sessionCount)} ${sessionCount === 1 ? 'session' : 'sessions'}`;

const Punchcard = (props: {
  focused: FocusedPunchcard | null | undefined;
  onSelectTimeCell: OverviewProps['onSelectTimeCell'];
  rows: DashboardRow[];
}) => {
  const data = createMemo(() => (props.focused === undefined ? buildPunchcardData(props.rows) : props.focused));
  const accessibleCells = createMemo(
    () =>
      data()?.cells.flatMap((dayCells, dayIndex) =>
        dayCells.flatMap((cell, hour) =>
          cell.sessions > 0 ? [{ ...cell, day: localTimeWeekdayNames[dayIndex] ?? '', hour }] : [],
        ),
      ) ?? [],
  );

  return (
    <Panel headingId={PUNCHCARD_HEADING_ID} sub="When the sessions happen — hour of day × weekday" title="Punchcard">
      <Show fallback={<div class={emptyPanel}>No dated sessions in range</div>} when={data()}>
        {(punch) => (
          <>
            <div class={punchGrid} data-punchcard-visual>
              <For each={punch().cells}>
                {(dayCells, dayIndex) => (
                  <>
                    <span aria-hidden="true" class={punchDayLabel}>
                      {PUNCH_DAYS[dayIndex()]}
                    </span>
                    <For each={dayCells}>
                      {(cell, hour) => (
                        <span
                          class={punchCell}
                          title={`${PUNCH_DAYS[dayIndex()]} ${String(hour()).padStart(2, '0')}:00 — ${fmtNum(cell.sessions)} sessions · ${fmtMoney(cell.cost)}`}
                        >
                          <Show when={cell.sessions > 0 ? punchcardTimeCellFor(dayIndex(), hour()) : null}>
                            {(timeCell) => (
                              <button
                                aria-label={punchcardTimeCellAriaLabel(timeCell(), cell.sessions)}
                                class={punchCellButton}
                                onClick={() => props.onSelectTimeCell(timeCell())}
                                type="button"
                              >
                                <span
                                  class={cx(punchDot, accentFill)}
                                  data-punchcard-cell-fill
                                  style={{ opacity: punchcardSessionOpacity(cell.sessions, punch().maxSessions) }}
                                />
                              </button>
                            )}
                          </Show>
                        </span>
                      )}
                    </For>
                  </>
                )}
              </For>
              <span />
              <For each={Array.from({ length: 24 }, (_, hour) => hour)}>
                {(hour) => (
                  <span aria-hidden="true" class={punchHourLabel}>
                    {hour % 3 === 0 ? hour : ''}
                  </span>
                )}
              </For>
            </div>
            <div
              aria-label="Punchcard session-count intensity"
              class={punchIntensityKey}
              data-punchcard-intensity-key
              role="img"
            >
              <span>Low</span>
              <span class={cx(punchIntensityKeyCell, accentFill)} style={{ opacity: PUNCHCARD_MIN_SESSION_OPACITY }} />
              <span class={cx(punchIntensityKeyCell, accentFill)} />
              <span>High</span>
              <span>session count</span>
            </div>
            <div class={visuallyHidden}>
              <table aria-labelledby={PUNCHCARD_HEADING_ID}>
                <caption>Non-empty activity periods</caption>
                <thead>
                  <tr>
                    <th scope="col">Weekday</th>
                    <th scope="col">Hour</th>
                    <th scope="col">Sessions</th>
                    <th scope="col">API-equivalent value</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={accessibleCells()}>
                    {(cell) => (
                      <tr>
                        <th scope="row">{cell.day}</th>
                        <td>{String(cell.hour).padStart(2, '0')}:00</td>
                        <td>{fmtNum(cell.sessions)}</td>
                        <td>{fmtMoney(cell.cost)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </>
        )}
      </Show>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Records — small bragging rights, sober clothes.

const Records = (props: {
  campaigns: CampaignView[];
  focused: FocusedOverviewRecords | null | undefined;
  rows: DashboardRow[];
  timelineRows: DashboardRow[];
  onSelectSession: OverviewProps['onSelectSession'];
  onSelectDay: (day: Date) => void;
}) => {
  const data = createMemo(() => {
    if (props.focused === undefined) {
      return buildOverviewRecords(props.rows, props.timelineRows, props.campaigns);
    }
    const focused = props.focused;
    if (!focused) {
      return null;
    }
    return {
      ...focused,
      busiest: focused.busiest ? { ...focused.busiest, date: new Date(focused.busiest.date) } : null,
      streakEnd: focused.streakEnd ? new Date(focused.streakEnd) : null,
    };
  });

  return (
    <Show when={data()}>
      {(records) => (
        <div class={recordsGrid}>
          <Show when={records().topCost}>
            {(item) => (
              <button
                class={recordCard}
                onClick={() => props.onSelectSession(item().row, campaignLabelContextForOverviewItem(item()))}
                type="button"
              >
                <span class={recordLabel}>Top session</span>
                <span class={recordValue}>{fmtMoney(item().costApprox)}</span>
                <span class={recordSub}>{item().label}</span>
              </button>
            )}
          </Show>
          <Show when={records().longest}>
            {(item) => (
              <button
                class={recordCard}
                onClick={() => props.onSelectSession(item().row, campaignLabelContextForOverviewItem(item()))}
                type="button"
              >
                <span class={recordLabel}>Longest session</span>
                <span class={recordValue}>{fmtDuration(item().durationMs)}</span>
                <span class={recordSub}>{item().label}</span>
              </button>
            )}
          </Show>
          <Show when={records().busiest}>
            {(day) => (
              <button class={recordCard} onClick={() => props.onSelectDay(day().date)} type="button">
                <span class={recordLabel}>Busiest day</span>
                <span class={recordValue}>{fmtMoney(day().cost)}</span>
                <span class={recordSub}>
                  {fmtDateOnly(day().date)} · {fmtNum(day().sessions)} sessions
                </span>
              </button>
            )}
          </Show>
          <Show when={records().streak > 0 && records().streakEnd}>
            {(end) => (
              <button class={recordCard} onClick={() => props.onSelectDay(end())} type="button">
                <span class={recordLabel}>Streak</span>
                <span class={recordValue}>
                  {fmtNum(records().streak)} {records().streak === 1 ? 'day' : 'days'}
                </span>
                <span class={recordSub}>consecutive days with sessions, ending {fmtDateOnly(end())}</span>
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
};

// ---------------------------------------------------------------------------
// Top sessions — the five highest API-equivalent values, by name. Session titles
// carry a lot of qualitative signal; surface them.

const TopSessions = (props: {
  campaigns: CampaignView[];
  focused: FocusedOverviewSessionItem[] | undefined;
  labelFor: (campaignKey: string, derivedLabel: string) => string;
  rows: DashboardRow[];
  onSelectSession: (row: DashboardRow, campaignLabelContext?: CampaignLabelContext | null) => void;
}) => {
  const top = createMemo(() =>
    props.focused
      ? props.focused.map((item) => presentFocusedOverviewSessionItem(item, props.labelFor))
      : buildTopSessions(props.rows, 5, props.campaigns),
  );

  return (
    <Show when={top().length}>
      <Panel
        sub="The five highest estimated API-equivalent values for sessions or campaigns in range — click to inspect"
        title="Top sessions"
      >
        <div class={topList}>
          <For each={top()}>
            {(item, index) => (
              <button
                class={topRow}
                onClick={() => props.onSelectSession(item.row, campaignLabelContextForOverviewItem(item))}
                type="button"
              >
                <span class={topRank}>{index() + 1}</span>
                <span class={topTitle}>
                  {item.label}
                  <Show when={item.kind === 'campaign'}>
                    <span class={muted}> · Campaign · {fmtNum(item.sessionCount)} sessions</span>
                  </Show>
                </span>
                <HarnessBadge name={item.harness} />
                <span class={topMoney} title={apiValuePresentation(item).title}>
                  {apiValuePresentation(item).label}
                </span>
              </button>
            )}
          </For>
        </div>
      </Panel>
    </Show>
  );
};

// ---------------------------------------------------------------------------

export const Overview = (props: OverviewProps) => {
  const advancedSummary = createMemo(
    () => props.focused?.view.advancedSummary ?? buildAdvancedAnalysisSummary(props.rows, props.campaigns),
  );
  const advancedSummaryText = () =>
    advancedSummary()?.summary ?? (props.focused ? 'Session shape and weekly/hourly activity' : '');
  const summary = () => props.focused?.summary ?? props.summary;

  return (
    <Show fallback={<div class={emptyPanel}>No sessions match the current filters</div>} when={summary().sessionCount}>
      <div class={overviewGrid}>
        <Hero rangeLabel={props.rangeLabel} summary={summary()} />
        <CalendarHeatmap
          focused={props.focused?.view.heatmap}
          onSelectDay={props.onSelectDay}
          rows={props.timelineRows}
        />
        <TokenAnatomy summary={summary()} />
        <Records
          campaigns={props.campaigns}
          focused={props.focused?.view.records}
          onSelectDay={props.onSelectDay}
          onSelectSession={props.onSelectSession}
          rows={props.rows}
          timelineRows={props.timelineRows}
        />
        <TopSessions
          campaigns={props.campaigns}
          focused={props.focused?.view.topSessions}
          labelFor={props.labelFor}
          onSelectSession={props.onSelectSession}
          rows={props.rows}
        />
        <section aria-labelledby="advanced-analysis-title" class={advancedAnalysis}>
          <header class={advancedAnalysisHeader}>
            <h2 id="advanced-analysis-title">Advanced analysis</h2>
            <span class={advancedAnalysisHeaderText}>{advancedSummaryText()}</span>
          </header>
          <div class={advancedAnalysisContent}>
            <Show
              fallback={
                <Show
                  fallback={
                    <Show
                      fallback={<div class={emptyPanel}>No advanced analysis is available for these filters</div>}
                      when={advancedSummary()}
                    >
                      {(loadedSummary) => (
                        <div class={twoColumns}>
                          <Show when={loadedSummary().hasSessionShape}>
                            <SessionShape
                              campaigns={props.campaigns}
                              focused={props.focused?.view.sessionShape}
                              labelFor={props.labelFor}
                              onSelectSession={props.onSelectSession}
                              rows={props.rows}
                            />
                          </Show>
                          <Show when={loadedSummary().hasPunchcard}>
                            <Punchcard
                              focused={props.focused?.view.punchcard}
                              onSelectTimeCell={props.onSelectTimeCell}
                              rows={props.rows}
                            />
                          </Show>
                        </div>
                      )}
                    </Show>
                  }
                  when={props.advancedAnalysisError}
                >
                  {(message) => (
                    <div class={emptyPanel} role="alert">
                      Advanced analysis could not be loaded: {message()}
                    </div>
                  )}
                </Show>
              }
              when={props.advancedAnalysisLoading}
            >
              <div aria-busy="true" aria-live="polite" class={emptyPanel}>
                Loading advanced analysis…
              </div>
            </Show>
          </div>
        </section>
      </div>
    </Show>
  );
};
