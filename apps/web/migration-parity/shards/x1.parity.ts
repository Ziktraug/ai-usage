import { currentRecord, designExportRecords, playwrightTitleRecords } from '../helpers';
import { defineParityShard, type ParityRecord } from '../schema';

const owner = 'X1' as const;
const cutoverCommit = '75161d96109769a3f315565dfe4cf84ab398a708';
const visualConvergenceCommit = '2b70f10c050b2bc8ed5e8750e84f627a947df861';
const filterCorrectionCommit = '006d1065ab7f57e00ac95fd39ea07f0ecf109dfb';
const completeAtCutover = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    {
      commit: cutoverCommit,
      kind: 'command',
      phase: 'target',
      reference: 'Canonical SvelteKit X0/X1 convergence gates preserve this frozen interface.',
    },
    {
      commit: cutoverCommit,
      kind: 'review',
      phase: 'target',
      reference: 'Independent packet reviews and /root/x0_final_review ACCEPT the integrated SvelteKit composition.',
    },
  ],
  status: 'complete',
});

const completeAtVisualConvergence = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    {
      commit: visualConvergenceCommit,
      kind: 'command',
      phase: 'target',
      reference: 'Integrated Svelte visual, responsive, Skills, SSR, and parity-focused gates are green.',
    },
    {
      commit: visualConvergenceCommit,
      kind: 'review',
      phase: 'target',
      reference: '/root/visual_diff_advisor ACCEPT covers visual convergence parity and code quality.',
    },
  ],
  status: 'complete',
});

// Plan 068 reopened after the maintainer reported the Activity brush handles
// rendering unstyled and the chart drawing the whole domain. Unlike the records
// above, this evidence names the consuming module: an export nothing imports
// proves no presentation parity, which is how the semantic layer went dark.
const activityRepairCommits = {
  chrome: '434a563c87c822f3897aedd10f169335ef6b1336',
  colours: 'a0c1a84046e4b98f6ed08a6a42f3ccacf5f63a28',
  brush: 'e7766363f4f9f4343e5248b86bb20469f503f002',
} as const;
const completeAtActivityRepair = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    {
      commit: activityRepairCommits.brush,
      kind: 'source',
      phase: 'target',
      reference:
        'apps/web/src/lib/features/report/overview/activity-timeline.svelte and apps/web/src/lib/features/report/range/report-range-control.svelte import these classes; tools/check-design-export-consumers.ts fails if any loses its last consumer.',
    },
    {
      commit: activityRepairCommits.chrome,
      kind: 'test',
      phase: 'target',
      reference:
        'apps/web/e2e/time-range.spec.ts asserts window clipping, no horizontal overflow, distinct branded series fills, window-scoped legend shares and total, thumb anchoring, pointer drag and a stable drag scale.',
    },
    {
      commit: activityRepairCommits.colours,
      kind: 'review',
      phase: 'target',
      reference:
        'Independent parity and code-quality reviews of the handle work ACCEPTed after rework; every later commit was measured against the Solid baseline at 2183270e with the instrumented capture in the session log.',
    },
  ],
  status: 'complete',
});

// The Session surface sized itself from its own viewport-relative top, so the
// document grew as the reader scrolled. Pre-existing: the Solid table at
// 2183270e did the same and measured worse. Corrected on the maintainer's call,
// which makes this a deliberate behaviour change rather than restored parity.
const sessionScrollCorrectionCommit = '077a281044b6af40a48946f1932612c8cfcf2e79';
const completeAtSessionScrollCorrection = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    {
      commit: sessionScrollCorrectionCommit,
      kind: 'source',
      phase: 'target',
      reference:
        'apps/web/src/session-row-window.ts sizes the surface from the viewport alone, and session-table.svelte no longer recomputes it on window scroll.',
    },
    {
      commit: sessionScrollCorrectionCommit,
      kind: 'command',
      phase: 'target',
      reference:
        'bun run test:e2e; bun run test:e2e-production; bun run --cwd apps/web benchmark:session-scroll — 4/4 with the two DOM triggers recorded in docs/performance/web-framework-migration-baseline.md.',
    },
    {
      commit: sessionScrollCorrectionCommit,
      kind: 'review',
      phase: 'target',
      reference:
        'Maintainer-reported, reproduced and measured on both the Svelte HEAD and the Solid baseline; the maintainer selected the constant-height correction over deferring it to a follow-up plan.',
    },
  ],
  status: 'complete',
});

const completeAtFilterCorrection = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    {
      commit: filterCorrectionCommit,
      kind: 'source',
      phase: 'target',
      reference:
        'apps/web/e2e/production-report.spec.ts proves one revision bootstrap per Sessions filter and sort with no route-load duplicate.',
    },
    {
      commit: filterCorrectionCommit,
      kind: 'command',
      phase: 'target',
      reference: 'Targeted route-load and Sessions tests, Web check/typecheck, Ultracite, and diff-check are green.',
    },
    {
      commit: filterCorrectionCommit,
      kind: 'review',
      phase: 'target',
      reference:
        'Independent filter correction review ACCEPT covers exact acquisition counts and search-param load isolation.',
    },
  ],
  status: 'complete',
});

