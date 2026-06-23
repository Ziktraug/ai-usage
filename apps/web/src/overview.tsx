import { SegmentedControl } from '@ai-usage/design-system';
import { cx } from '@ai-usage/design-system/css';
import {
  accentFill,
  anatomyHeadline,
  anatomyLegend,
  anatomyLegendItem,
  anatomyLegendSwatch,
  anatomyLegendValue,
  chartLegendList,
  chartLegendPct,
  chartLegendSwatch,
  chartSwatchClasses,
  emptyPanel,
  HarnessBadge,
  harnessSvgFillFor,
  heatBody,
  heatCell,
  heatCellToday,
  heatCellZero,
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
  inkFill,
  migrationBar,
  migrationBars,
  migrationCrosshair,
  migrationGrid,
  migrationGridLabel,
  migrationGridLine,
  migrationLegendButton,
  migrationLegendMore,
  migrationPlot,
  migrationReadout,
  migrationReadoutDate,
  migrationReadoutHint,
  migrationReadoutItem,
  migrationReadoutItemActive,
  migrationReadoutSwatch,
  migrationReadoutTotal,
  migrationReadoutValue,
  migrationSeg,
  migrationToolbar,
  migrationToolbarSpacer,
  migrationTotal,
  migrationTrend,
  migrationTrendDown,
  migrationTrendUp,
  migrationXAxis,
  migrationXTick,
  muted,
  overflowSeriesColor,
  overviewGrid,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  punchCell,
  punchDayLabel,
  punchDot,
  punchGrid,
  punchHourLabel,
  recordCard,
  recordLabel,
  recordSub,
  recordsGrid,
  recordValue,
  rtkNote,
  scatterAxisText,
  scatterGridline,
  scatterLegend,
  scatterPoint,
  scatterWrap,
  tokenSegmentClasses,
  topList,
  topMoney,
  topRank,
  topRow,
  topTitle,
  twoColumns,
} from '@ai-usage/design-system/report';
import { createEffect, createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import type { CampaignView } from './dashboard-model';
import { toDateInputValue } from './date-range';
import {
  buildCalendarHeatmapData,
  buildModelMigrationData,
  buildOverviewRecords,
  buildPunchcardData,
  buildSessionShapeData,
  buildTopSessions,
  type MigrationGranularity,
  PUNCH_DAYS,
} from './overview-model';
import {
  type DashboardRow,
  fmtCompact,
  fmtDateOnly,
  fmtDuration,
  fmtMoney,
  fmtNum,
  fmtPct,
  type ReportSummary,
  SegmentBar,
} from './shared';

export interface OverviewProps {
  campaigns: CampaignView[];
  onSelectDay: (day: Date) => void;
  onSelectModel: (modelKey: string) => void;
  onSelectSession: (row: DashboardRow) => void;
  rangeLabel: string;
  rows: DashboardRow[];
  summary: ReportSummary;
  timelineRows: DashboardRow[];
}

const Panel = (props: { title: string; sub?: string; children: JSX.Element }) => (
  <section class={panel}>
    <header class={panelHeader}>
      <h2 class={panelTitle}>{props.title}</h2>
      <Show when={props.sub}>
        <div class={panelSub}>{props.sub}</div>
      </Show>
    </header>
    {props.children}
  </section>
);

// ---------------------------------------------------------------------------
// Hero — subscription leverage. The single most telling number in the data:
// what this usage would have cost at API rates versus what was actually paid.

const Hero = (props: { summary: ReportSummary; rangeLabel: string }) => {
  const data = createMemo(() => {
    const summary = props.summary;
    if (summary.totalCost <= 0) {
      return null;
    }
    const covered = summary.costQuota || Math.max(0, summary.totalCost - summary.actualCost);
    const multiple = summary.actualCost > 0.005 ? summary.totalCost / summary.actualCost : null;
    return { covered, multiple, summary };
  });

  return (
    <Show when={data()}>
      {(hero) => (
        <section aria-label="Subscription leverage" class={heroPanel}>
          <div>
            <div class={heroLabel}>Subscription leverage</div>
            <div class={heroValue}>{fmtMoney(hero().covered)}</div>
            <div class={heroText}>
              of subscription value absorbed by quotas ({props.rangeLabel}) — you actually paid{' '}
              {fmtMoney(hero().summary.actualCost)} across {fmtNum(hero().summary.sessionCount)} sessions.
            </div>
          </div>
          <div class={heroSide}>
            <Show fallback={<span class={heroMultiple}>fully covered by subscriptions</span>} when={hero().multiple}>
              {(multiple) => <span class={heroMultiple}>×{fmtNum(multiple())} leverage</span>}
            </Show>
            <SegmentBar
              ariaLabel="Actual spend versus subscription-covered API value"
              segments={[
                {
                  label: 'Paid out of pocket',
                  value: hero().summary.actualCost,
                  class: inkFill,
                  title: `Paid out of pocket: ${fmtMoney(hero().summary.actualCost)}`,
                },
                {
                  label: 'Covered by subscriptions',
                  value: hero().covered,
                  class: accentFill,
                  title: `Covered by subscriptions: ${fmtMoney(hero().covered)}`,
                },
              ]}
            />
            <div class={heroLegend}>
              <span>
                Paid
                <span class={heroLegendValue}>{fmtMoney(hero().summary.actualCost)}</span>
              </span>
              <span>
                API value
                <span class={heroLegendValue}>{fmtMoney(hero().summary.totalCost)}</span>
              </span>
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

const CalendarHeatmap = (props: { rows: DashboardRow[]; onSelectDay: (day: Date) => void }) => {
  let scrollEl: HTMLDivElement | undefined;

  const data = createMemo(() => buildCalendarHeatmapData(props.rows));

  // Most recent activity matters most: keep the right edge in view.
  createEffect(() => {
    if (data() && scrollEl) {
      scrollEl.scrollLeft = scrollEl.scrollWidth;
    }
  });

  return (
    <Panel
      sub="Daily activity across the whole filtered history — click a day to focus the dashboard on it"
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
                <div class={heatGrid}>
                  <For each={heat().weeks}>
                    {(week) => (
                      <div class={heatWeekColumn}>
                        <For each={week.days}>
                          {(day) => (
                            <Show fallback={<span />} when={day}>
                              {(cell) => (
                                <button
                                  aria-label={`Focus on ${fmtDateOnly(cell().date)}`}
                                  class={cx(
                                    heatCell,
                                    cell().level === 0 ? heatCellZero : accentFill,
                                    toDateInputValue(cell().date) === heat().todayKey ? heatCellToday : undefined,
                                  )}
                                  onClick={() => props.onSelectDay(cell().date)}
                                  style={cell().level > 0 ? { opacity: HEAT_OPACITY[cell().level - 1] } : undefined}
                                  title={`${fmtDateOnly(cell().date)} — ${fmtMoney(cell().cost)} · ${fmtNum(cell().sessions)} sessions`}
                                  type="button"
                                />
                              )}
                            </Show>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
            <div class={heatLegend}>
              <span>Less</span>
              <span class={cx(heatLegendCell, heatCellZero)} />
              <For each={HEAT_OPACITY}>
                {(opacity) => <span class={cx(heatLegendCell, accentFill)} style={{ opacity }} />}
              </For>
              <span>More</span>
              <span style={{ 'margin-left': 'auto' }}>
                {heat().useCost ? 'scaled by API value' : 'scaled by sessions'}
              </span>
            </div>
          </>
        )}
      </Show>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Model migration — dense stacked-bar histogram of API value per model over
// one bar per day/week/month (Day/Week/Month toggle). Value/Share toggle, and
// a hover readout below the plot (so it never covers the bars). Hovering
// highlights a model's ribbon across every bar (opencode-style), with each
// row's change vs the previous bucket.

const GRANULARITY_ITEMS = [
  { label: 'Day', value: 'day' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
] as const;

const MIGRATION_MODE_ITEMS = [
  { label: 'Value', value: 'value' },
  { label: 'Share', value: 'share' },
] as const;

// Cap x-axis labels so monthly buckets / very long ranges stay readable.
const MAX_X_TICKS = 8;
// Keep the panel compact: only the top models show by default (all stay
// reachable behind "Show all"), and the hover readout lists the top few.
const LEGEND_LIMIT = 12;
const READOUT_LIMIT = 8;
// Tiny prior buckets make % deltas explode; hide the meaningless ones.
const MAX_DELTA_PCT = 1000;

const migrationMonthFmt = new Intl.DateTimeFormat('en', { month: 'short' });
const migrationMonthYearFmt = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' });

const toGranularity = (value: string): MigrationGranularity => (value === 'week' || value === 'month' ? value : 'day');

const bucketLabel = (date: Date, granularity: MigrationGranularity) => {
  if (granularity === 'month') {
    return migrationMonthYearFmt.format(date);
  }
  if (granularity === 'week') {
    return `Week of ${fmtDateOnly(date)}`;
  }
  return fmtDateOnly(date);
};

// The first six models use the curated brand palette; the rest get a
// deterministic generated hue so nothing is ever lumped into "other".
const seriesSwatchClass = (index: number) =>
  index < chartSwatchClasses.length ? chartSwatchClasses[index] : undefined;

const seriesColorStyle = (index: number): JSX.CSSProperties | undefined =>
  index < chartSwatchClasses.length ? undefined : { background: overflowSeriesColor(index) };

// Keep edge labels/tooltips from spilling past the plot.
const edgeTransform = (pct: number) => {
  if (pct < 6) {
    return 'translateX(0)';
  }
  if (pct > 94) {
    return 'translateX(-100%)';
  }
  return 'translateX(-50%)';
};

const ModelMigration = (props: { rows: DashboardRow[]; onSelectModel: (modelKey: string) => void }) => {
  const [granularity, setGranularity] = createSignal<MigrationGranularity>('day');
  const data = createMemo(() => buildModelMigrationData(props.rows, granularity()));
  const [mode, setMode] = createSignal<'share' | 'value'>('value');
  // Which time bucket the cursor is over (drives the tooltip) and which model
  // segment, by series index (drives the across-chart ribbon highlight).
  const [hoveredBucket, setHoveredBucket] = createSignal<number | null>(null);
  const [hoveredModel, setHoveredModel] = createSignal<number | null>(null);
  const [showAllModels, setShowAllModels] = createSignal(false);

  const visibleSeries = createMemo(() => {
    const chart = data();
    if (!chart) {
      return [];
    }
    return showAllModels() ? chart.series : chart.series.slice(0, LEGEND_LIMIT);
  });

  // Pre-shape each bar's non-empty segments once, keeping the series (rank)
  // order so the dominant model stays at the base of every bar.
  const bars = createMemo(() => {
    const chart = data();
    if (!chart) {
      return [];
    }
    return chart.buckets.map((bucket) => {
      const segments: { index: number; value: number }[] = [];
      for (let index = 0; index < chart.series.length; index++) {
        const entry = chart.series[index];
        if (!entry) {
          continue;
        }
        const value = bucket.byModel.get(entry.key) ?? 0;
        if (value > 0) {
          segments.push({ index, value });
        }
      }
      return { date: bucket.date, segments, total: bucket.total };
    });
  });

  const gridLines = createMemo(() => {
    const chart = data();
    if (!chart) {
      return [] as { label: string; pct: number }[];
    }
    if (mode() === 'share') {
      return [
        { label: '0%', pct: 0 },
        { label: '50%', pct: 50 },
        { label: '100%', pct: 100 },
      ];
    }
    return [
      { label: '$0', pct: 0 },
      { label: fmtMoney(chart.maxBucketTotal / 2), pct: 50 },
      { label: fmtMoney(chart.maxBucketTotal), pct: 100 },
    ];
  });

  const monthTicks = createMemo(() => {
    const chart = data();
    if (!chart) {
      return [] as { label: string; pct: number }[];
    }
    const count = chart.buckets.length;
    const ticks: { label: string; pct: number }[] = [];
    let previousMonth = -1;
    let previousYear = -1;
    for (let i = 0; i < count; i++) {
      const bucket = chart.buckets[i];
      if (!bucket) {
        continue;
      }
      const month = bucket.date.getMonth();
      const year = bucket.date.getFullYear();
      if (month === previousMonth && year === previousYear) {
        continue;
      }
      previousMonth = month;
      previousYear = year;
      const label =
        month === 0
          ? `${migrationMonthFmt.format(bucket.date)} ’${String(year).slice(-2)}`
          : migrationMonthFmt.format(bucket.date);
      ticks.push({ label, pct: ((i + 0.5) / count) * 100 });
    }
    if (ticks.length <= MAX_X_TICKS) {
      return ticks;
    }
    const step = Math.ceil(ticks.length / MAX_X_TICKS);
    return ticks.filter((_, i) => i % step === 0);
  });

  const readout = createMemo(() => {
    const chart = data();
    const index = hoveredBucket();
    if (!chart || index === null) {
      return null;
    }
    const bucket = chart.buckets[index];
    if (!bucket) {
      return null;
    }
    // The bar to the left is the reference period for each row's delta.
    const previous = index > 0 ? chart.buckets[index - 1] : null;
    const rows: { delta: number | null; index: number; key: string; value: number }[] = [];
    for (let i = 0; i < chart.series.length; i++) {
      const entry = chart.series[i];
      if (!entry) {
        continue;
      }
      const value = bucket.byModel.get(entry.key) ?? 0;
      if (value <= 0) {
        continue;
      }
      const prior = previous?.byModel.get(entry.key) ?? 0;
      const delta = prior > 1e-9 ? ((value - prior) / prior) * 100 : null;
      rows.push({ delta, index: i, key: entry.key, value });
    }
    rows.sort((a, b) => b.value - a.value);
    const visible = rows.slice(0, READOUT_LIMIT);
    return {
      bucket,
      hasPrevious: previous !== null,
      hidden: rows.length - visible.length,
      pct: ((index + 0.5) / chart.buckets.length) * 100,
      rows: visible,
    };
  });

  const barHeight = (total: number) => {
    if (mode() === 'share') {
      return 100;
    }
    const max = data()?.maxBucketTotal ?? 0;
    return max > 0 ? (total / max) * 100 : 0;
  };

  const segOpacity = (modelIndex: number) => {
    const active = hoveredModel();
    if (active === null) {
      return 0.92;
    }
    return active === modelIndex ? 1 : 0.26;
  };

  // A single move handler resolves both the bucket (from x) and the model
  // segment under the cursor (from y, walking the stack), so the ribbon
  // highlight stays in sync with the tooltip without per-segment listeners.
  const updateHover = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const chart = data();
    if (!chart || rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const count = chart.buckets.length;
    const index = Math.max(0, Math.min(count - 1, Math.floor(((event.clientX - rect.left) / rect.width) * count)));
    setHoveredBucket(index);

    const bucket = chart.buckets[index];
    const total = bucket?.total ?? 0;
    const barFraction = barHeight(total) / 100;
    const fromBottom = (rect.bottom - event.clientY) / rect.height;
    if (!bucket || total <= 0 || barFraction <= 0 || fromBottom > barFraction) {
      setHoveredModel(null);
      return;
    }
    const within = fromBottom / barFraction;
    let cumulative = 0;
    let found: number | null = null;
    for (let i = 0; i < chart.series.length; i++) {
      const entry = chart.series[i];
      if (!entry) {
        continue;
      }
      const share = (bucket.byModel.get(entry.key) ?? 0) / total;
      if (share <= 0) {
        continue;
      }
      if (within <= cumulative + share) {
        found = i;
        break;
      }
      cumulative += share;
    }
    setHoveredModel(found);
  };

  const clearHover = () => {
    setHoveredBucket(null);
    setHoveredModel(null);
  };

  return (
    <Panel sub="API value per model over time — hover a model to trace it" title="Model migration">
      <Show fallback={<div class={emptyPanel}>Not enough priced sessions in range</div>} when={data()}>
        {(chart) => (
          <>
            <div class={migrationToolbar}>
              <SegmentedControl
                ariaLabel="Bucket granularity"
                items={GRANULARITY_ITEMS}
                onValueChange={(value) => setGranularity(toGranularity(value))}
                value={granularity()}
              />
              <SegmentedControl
                ariaLabel="Stack mode"
                items={MIGRATION_MODE_ITEMS}
                onValueChange={(value) => setMode(value === 'share' ? 'share' : 'value')}
                value={mode()}
              />
              <span class={migrationToolbarSpacer} />
              <span class={migrationTotal} title="Total API value in range">
                {fmtMoney(chart().grandTotal)}
              </span>
            </div>

            <div class={migrationPlot}>
              <div aria-hidden="true" class={migrationGrid}>
                <For each={gridLines()}>
                  {(line) => (
                    <div class={migrationGridLine} style={{ top: `${100 - line.pct}%` }}>
                      <span class={migrationGridLabel}>{line.label}</span>
                    </div>
                  )}
                </For>
              </div>

              <div aria-hidden="true" class={migrationBars} onMouseLeave={clearHover} onMouseMove={updateHover}>
                <For each={bars()}>
                  {(bar) => (
                    <div class={migrationBar} style={{ height: `${barHeight(bar.total)}%` }}>
                      <For each={bar.segments}>
                        {(segment) => (
                          <div
                            class={cx(migrationSeg, seriesSwatchClass(segment.index))}
                            style={{
                              height: `${bar.total > 0 ? (segment.value / bar.total) * 100 : 0}%`,
                              opacity: segOpacity(segment.index),
                              ...seriesColorStyle(segment.index),
                            }}
                          />
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>

              <Show when={readout()}>
                {(tip) => <div aria-hidden="true" class={migrationCrosshair} style={{ left: `${tip().pct}%` }} />}
              </Show>
            </div>

            <div aria-hidden="true" class={migrationXAxis}>
              <For each={monthTicks()}>
                {(tick) => (
                  <span class={migrationXTick} style={{ left: `${tick.pct}%`, transform: edgeTransform(tick.pct) }}>
                    {tick.label}
                  </span>
                )}
              </For>
            </div>

            <div class={migrationReadout}>
              <Show
                fallback={
                  <span class={migrationReadoutHint}>
                    {fmtDateOnly(chart().first)} – {fmtDateOnly(chart().last)}
                  </span>
                }
                when={readout()}
              >
                {(tip) => (
                  <>
                    <span class={migrationReadoutDate}>{bucketLabel(tip().bucket.date, granularity())}</span>
                    <span class={migrationReadoutTotal}>{fmtMoney(tip().bucket.total)}</span>
                    <For each={tip().rows}>
                      {(row) => (
                        <span
                          class={cx(
                            migrationReadoutItem,
                            row.index === hoveredModel() ? migrationReadoutItemActive : undefined,
                          )}
                        >
                          <span
                            class={cx(migrationReadoutSwatch, seriesSwatchClass(row.index))}
                            style={seriesColorStyle(row.index)}
                          />
                          {row.key}
                          <span class={migrationReadoutValue}>
                            {fmtMoney(row.value)} · {fmtPct((row.value / Math.max(1e-9, tip().bucket.total)) * 100)}
                          </span>
                          <Show
                            when={
                              tip().hasPrevious &&
                              row.delta !== null &&
                              Math.abs(row.delta) >= 1 &&
                              Math.abs(row.delta) < MAX_DELTA_PCT
                            }
                          >
                            <span
                              class={cx(migrationTrend, (row.delta ?? 0) >= 0 ? migrationTrendUp : migrationTrendDown)}
                            >
                              {(row.delta ?? 0) >= 0 ? '▲' : '▼'} {fmtPct(Math.abs(row.delta ?? 0))}
                            </span>
                          </Show>
                        </span>
                      )}
                    </For>
                    <Show when={tip().hidden > 0}>
                      <span class={migrationReadoutHint}>+{tip().hidden} more</span>
                    </Show>
                  </>
                )}
              </Show>
            </div>

            <div class={chartLegendList}>
              <For each={visibleSeries()}>
                {(entry, index) => (
                  <button
                    class={migrationLegendButton}
                    onClick={() => props.onSelectModel(entry.key)}
                    onMouseEnter={() => setHoveredModel(index())}
                    onMouseLeave={() => setHoveredModel(null)}
                    title={`Inspect ${entry.key} — ${fmtMoney(entry.total)}`}
                    type="button"
                  >
                    <span class={cx(chartLegendSwatch, seriesSwatchClass(index()))} style={seriesColorStyle(index())} />
                    {entry.key}
                    <span class={chartLegendPct}>
                      {fmtPct((entry.total / Math.max(1e-9, chart().grandTotal)) * 100)}
                    </span>
                  </button>
                )}
              </For>
              <Show when={chart().series.length > LEGEND_LIMIT}>
                <button class={migrationLegendMore} onClick={() => setShowAllModels((value) => !value)} type="button">
                  {showAllModels() ? 'Show less' : `Show all (${chart().series.length})`}
                </button>
              </Show>
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
        <SegmentBar ariaLabel="Token anatomy" segments={segments()} />
        <div class={anatomyLegend}>
          <For each={segments()}>
            {(segment) => (
              <span class={anatomyLegendItem} title={`${segment.label}: ${fmtNum(segment.value)} tokens`}>
                <span class={cx(anatomyLegendSwatch, segment.class)} />
                {segment.label}
                <span class={anatomyLegendValue}>{fmtCompact(segment.value)}</span>
              </span>
            )}
          </For>
        </div>
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

const SessionShape = (props: {
  campaigns: CampaignView[];
  rows: DashboardRow[];
  onSelectSession: (row: DashboardRow) => void;
}) => {
  const data = createMemo(() => buildSessionShapeData(props.rows, props.campaigns));

  return (
    <Panel sub="Duration × API value (log scales) — click a point to inspect the work" title="Session shape">
      <Show fallback={<div class={emptyPanel}>Not enough timed, priced sessions in range</div>} when={data()}>
        {(chart) => (
          <>
            <div class={scatterWrap}>
              <svg height="100%" role="img" width="100%">
                <title>Session duration versus API value</title>
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
                    // biome-ignore lint/a11y/useSemanticElements: an SVG cannot contain <button>; role is the standard pattern for SVG hit targets
                    <circle
                      aria-label={`Inspect ${item.kind === 'campaign' ? 'campaign' : 'session'}: ${item.label}`}
                      class={cx(harnessSvgFillFor(item.harness), scatterPoint)}
                      cx={`${chart().xPct(item.durationMs)}%`}
                      cy={`${chart().yPct(item.costApprox)}%`}
                      onClick={() => props.onSelectSession(item.row)}
                      r={item.kind === 'campaign' ? '5' : '3.5'}
                      role="button"
                      tabIndex={-1}
                    >
                      <title>
                        {[
                          `${item.label} — ${fmtMoney(item.costApprox)} · ${fmtDuration(item.durationMs)} · ${item.harness}`,
                          item.kind === 'campaign' ? `${fmtNum(item.sessionCount)} sessions` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </title>
                    </circle>
                  )}
                </For>
              </svg>
            </div>
            <div class={scatterLegend}>
              <For each={chart().harnesses}>{(name) => <HarnessBadge name={name} />}</For>
            </div>
          </>
        )}
      </Show>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Punchcard — hour × weekday density. Nightly auto-review bots and weekend
// streaks show up immediately.

const Punchcard = (props: { rows: DashboardRow[] }) => {
  const data = createMemo(() => buildPunchcardData(props.rows));

  return (
    <Panel sub="When the sessions happen — hour of day × weekday" title="Punchcard">
      <Show fallback={<div class={emptyPanel}>No dated sessions in range</div>} when={data()}>
        {(punch) => (
          <div class={punchGrid}>
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
                        <Show when={cell.sessions > 0}>
                          <span
                            class={cx(punchDot, accentFill)}
                            style={{
                              width: `${4 + 9 * Math.sqrt(cell.sessions / punch().maxSessions)}px`,
                              height: `${4 + 9 * Math.sqrt(cell.sessions / punch().maxSessions)}px`,
                              opacity: 0.35 + 0.65 * (cell.sessions / punch().maxSessions),
                            }}
                          />
                        </Show>
                      </span>
                    )}
                  </For>
                </>
              )}
            </For>
            <span />
            <For each={Array.from({ length: 24 }, (_, hour) => hour)}>
              {(hour) => <span class={punchHourLabel}>{hour % 3 === 0 ? hour : ''}</span>}
            </For>
          </div>
        )}
      </Show>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Records — small bragging rights, sober clothes.

const Records = (props: {
  rows: DashboardRow[];
  timelineRows: DashboardRow[];
  onSelectSession: (row: DashboardRow) => void;
  onSelectDay: (day: Date) => void;
}) => {
  const data = createMemo(() => buildOverviewRecords(props.rows, props.timelineRows));

  return (
    <Show when={data()}>
      {(records) => (
        <div class={recordsGrid}>
          <Show when={records().topCost}>
            {(row) => (
              <button class={recordCard} onClick={() => props.onSelectSession(row())} type="button">
                <span class={recordLabel}>Top session</span>
                <span class={recordValue}>{fmtMoney(row().costApprox)}</span>
                <span class={recordSub}>{row().sessionLabel}</span>
              </button>
            )}
          </Show>
          <Show when={records().longest}>
            {(row) => (
              <button class={recordCard} onClick={() => props.onSelectSession(row())} type="button">
                <span class={recordLabel}>Longest session</span>
                <span class={recordValue}>{fmtDuration(row().durationMs)}</span>
                <span class={recordSub}>{row().sessionLabel}</span>
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
// Top sessions — the five most expensive sessions, by name. Session titles
// carry a lot of qualitative signal; surface them.

const TopSessions = (props: {
  campaigns: CampaignView[];
  rows: DashboardRow[];
  onSelectSession: (row: DashboardRow) => void;
}) => {
  const top = createMemo(() => buildTopSessions(props.rows, 5, props.campaigns));

  return (
    <Show when={top().length}>
      <Panel sub="The five most expensive sessions or campaigns in range — click to inspect" title="Top sessions">
        <div class={topList}>
          <For each={top()}>
            {(item, index) => (
              <button class={topRow} onClick={() => props.onSelectSession(item.row)} type="button">
                <span class={topRank}>{index() + 1}</span>
                <span class={topTitle}>
                  {item.label}
                  <Show when={item.kind === 'campaign'}>
                    <span class={muted}> · Campaign · {fmtNum(item.sessionCount)} sessions</span>
                  </Show>
                </span>
                <HarnessBadge name={item.harness} />
                <span class={topMoney}>{fmtMoney(item.costApprox)}</span>
              </button>
            )}
          </For>
        </div>
      </Panel>
    </Show>
  );
};

// ---------------------------------------------------------------------------

export const Overview = (props: OverviewProps) => (
  <Show fallback={<div class={emptyPanel}>No sessions match the current filters</div>} when={props.rows.length}>
    <div class={overviewGrid}>
      <Hero rangeLabel={props.rangeLabel} summary={props.summary} />
      <CalendarHeatmap onSelectDay={props.onSelectDay} rows={props.timelineRows} />
      <div class={twoColumns}>
        <ModelMigration onSelectModel={props.onSelectModel} rows={props.rows} />
        <TokenAnatomy summary={props.summary} />
      </div>
      <div class={twoColumns}>
        <SessionShape campaigns={props.campaigns} onSelectSession={props.onSelectSession} rows={props.rows} />
        <Punchcard rows={props.rows} />
      </div>
      <Records
        onSelectDay={props.onSelectDay}
        onSelectSession={props.onSelectSession}
        rows={props.rows}
        timelineRows={props.timelineRows}
      />
      <TopSessions campaigns={props.campaigns} onSelectSession={props.onSelectSession} rows={props.rows} />
    </div>
  </Show>
);
