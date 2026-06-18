import { cx } from '@ai-usage/design-system/css';
import {
  accentFill,
  anatomyHeadline,
  anatomyLegend,
  anatomyLegendItem,
  anatomyLegendSwatch,
  anatomyLegendValue,
  chartAxis,
  chartFillClasses,
  chartLegendItem,
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
  migrationArea,
  migrationSvgWrap,
  otherFillClass,
  otherSwatchClass,
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
import { createEffect, createMemo, For, type JSX, Show } from 'solid-js';
import { DAY_MS, shiftCalendarDays, startOfDay, toDateInputValue } from './date-range';
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

export type OverviewProps = {
  rows: DashboardRow[];
  timelineRows: DashboardRow[];
  summary: ReportSummary;
  rangeLabel: string;
  onSelectSession: (row: DashboardRow) => void;
  onSelectDay: (day: Date) => void;
};

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
    if (summary.totalCost <= 0) return null;
    const covered = summary.costQuota || Math.max(0, summary.totalCost - summary.actualCost);
    const multiple = summary.actualCost > 0.005 ? summary.totalCost / summary.actualCost : null;
    return { covered, multiple, summary };
  });

  return (
    <Show when={data()}>
      {(hero) => (
        <section class={heroPanel} aria-label="Subscription leverage">
          <div>
            <div class={heroLabel}>Subscription leverage</div>
            <div class={heroValue}>{fmtMoney(hero().covered)}</div>
            <div class={heroText}>
              of subscription value absorbed by quotas ({props.rangeLabel}) — you actually paid{' '}
              {fmtMoney(hero().summary.actualCost)} across {fmtNum(hero().summary.sessionCount)} sessions.
            </div>
          </div>
          <div class={heroSide}>
            <Show when={hero().multiple} fallback={<span class={heroMultiple}>fully covered by subscriptions</span>}>
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

type HeatDay = { cost: number; date: Date; level: number; sessions: number };
type HeatWeek = { days: (HeatDay | null)[] };

const CalendarHeatmap = (props: { rows: DashboardRow[]; onSelectDay: (day: Date) => void }) => {
  let scrollEl: HTMLDivElement | undefined;

  const data = createMemo(() => {
    const byDay = new Map<string, { cost: number; sessions: number }>();
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    for (const row of props.rows) {
      if (row.activeTime == null) continue;
      minTime = Math.min(minTime, row.activeTime);
      maxTime = Math.max(maxTime, row.activeTime);
      const key = toDateInputValue(startOfDay(new Date(row.activeTime)));
      let entry = byDay.get(key);
      if (!entry) {
        entry = { cost: 0, sessions: 0 };
        byDay.set(key, entry);
      }
      if (row.costKnown) entry.cost += row.costApprox;
      entry.sessions++;
    }
    if (!byDay.size) return null;

    const last = startOfDay(new Date(maxTime));
    let first = startOfDay(new Date(minTime));
    // Two years of day cells is the ceiling; beyond that the tail dominates
    // the DOM without adding signal.
    if ((last.getTime() - first.getTime()) / DAY_MS > 730) first = shiftCalendarDays(last, -730);
    const gridStart = shiftCalendarDays(first, -((first.getDay() + 6) % 7));

    const useCost = [...byDay.values()].some((entry) => entry.cost > 0);
    const sorted = [...byDay.values()]
      .map((entry) => (useCost ? entry.cost : entry.sessions))
      .filter((value) => value > 0)
      .sort((a, b) => a - b);
    const quantile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    const thresholds = [quantile(0.25), quantile(0.5), quantile(0.75)];

    const todayKey = toDateInputValue(startOfDay(new Date()));
    const weeks: HeatWeek[] = [];
    const monthLabels: string[] = [];
    let previousMonth = -1;
    for (let cursor = gridStart; cursor <= last; cursor = shiftCalendarDays(cursor, 7)) {
      const days: (HeatDay | null)[] = [];
      for (let offset = 0; offset < 7; offset++) {
        const date = shiftCalendarDays(cursor, offset);
        if (date < first || date > last) {
          days.push(null);
          continue;
        }
        const entry = byDay.get(toDateInputValue(date));
        const value = entry ? (useCost ? entry.cost : entry.sessions) : 0;
        days.push({
          date,
          cost: entry?.cost ?? 0,
          sessions: entry?.sessions ?? 0,
          level: value <= 0 ? 0 : 1 + thresholds.filter((threshold) => value > threshold).length,
        });
      }
      weeks.push({ days });
      const month = cursor.getMonth();
      monthLabels.push(month === previousMonth ? '' : cursor.toLocaleDateString('en', { month: 'short' }));
      previousMonth = month;
    }
    return { weeks, monthLabels, useCost, todayKey };
  });

  // Most recent activity matters most: keep the right edge in view.
  createEffect(() => {
    if (data() && scrollEl) scrollEl.scrollLeft = scrollEl.scrollWidth;
  });

  return (
    <Panel
      title="Rhythm"
      sub="Daily activity across the whole filtered history — click a day to focus the dashboard on it"
    >
      <Show when={data()} fallback={<div class={emptyPanel}>No dated sessions match the current filters</div>}>
        {(heat) => (
          <>
            <div class={heatBody}>
              <div class={heatWeekdays} aria-hidden="true">
                <span>Mon</span>
                <span />
                <span>Wed</span>
                <span />
                <span>Fri</span>
                <span />
                <span />
              </div>
              <div class={heatScroll} ref={scrollEl}>
                <div class={heatMonths} aria-hidden="true">
                  <For each={heat().monthLabels}>{(label) => <span>{label}</span>}</For>
                </div>
                <div class={heatGrid}>
                  <For each={heat().weeks}>
                    {(week) => (
                      <div class={heatWeekColumn}>
                        <For each={week.days}>
                          {(day) => (
                            <Show when={day} fallback={<span />}>
                              {(cell) => (
                                <button
                                  type="button"
                                  class={cx(
                                    heatCell,
                                    cell().level === 0 ? heatCellZero : accentFill,
                                    toDateInputValue(cell().date) === heat().todayKey ? heatCellToday : undefined,
                                  )}
                                  style={cell().level > 0 ? { opacity: HEAT_OPACITY[cell().level - 1] } : undefined}
                                  title={`${fmtDateOnly(cell().date)} — ${fmtMoney(cell().cost)} · ${fmtNum(cell().sessions)} sessions`}
                                  aria-label={`Focus on ${fmtDateOnly(cell().date)}`}
                                  onClick={() => props.onSelectDay(cell().date)}
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
// Model migration — normalized stacked area of API value share per bucket.
// This is where opus→fable and gpt-5.4→5.5 transitions become visible.

type MigrationSeries = { key: string; total: number; fillClass: string; swatchClass: string };

const ModelMigration = (props: { rows: DashboardRow[] }) => {
  const data = createMemo(() => {
    const dated = props.rows.filter(
      (row) => row.activeTime != null && row.costKnown && row.costApprox > 0,
    ) as (DashboardRow & { activeTime: number })[];
    if (dated.length < 2) return null;

    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    for (const row of dated) {
      minTime = Math.min(minTime, row.activeTime);
      maxTime = Math.max(maxTime, row.activeTime);
    }
    const spanDays = (maxTime - minTime) / DAY_MS;
    const weekly = spanDays > 42;
    const bucketStart = (date: Date) => {
      const day = startOfDay(date);
      return weekly ? shiftCalendarDays(day, -((day.getDay() + 6) % 7)) : day;
    };

    const firstBucket = bucketStart(new Date(minTime));
    const lastBucket = bucketStart(new Date(maxTime));
    const buckets: { date: Date; byModel: Map<string, number>; total: number }[] = [];
    const bucketIndex = new Map<string, number>();
    for (let cursor = firstBucket; cursor <= lastBucket; cursor = shiftCalendarDays(cursor, weekly ? 7 : 1)) {
      bucketIndex.set(toDateInputValue(cursor), buckets.length);
      buckets.push({ date: cursor, byModel: new Map(), total: 0 });
    }
    if (buckets.length < 2) return null;

    const totals = new Map<string, number>();
    for (const row of dated) {
      const index = bucketIndex.get(toDateInputValue(bucketStart(new Date(row.activeTime))));
      if (index === undefined) continue;
      const bucket = buckets[index];
      if (!bucket) continue;
      bucket.byModel.set(row.modelKey, (bucket.byModel.get(row.modelKey) ?? 0) + row.costApprox);
      bucket.total += row.costApprox;
      totals.set(row.modelKey, (totals.get(row.modelKey) ?? 0) + row.costApprox);
    }

    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 5);
    const otherTotal = ranked.slice(5).reduce((sum, [, value]) => sum + value, 0);
    const grandTotal = ranked.reduce((sum, [, value]) => sum + value, 0);

    const series: MigrationSeries[] = top.map(([key, total], index) => ({
      key,
      total,
      fillClass: chartFillClasses[index] ?? otherFillClass,
      swatchClass: chartSwatchClasses[index] ?? otherSwatchClass,
    }));
    if (otherTotal > 0) {
      series.push({ key: 'other', total: otherTotal, fillClass: otherFillClass, swatchClass: otherSwatchClass });
    }

    const x = (index: number) => (index / (buckets.length - 1)) * 100;
    const topKeys = top.map(([key]) => key);
    const shareFor = (bucket: { byModel: Map<string, number>; total: number }, key: string) => {
      if (bucket.total <= 0) return 0;
      if (key === 'other') {
        const topSum = topKeys.reduce((sum, topKey) => sum + (bucket.byModel.get(topKey) ?? 0), 0);
        return Math.max(0, bucket.total - topSum) / bucket.total;
      }
      return (bucket.byModel.get(key) ?? 0) / bucket.total;
    };
    const paths = series.map((entry, seriesIdx) => {
      const upper: string[] = [];
      const lower: string[] = [];
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        if (!bucket) continue;
        let cumBefore = 0;
        for (let k = 0; k < seriesIdx; k++) cumBefore += shareFor(bucket, series[k]?.key ?? '');
        const own = shareFor(bucket, entry.key);
        upper.push(`${x(i).toFixed(2)},${(100 - (cumBefore + own) * 100).toFixed(2)}`);
        lower.push(`${x(i).toFixed(2)},${(100 - cumBefore * 100).toFixed(2)}`);
      }
      return `M${upper.join(' L')} L${lower.reverse().join(' L')} Z`;
    });

    return {
      buckets,
      grandTotal,
      paths,
      series,
      weekly,
      first: buckets[0]?.date ?? firstBucket,
      last: buckets[buckets.length - 1]?.date ?? lastBucket,
    };
  });

  return (
    <Panel title="Model migration" sub="Share of API value per model over time">
      <Show when={data()} fallback={<div class={emptyPanel}>Not enough priced sessions in range</div>}>
        {(chart) => (
          <>
            <div class={migrationSvgWrap}>
              <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" role="img">
                <title>Share of API value per model over time</title>
                <For each={chart().paths}>
                  {(path, index) => (
                    <path class={cx(chart().series[index()]?.fillClass, migrationArea)} d={path}>
                      <title>
                        {chart().series[index()]?.key} — {fmtMoney(chart().series[index()]?.total ?? 0)} (
                        {fmtPct(((chart().series[index()]?.total ?? 0) / Math.max(1e-9, chart().grandTotal)) * 100)})
                      </title>
                    </path>
                  )}
                </For>
              </svg>
            </div>
            <div class={chartAxis}>
              <span>{fmtDateOnly(chart().first)}</span>
              <span>{chart().weekly ? 'weekly buckets' : 'daily buckets'}</span>
              <span>{fmtDateOnly(chart().last)}</span>
            </div>
            <div class={chartLegendList}>
              <For each={chart().series}>
                {(entry) => (
                  <span class={chartLegendItem} title={fmtMoney(entry.total)}>
                    <span class={cx(chartLegendSwatch, entry.swatchClass)} />
                    {entry.key}
                    <span class={chartLegendPct}>
                      {fmtPct((entry.total / Math.max(1e-9, chart().grandTotal)) * 100)}
                    </span>
                  </span>
                )}
              </For>
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
    <Panel title="Token anatomy" sub="Where the volume actually goes">
      <Show when={total() > 0} fallback={<div class={emptyPanel}>No token data in range</div>}>
        <div class={anatomyHeadline}>
          <strong>{fmtPct(cachePct())}</strong> of all token volume was read from cache — context reuse is what makes
          agentic sessions affordable.
        </div>
        <SegmentBar segments={segments()} ariaLabel="Token anatomy" />
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

const DURATION_TICKS = [
  { value: 60_000, label: '1m' },
  { value: 600_000, label: '10m' },
  { value: 3_600_000, label: '1h' },
  { value: 14_400_000, label: '4h' },
];

const COST_TICKS = [
  { value: 0.01, label: '$0.01' },
  { value: 0.1, label: '$0.10' },
  { value: 1, label: '$1' },
  { value: 10, label: '$10' },
  { value: 100, label: '$100' },
];

const SessionShape = (props: { rows: DashboardRow[]; onSelectSession: (row: DashboardRow) => void }) => {
  const data = createMemo(() => {
    const points = props.rows.filter(
      (row) => (row.durationMs ?? 0) > 0 && row.costKnown && row.costApprox > 0,
    ) as (DashboardRow & { durationMs: number })[];
    if (points.length < 3) return null;

    let xMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    for (const row of points) {
      xMin = Math.min(xMin, row.durationMs);
      xMax = Math.max(xMax, row.durationMs);
      yMin = Math.min(yMin, row.costApprox);
      yMax = Math.max(yMax, row.costApprox);
    }
    const lx = (value: number) => Math.log10(value);
    const xLo = lx(xMin) - 0.08;
    const xHi = lx(xMax) + 0.08;
    const yLo = lx(yMin) - 0.12;
    const yHi = lx(yMax) + 0.12;
    const xPct = (value: number) => 4 + ((lx(value) - xLo) / Math.max(1e-9, xHi - xLo)) * 92;
    const yPct = (value: number) => 92 - ((lx(value) - yLo) / Math.max(1e-9, yHi - yLo)) * 84;

    const harnesses = [...new Set(points.map((row) => row.harness))];
    return {
      points: points.slice(0, 2000),
      xPct,
      yPct,
      xTicks: DURATION_TICKS.filter((tick) => tick.value >= xMin && tick.value <= xMax),
      yTicks: COST_TICKS.filter((tick) => tick.value >= yMin && tick.value <= yMax),
      harnesses,
    };
  });

  return (
    <Panel title="Session shape" sub="Duration × API value (log scales) — click a point to inspect the session">
      <Show when={data()} fallback={<div class={emptyPanel}>Not enough timed, priced sessions in range</div>}>
        {(chart) => (
          <>
            <div class={scatterWrap}>
              <svg width="100%" height="100%" role="img">
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
                      <text class={scatterAxisText} x={`${chart().xPct(tick.value)}%`} y="100%" dy="-5" dx="3">
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
                      <text class={scatterAxisText} x="4" y={`${chart().yPct(tick.value)}%`} dy="-3">
                        {tick.label}
                      </text>
                    </>
                  )}
                </For>
                <For each={chart().points}>
                  {(row) => (
                    // biome-ignore lint/a11y/useSemanticElements: an SVG cannot contain <button>; role is the standard pattern for SVG hit targets
                    <circle
                      class={cx(harnessSvgFillFor(row.harness), scatterPoint)}
                      cx={`${chart().xPct(row.durationMs)}%`}
                      cy={`${chart().yPct(row.costApprox)}%`}
                      r="3.5"
                      role="button"
                      aria-label={`Inspect session: ${row.sessionLabel}`}
                      tabIndex={-1}
                      onClick={() => props.onSelectSession(row)}
                    >
                      <title>
                        {row.sessionLabel} — {fmtMoney(row.costApprox)} · {fmtDuration(row.durationMs)} · {row.harness}
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

const PUNCH_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const Punchcard = (props: { rows: DashboardRow[] }) => {
  const data = createMemo(() => {
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ cost: 0, sessions: 0 })));
    let maxSessions = 0;
    for (const row of props.rows) {
      if (row.activeTime == null) continue;
      const date = new Date(row.activeTime);
      const cell = cells[(date.getDay() + 6) % 7]?.[date.getHours()];
      if (!cell) continue;
      cell.sessions++;
      if (row.costKnown) cell.cost += row.costApprox;
      maxSessions = Math.max(maxSessions, cell.sessions);
    }
    return maxSessions > 0 ? { cells, maxSessions } : null;
  });

  return (
    <Panel title="Punchcard" sub="When the sessions happen — hour of day × weekday">
      <Show when={data()} fallback={<div class={emptyPanel}>No dated sessions in range</div>}>
        {(punch) => (
          <div class={punchGrid}>
            <For each={punch().cells}>
              {(dayCells, dayIndex) => (
                <>
                  <span class={punchDayLabel} aria-hidden="true">
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
  const data = createMemo(() => {
    const priced = props.rows.filter((row) => row.costKnown && row.costApprox > 0);
    const topCost = priced.reduce<DashboardRow | null>(
      (best, row) => (best == null || row.costApprox > best.costApprox ? row : best),
      null,
    );
    const longest = props.rows.reduce<DashboardRow | null>(
      (best, row) =>
        (row.durationMs ?? 0) > 0 && (best == null || (row.durationMs ?? 0) > (best.durationMs ?? 0)) ? row : best,
      null,
    );

    const byDay = new Map<string, { cost: number; date: Date; sessions: number }>();
    for (const row of props.rows) {
      if (row.activeTime == null) continue;
      const day = startOfDay(new Date(row.activeTime));
      const key = toDateInputValue(day);
      let entry = byDay.get(key);
      if (!entry) {
        entry = { cost: 0, date: day, sessions: 0 };
        byDay.set(key, entry);
      }
      if (row.costKnown) entry.cost += row.costApprox;
      entry.sessions++;
    }
    const busiest = [...byDay.values()].reduce<{ cost: number; date: Date; sessions: number } | null>(
      (best, entry) =>
        best == null || entry.cost > best.cost || (entry.cost === best.cost && entry.sessions > best.sessions)
          ? entry
          : best,
      null,
    );

    // Streak is a property of the whole history, not of the brushed window.
    const streakDays = new Set<string>();
    let lastDay: Date | null = null;
    for (const row of props.timelineRows) {
      if (row.activeTime == null) continue;
      const day = startOfDay(new Date(row.activeTime));
      streakDays.add(toDateInputValue(day));
      if (!lastDay || day > lastDay) lastDay = day;
    }
    let streak = 0;
    if (lastDay) {
      for (let cursor = lastDay; streakDays.has(toDateInputValue(cursor)); cursor = shiftCalendarDays(cursor, -1)) {
        streak++;
      }
    }

    if (!topCost && !longest && !busiest && streak === 0) return null;
    return { topCost, longest, busiest, streak, streakEnd: lastDay };
  });

  return (
    <Show when={data()}>
      {(records) => (
        <div class={recordsGrid}>
          <Show when={records().topCost}>
            {(row) => (
              <button type="button" class={recordCard} onClick={() => props.onSelectSession(row())}>
                <span class={recordLabel}>Top session</span>
                <span class={recordValue}>{fmtMoney(row().costApprox)}</span>
                <span class={recordSub}>{row().sessionLabel}</span>
              </button>
            )}
          </Show>
          <Show when={records().longest}>
            {(row) => (
              <button type="button" class={recordCard} onClick={() => props.onSelectSession(row())}>
                <span class={recordLabel}>Longest session</span>
                <span class={recordValue}>{fmtDuration(row().durationMs)}</span>
                <span class={recordSub}>{row().sessionLabel}</span>
              </button>
            )}
          </Show>
          <Show when={records().busiest}>
            {(day) => (
              <button type="button" class={recordCard} onClick={() => props.onSelectDay(day().date)}>
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
              <button type="button" class={recordCard} onClick={() => props.onSelectDay(end())}>
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

const TopSessions = (props: { rows: DashboardRow[]; onSelectSession: (row: DashboardRow) => void }) => {
  const top = createMemo(() =>
    props.rows
      .filter((row) => row.costKnown && row.costApprox > 0)
      .sort((a, b) => b.costApprox - a.costApprox)
      .slice(0, 5),
  );

  return (
    <Show when={top().length}>
      <Panel title="Top sessions" sub="The five most expensive sessions in range — click to inspect">
        <div class={topList}>
          <For each={top()}>
            {(row, index) => (
              <button type="button" class={topRow} onClick={() => props.onSelectSession(row)}>
                <span class={topRank}>{index() + 1}</span>
                <span class={topTitle}>{row.sessionLabel}</span>
                <HarnessBadge name={row.harness} />
                <span class={topMoney}>{fmtMoney(row.costApprox)}</span>
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
  <Show when={props.rows.length} fallback={<div class={emptyPanel}>No sessions match the current filters</div>}>
    <div class={overviewGrid}>
      <Hero summary={props.summary} rangeLabel={props.rangeLabel} />
      <CalendarHeatmap rows={props.timelineRows} onSelectDay={props.onSelectDay} />
      <div class={twoColumns}>
        <ModelMigration rows={props.rows} />
        <TokenAnatomy summary={props.summary} />
      </div>
      <div class={twoColumns}>
        <SessionShape rows={props.rows} onSelectSession={props.onSelectSession} />
        <Punchcard rows={props.rows} />
      </div>
      <Records
        rows={props.rows}
        timelineRows={props.timelineRows}
        onSelectSession={props.onSelectSession}
        onSelectDay={props.onSelectDay}
      />
      <TopSessions rows={props.rows} onSelectSession={props.onSelectSession} />
    </div>
  </Show>
);