// The orphaned-export list doubles as a lost-feature detector: these three had no
// consumer and no live equivalent, because the Svelte readout had dropped the
// day-over-day change they styled.
const trendRestorationCommit = '68ddc86002863af047319b54dea70c665931f856';
const completeAtTrendRestoration = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    {
      commit: trendRestorationCommit,
      kind: 'source',
      phase: 'target',
      reference:
        'apps/web/src/lib/features/report/overview/activity-timeline.svelte renders the per-series trend from timelineReadoutFor delta and timelineTrendIsVisible.',
    },
    {
      commit: trendRestorationCommit,
      kind: 'test',
      phase: 'target',
      reference:
        'apps/web/src/lib/features/report/overview/timeline-model.test.ts covers the previous-bucket comparison, the first bucket, a newly appearing series and both visibility thresholds; the deterministic fixture cannot render a visible trend.',
    },
    {
      commit: trendRestorationCommit,
      kind: 'review',
      phase: 'target',
      reference:
        'Restored to the retired Solid contract at 2183270e: ((value - prior) / prior) * 100, null without a prior value, hidden below one percent and at or above a thousand.',
    },
  ],
  status: 'complete',
});

export default defineParityShard({
  owner,
  records: [
    ...[
      currentRecord(owner, {
        currentOwner: 'apps/web/vite-production-build.ts; apps/web/start.mjs; tools/check-web-production-start.ts',
        evidence: [
          { kind: 'command', reference: 'bun run test:web-production' },
          { kind: 'command', reference: 'bun run test:web-dev-build-isolation' },
          { kind: 'command', reference: 'bun run test:setup-loopback' },
        ],
        id: 'OPS-02',
        kind: 'feature',
      }),
    ].map(completeAtCutover),
    ...designExportRecords(owner, [
      {
        entrypoint: './svelte',
        names: 'ghostButton pendingButton',
        source: 'packages/design-system/src/components/button.ts',
      },
      { entrypoint: './svelte', names: 'searchInput', source: 'packages/design-system/src/components/field.ts' },
      {
        entrypoint: './svelte',
        names: 'activeFilters filterSummary headerActions headerTop summaryPill',
        source: 'packages/design-system/src/components/layout.ts',
      },
      {
        entrypoint: './svelte',
        names: 'banner bannerError bannerOk statusPill statusPillDanger statusPillInfo statusPillOk statusPillWarn',
        source: 'packages/design-system/src/components/status.ts',
      },
      { entrypoint: './svelte', names: 'muted strongCell', source: 'packages/design-system/src/components/table.ts' },
      {
        entrypoint: './svelte',
        names:
          'timeChartOptions timeChartOptionsCurrent timeChartOptionsSummary timeChartOptionsTitle timeRangeViewControls',
        source: 'packages/design-system/src/components/time-slider.ts',
      },
    ]).map(completeAtVisualConvergence),
    ...playwrightTitleRecords(owner, [
      {
        file: 'apps/web/e2e/time-range.spec.ts',
        title: 'wraps chart options without horizontal clipping below the frozen narrow viewport',
      },
    ]).map(completeAtVisualConvergence),
    ...playwrightTitleRecords(owner, [
      {
        file: 'apps/web/e2e/production-report.spec.ts',
        title: 'acquires one revision bootstrap per Sessions filter and sort without route-load duplicates',
      },
    ]).map(completeAtFilterCorrection),
    ...designExportRecords(owner, [
      {
        entrypoint: './report',
        names: 'accentFill',
        source: 'packages/design-system/src/components/chart.ts',
      },
      {
        entrypoint: './svelte',
        names: 'accentFill DimensionSwatch dimensionSwatch migrationCrosshair',
        source: 'packages/design-system/src/components/chart.ts',
      },
      {
        entrypoint: './svelte',
        names: `
          monthGridline timelineHoverLayer timeSliderBrushColumn timeSliderBrushTrack timeSliderDimLeft
          timeSliderDimRight timeSliderRange timeSliderRangeDrag timeSliderThumb
        `,
        source: 'packages/design-system/src/components/time-slider.ts',
      },
    ]).map(completeAtActivityRepair),
    ...playwrightTitleRecords(
      owner,
      [
        'anchors the brush handles to the selected report window at every viewport',
        'announces each brush handle as a slider over the day it selects',
        'drags a brush handle with the pointer and keeps it on the selection edge',
        'draws only the selected report range and never overflows the plot',
        'fills harness series with their branded tokens rather than one hashed hue',
        'holds the brush scale still while dragging a range that starts before the data',
        'reports legend shares and the range total over the selected window',
      ].map((title) => ({ file: 'apps/web/e2e/time-range.spec.ts', title })),
    ).map(completeAtActivityRepair),
    ...playwrightTitleRecords(owner, [
      {
        file: 'apps/web/e2e/session-viewport-geometry.spec.ts',
        title: 'keeps the document height still while the Session surface is scrolled past',
      },
    ]).map(completeAtSessionScrollCorrection),
    ...designExportRecords(owner, [
      {
        entrypoint: './svelte',
        names: 'migrationTrend migrationTrendDown migrationTrendUp',
        source: 'packages/design-system/src/components/chart.ts',
      },
    ]).map(completeAtTrendRestoration),
  ],
});
