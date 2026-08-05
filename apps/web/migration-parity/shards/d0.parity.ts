import { currentRecord, designExportRecords } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'D0' as const;
const cutoverCommit = '75161d96109769a3f315565dfe4cf84ab398a708';
const completeCurrentAtCutover = (record: ParityRecord): ParityRecord =>
  record.status === 'current'
    ? {
        ...record,
        evidence: [
          ...record.evidence,
          {
            commit: cutoverCommit,
            kind: 'test',
            phase: 'target',
            reference: 'Canonical Svelte icon consumers pass accessibility and settled visual parity gates.',
          },
          {
            commit: cutoverCommit,
            kind: 'review',
            phase: 'target',
            reference:
              'Independent feature packet reviews and /root/x0_final_review ACCEPT the final icon presentation.',
          },
        ],
        status: 'complete',
      }
    : record;
const foundationCommit = '6c6d6c4ebe134d980dd630a13ab53086e38aa142';
const finalD0Commit = '8474f185f0bef832bae5bb0338f1af316ba02401';
const d4Commit = '6646fe568e8b4c1fba74ac1b4150d1480d15ca6f';
const r1Commit = '7c85cf198ca2af004b53eef182a727f59d4ab5e4';
const seriesColorCommit = '3f42bfa8457659157ddbd89f720aa05a355bae4a';
const targetEvidence = (commit: string, kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit,
  kind,
  phase: 'target',
  reference,
});
const appendTargetEvidence = (record: ParityRecord, evidence: readonly ParityEvidence[]): ParityRecord => ({
  ...record,
  evidence: [...record.evidence, ...evidence],
});
const completeRecord = (record: ParityRecord, evidence: readonly ParityEvidence[]): ParityRecord => ({
  ...appendTargetEvidence(record, evidence),
  status: 'complete',
});
const retainedPublicCompositionEvidence = [
  targetEvidence(
    finalD0Commit,
    'command',
    'bun tools/check-public-package-exports.ts; bun tools/check-package-boundaries.ts (green at integrated D0 checkpoint)',
  ),
  targetEvidence(
    finalD0Commit,
    'review',
    'D0 ACCEPT covers the neutral passive foundation only; Plan 068 D4 still owns public /solid, /svelte, and report composition.',
  ),
] as const;
const d4CompositionEvidence = [
  targetEvidence(
    d4Commit,
    'source',
    'packages/design-system/package.json; packages/design-system/src/index.ts; packages/design-system/src/report.ts; packages/design-system/src/solid.ts; packages/design-system/src/svelte.ts; packages/design-system/panda.config.ts',
  ),
  targetEvidence(
    d4Commit,
    'test',
    'packages/design-system/src/design-entrypoints.test.ts proves explicit framework entrypoints, Svelte dependency closure, and aggregate Panda source coverage',
  ),
  targetEvidence(
    d4Commit,
    'command',
    'bun --filter @ai-usage/design-system build; bun --bun tsc -p packages/design-system/tsconfig.json --noEmit; bun test packages/design-system/src/design-entrypoints.test.ts packages/design-system/src/svelte/passive/passive-closure.test.ts; bun run --cwd apps/web check; bun run --cwd apps/web build:svelte (all green)',
  ),
  targetEvidence(
    d4Commit,
    'measurement',
    'Generated CSS and panda.buildinfo remain unchanged; Svelte bundle 263392 bytes <= Solid baseline 282614 bytes.',
  ),
  targetEvidence(
    d4Commit,
    'review',
    '/root/d4_review ACCEPT: public export composition, framework isolation, generated artifacts, and bundle budget accepted.',
  ),
] as const;
const completeForD4 = (record: ParityRecord): ParityRecord =>
  completeRecord(appendTargetEvidence(record, retainedPublicCompositionEvidence), d4CompositionEvidence);
const completeNewForR1 = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    targetEvidence(
      r1Commit,
      'source',
      `packages/design-system/src/svelte.ts; ${record.currentOwner}; apps/web/src/lib/features/shell/theme-toggle.svelte; apps/web/src/lib/features/shell/error-shell.svelte; apps/web/src/lib/features/shell/route-frame.svelte`,
    ),
    targetEvidence(
      r1Commit,
      'test',
      'packages/design-system/src/design-entrypoints.test.ts; apps/web/e2e/svelte-shell.spec.ts',
    ),
    targetEvidence(
      r1Commit,
      'command',
      'bun run lint; bun run typecheck; bun run test; bun run build; bun run --cwd apps/web test:e2e-svelte-shadow (all green)',
    ),
    targetEvidence(
      r1Commit,
      'review',
      '/root/d123_parity_review code-quality/seams ACCEPT and /root/q2_spec_review parity/spec ACCEPT cover the R1 public Svelte shell export delta',
    ),
  ],
  status: 'complete',
});
const completeSeriesColorExport = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    targetEvidence(
      seriesColorCommit,
      'source',
      'packages/design-system/src/svelte.ts exports stableSeriesColor from the framework-neutral chart module.',
    ),
    targetEvidence(
      seriesColorCommit,
      'test',
      'packages/design-system/src/design-entrypoints.test.ts; packages/design-system/src/components/chart.test.ts',
    ),
    targetEvidence(
      seriesColorCommit,
      'review',
      '/root/v34_parity ACCEPT covers the public export, dependency closure, deterministic colors, and P2 segment/legend parity.',
    ),
  ],
  status: 'complete',
});
const punchcardRepairCommit = '68b9a8c6ee43c771804747c0125ed8419ef1f50d';
const punchcardRepairExportIds = new Set([
  'design-export:./report::advancedAnalysis',
  'design-export:./report::advancedAnalysisContent',
  'design-export:./report::advancedAnalysisHeader',
  'design-export:./report::advancedAnalysisHeaderText',
  'design-export:./report::overviewGrid',
  'design-export:./report::punchCell',
  'design-export:./report::punchCellButton',
  'design-export:./report::punchDayLabel',
  'design-export:./report::punchDot',
  'design-export:./report::punchGrid',
  'design-export:./report::punchHourLabel',
  'design-export:./report::punchIntensityKey',
  'design-export:./report::punchIntensityKeyCell',
]);
const recordPunchcardRepair = (record: ParityRecord): ParityRecord =>
  punchcardRepairExportIds.has(record.id)
    ? appendTargetEvidence(record, [
        targetEvidence(
          punchcardRepairCommit,
          'command',
          'bun run --cwd apps/web test:e2e -- e2e/dashboard-presentation.spec.ts --grep "uses one fixed-size Punchcard intensity channel"; bun tools/check-design-export-consumers.ts; bun run test:web-migration-parity (green)',
        ),
        targetEvidence(
          punchcardRepairCommit,
          'measurement',
          'Solid 2183270e differential at 361/768/1024/1440 in light/dark and SSR/hydrated: 24px square fills, 2px grid gap and radius, full-row sole panel, matching semantic colors and legend.',
        ),
        targetEvidence(
          punchcardRepairCommit,
          'review',
          'Presentation-parity review against the running Solid control confirmed the restored export consumers across all 16 viewport/theme/runtime combinations; the orphan-export debt fell from 167 to 154.',
        ),
      ])
    : record;
const breakdownRepairCommit = '2eee573caaa4cd6f38ec67c34797e56bb614e1c6';
const breakdownRepairExportIds = new Set([
  'design-export:./report::groupCount',
  'design-export:./report::groupPanel',
  'design-export:./report::groupPct',
  'design-export:./report::groupRow',
  'design-export:./report::groupRows',
  'design-export:./report::groupSub',
  'design-export:./report::groupValue',
]);
const breakdownRepairEvidence = [
  targetEvidence(
    breakdownRepairCommit,
    'command',
    'bun run --cwd apps/web typecheck; bun test apps/web/src/lib/features/report/breakdown packages/design-system/src/design-entrypoints.test.ts; bun run --cwd apps/web test:e2e -- e2e/value-presentation.spec.ts; bun tools/check-design-export-consumers.ts (green)',
  ),
  targetEvidence(
    breakdownRepairCommit,
    'measurement',
    'Hydrated Solid 2183270e differential at 361/768/1024/1440 in light/dark: exact row and track geometry, semantic harness colours, integer shares, rounded fills, partial-state inset, and 30px narrow sharing actions at all eight points.',
  ),
  targetEvidence(
    breakdownRepairCommit,
    'review',
    'Presentation-parity review against the running Solid control confirmed the restored Breakdown export consumers; the orphan-export debt fell from 154 to 147. Direct Svelte SSR remains the settled loading fallback and was recorded rather than reworked.',
  ),
] as const;
const recordBreakdownRepair = (record: ParityRecord): ParityRecord =>
  breakdownRepairExportIds.has(record.id) ? appendTargetEvidence(record, breakdownRepairEvidence) : record;
const completeNewForBreakdown = (record: ParityRecord): ParityRecord => completeRecord(record, breakdownRepairEvidence);
const designRow = (id: string, currentOwner: string, evidence: string) =>
  currentRecord(owner, {
    currentOwner,
    evidence: [{ kind: 'test', reference: evidence }],
    id,
    kind: 'design-row',
  });

export default defineParityShard({
  owner,
  records: [
    completeRecord(
      designRow(
        'design:preset-global-css',
        'packages/design-system/src/preset.ts; apps/web/src/styles.css',
        'packages/design-system/src/preset.test.ts; apps/web/src/design-system-contract.test.ts',
      ),
      [
        targetEvidence(
          foundationCommit,
          'source',
          'packages/design-system/src/preset.ts; packages/design-system/src/svelte/passive/harness-fill.ts',
        ),
        targetEvidence(
          finalD0Commit,
          'test',
          'packages/design-system/src/preset.test.ts; packages/design-system/src/svelte/passive/design-artifact-parity.test.ts',
        ),
        targetEvidence(
          finalD0Commit,
          'command',
          'bun --filter @ai-usage/design-system build; generated styles.css and panda.buildinfo.json are byte-identical to the accepted baseline',
        ),
        targetEvidence(finalD0Commit, 'review', 'D0 independent parity/spec and code-quality ACCEPT.'),
      ],
    ),
    // D4 completes public report and framework composition on top of D0 passive closure evidence.
    completeForD4(
      designRow(
        'design:semantic-style-exports',
        'packages/design-system/src/report.ts',
        'apps/web/src/design-system-contract.test.ts',
      ),
    ),
    completeRecord(
      designRow(
        'design:passive-style-modules',
        'packages/design-system/src/components/*.ts',
        'packages/design-system/src/preset.test.ts; apps/web/src/design-system-contract.test.ts',
      ),
      [
        targetEvidence(
          foundationCommit,
          'source',
          'packages/design-system/src/components/*.ts; packages/design-system/src/svelte/passive/harness-fill.ts',
        ),
        targetEvidence(
          finalD0Commit,
          'test',
          'packages/design-system/src/svelte/passive/passive-closure.test.ts; packages/design-system/src/svelte/passive/design-artifact-parity.test.ts',
        ),
        targetEvidence(
          finalD0Commit,
          'command',
          'bun test D0 focused suite (21 passed, 158 assertions); bun run lint; bun run --cwd apps/web check:svelte; bun run --cwd apps/web build:svelte',
        ),
        targetEvidence(finalD0Commit, 'review', 'D0 independent parity/spec and code-quality ACCEPT.'),
      ],
    ),
    // No Svelte icon target exists yet; the Solid TSX icon owners remain authoritative.
    designRow(
      'design:icons',
      'apps/web/src/app-navigation.tsx; apps/web/src/skills-workspace.tsx',
      'apps/web/e2e/accessibility.spec.ts; apps/web/e2e/visual-regression.spec.ts',
    ),
    // D4 completes the package export-map and public composition retained by D0.
    completeForD4(
      currentRecord(owner, {
        currentOwner: 'packages/design-system/package.json',
        id: 'design-export:./css::<module>',
        kind: 'design-export',
      }),
    ),
    // D4 completes the package export-map and public composition retained by D0.
    completeForD4(
      currentRecord(owner, {
        currentOwner: 'packages/design-system/package.json',
        id: 'design-export:./panda.buildinfo.json::<asset>',
        kind: 'design-export',
      }),
    ),
    // D4 completes the package export-map and public composition retained by D0.
    completeForD4(
      currentRecord(owner, {
        currentOwner: 'packages/design-system/package.json',
        id: 'design-export:./styles.css::<asset>',
        kind: 'design-export',
      }),
    ),
    // D4 completes the retained named exports and adds the explicit framework surfaces below.
    ...designExportRecords(owner, [
      {
        entrypoint: '.',
        names: ['aiUsagePreset'],
        source: 'packages/design-system/src/preset.ts',
      },
      {
        entrypoint: './preset',
        names: ['aiUsagePreset'],
        source: 'packages/design-system/src/preset.ts',
      },
      {
        entrypoint: './report',
        names: `
          activeFilterButton commandButton drawerClose filterTextButton ghostButton navButton pendingButton presetButton refreshButton refreshIconButton sortButton themeToggleButton topRow
        `,
        source: 'packages/design-system/src/components/button.ts',
      },
      {
        entrypoint: './report',
        names: `
          DimensionSwatch chartAxis chartLegendItem chartLegendList chartLegendPct chartLegendSwatch chartSwatchClasses chartUnclassifiedSwatch dimensionSwatch highlightMark migrationBar migrationBars
          migrationCrosshair migrationGrid migrationGridLabel migrationGridLine migrationLegendButton migrationLegendMore migrationPlot migrationReadout migrationReadoutDate migrationReadoutHint migrationReadoutItem
          migrationReadoutItemActive migrationReadoutSwatch migrationReadoutTotal migrationReadoutValue migrationSeg migrationToolbar migrationToolbarSpacer migrationTotal migrationTrend migrationTrendDown migrationTrendUp
          migrationXAxis migrationXTick overflowSeriesColor scatterAxisText scatterDistribution scatterDistributionList scatterDistributionMeta scatterDistributionRow scatterGridline scatterLegend scatterOutlierButton
          scatterOutlierMeta scatterOutliers scatterPoint scatterSummary sortArrow stableSeriesColor stableSeriesIndex
        `,
        source: 'packages/design-system/src/components/chart.ts',
      },
      {
        entrypoint: './report',
        names: ['empty', 'emptyActions', 'emptyPanel', 'unavailablePanel', 'unavailableText', 'unavailableTitle'],
        source: 'packages/design-system/src/components/empty-state.ts',
      },
      {
        entrypoint: './report',
        names: ['dateFieldGroup', 'dateInput', 'field', 'formField', 'inlineFieldLabel', 'searchInput', 'selectInput'],
        source: 'packages/design-system/src/components/field.ts',
      },
      {
        entrypoint: './report',
        names: `
          actionRow activeFilters chartLegend demoBadge detailItem detailLabel detailValue eyebrow eyebrowRow filterSummary header headerActions headerNavigation headerTop meta page pageStack section shell summaryPill title titleBlock toolbar unavailableCell
        `,
        source: 'packages/design-system/src/components/layout.ts',
      },
      {
        entrypoint: './report',
        names: `
          PUNCHCARD_INTERACTIVE_TARGET_SIZE_PX advancedAnalysis advancedAnalysisContent advancedAnalysisHeader advancedAnalysisHeaderText anatomyHeadline anatomyLegend anatomyLegendItem anatomyLegendLabel anatomyLegendPercentage anatomyLegendSwatch anatomyLegendValue anatomyLegendValues heatBody heatCell heatCellToday heatCellZero heatDayControl heatDayDetail heatGrid heatLegend heatLegendCell heatMonths heatScroll heatWeekColumn heatWeekdays heroLabel heroLegend
          heroLegendValue heroMultiple heroPanel heroSide heroText heroValue overviewGrid punchCell punchCellButton punchDayLabel punchDot punchGrid punchHourLabel punchIntensityKey punchIntensityKeyCell recordCard recordLabel recordSub recordValue recordsGrid rtkNote scatterWrap topList topMoney topRank topTitle twoColumns
        `,
        source: 'packages/design-system/src/components/overview.ts',
      },
      {
        entrypoint: './report',
        names: `
          groupCount groupHeader groupPanel groupPct groupRow groupRows groupSub groupTitle groupValue panel panelHeader panelHeaderRow panelSub panelTitle
        `,
        source: 'packages/design-system/src/components/panel.ts',
      },
      {
        entrypoint: './report',
        names: `
          refreshRing refreshRingDelayed refreshRingError refreshRingIdle refreshRingPaused refreshRingRefreshing refreshRingStatic refreshRingSuccess refreshStatus refreshStatusError
        `,
        source: 'packages/design-system/src/components/refresh.ts',
      },
      {
        entrypoint: './report',
        names: `
          skillsDiagnosticRow skillsDisclosurePanel skillsDisclosureSummary skillsPathText skillsReconcilePlanList
        `,
        source: 'packages/design-system/src/components/skills.ts',
      },
      {
        entrypoint: './report',
        names: `
          banner bannerError bannerOk statusDot statusDotBroken statusDotCopy statusDotLinked statusDotMissing statusDotNone statusPill statusPillDanger statusPillInfo statusPillOk statusPillWarn
        `,
        source: 'packages/design-system/src/components/status.ts',
      },
      {
        entrypoint: './report',
        names: `
          dateCell desktopTableSurface groupKeyButton mobileSummarySurface modelCell muted numCell projectSummaryCard projectSummaryCost projectSummaryHeader projectSummaryHeadline projectSummaryList projectSummaryMetric projectSummaryMetrics projectSummarySessions projectTable right sessionCell sessionDesktopControl sessionPagingLoadMore
          sessionSummaryCard sessionSummaryDate sessionSummaryFilter sessionSummaryFilters sessionSummaryFooter sessionSummaryHeader sessionSummaryLoadMore sessionSummaryMobileSort sessionSummaryMobileSortField sessionSummaryMobileSortSelect sessionSummaryOpen sessionSummaryRow sessionSummaryStats sessionSummaryTitle sessionSummaryValue sessionSummaryViewport sessionTitleClamp sessionViewportSurface sessionsTable strongCell table tableControls tableWrap
        `,
        source: 'packages/design-system/src/components/table.ts',
      },
      {
        entrypoint: './report',
        names: `
          dateEditRow monthGridline presetGroup presetGroupLabel presetGroupShell timeAxis timeAxisTick timeBucket timeBucketSegment timeBucketUnclassifiedBand timeBucketUnclassifiedEmpty timeChartOptions timeChartOptionsCurrent timeChartOptionsSummary timeChartOptionsTitle timeChartToolbar timeChartZoomButton timeChartZoomControls timeChartZoomSummary timeRangeAdjustments timeRangeArrow timeRangeDuration timeRangeHeader timeRangeMeta timeRangePanel timeRangeSummary timeRangeSummaryDates timeRangeTitle timeRangeViewControls
          timeSliderBars timeSliderBrushColumn timeSliderBrushHeader timeSliderBrushRow timeSliderBrushTrack timeSliderControl timeSliderDateChip timeSliderDateInputs timeSliderDim timeSliderDimLeft timeSliderDimRight timeSliderFrame timeSliderHandleLabel timeSliderHandleLabelEnd timeSliderHandleLabelStart timeSliderHandleLabels timeSliderQuickRanges timeSliderRange timeSliderRangeDrag timeSliderRoot timeSliderThumb timeSliderTrack timeSliderUnclassifiedBands timelineHoverLayer
        `,
        source: 'packages/design-system/src/components/time-slider.ts',
      },
    ])
      .map(completeForD4)
      .map(recordPunchcardRepair)
      .map(recordBreakdownRepair),
    ...designExportRecords(owner, [
      {
        entrypoint: './svelte',
        names: 'commandButton themeToggleButton',
        source: 'packages/design-system/src/components/button.ts',
      },
      {
        entrypoint: './svelte',
        names: 'header meta page shell title titleBlock',
        source: 'packages/design-system/src/components/layout.ts',
      },
      {
        entrypoint: './svelte',
        names: 'panel panelSub panelTitle',
        source: 'packages/design-system/src/components/panel.ts',
      },
    ]).map(completeNewForR1),
    ...designExportRecords(owner, [
      {
        entrypoint: './svelte',
        names: 'unavailableText',
        source: 'packages/design-system/src/components/empty-state.ts',
      },
      {
        entrypoint: './svelte',
        names: 'actionRow',
        source: 'packages/design-system/src/components/layout.ts',
      },
      {
        entrypoint: './svelte',
        names: `
          groupCount groupHeader groupPanel groupPct groupRow groupRows groupSub groupTitle groupValue
        `,
        source: 'packages/design-system/src/components/panel.ts',
      },
      {
        entrypoint: './svelte',
        names: 'barFill barTrack',
        source: 'packages/design-system/src/components/segment-bar.ts',
      },
      {
        entrypoint: './svelte',
        names: 'groupKeyButton right',
        source: 'packages/design-system/src/components/table.ts',
      },
    ]).map(completeNewForBreakdown),
    ...designExportRecords(owner, [
      {
        entrypoint: './svelte',
        names: ['stableSeriesColor'],
        source: 'packages/design-system/src/svelte.ts',
      },
    ]).map(completeSeriesColorExport),
    ...designExportRecords(owner, [
      {
        entrypoint: './solid',
        names: `
          HarnessBadge Checkbox CheckboxProps Drawer DrawerProps MetricTile MetricTileProps Popover PopoverProps BarSegment SegmentBar SegmentedControl SegmentedControlItem SegmentedControlProps MultiSelect MultiSelectProps TabItem Tabs TabsProps Toggle ToggleProps Tooltip TooltipProps
        `,
        source: 'packages/design-system/src/solid.ts',
      },
      {
        entrypoint: './svelte',
        names: `
          MultiSelect SegmentedControl Tabs Checkbox HarnessBadge MetricTile BarSegment SegmentBar Toggle CellWithProvenance Drawer Popover ProvenanceMarkerFact provenanceMarkerGlyph provenanceTitle ProvenanceMarker Tooltip
        `,
        source: 'packages/design-system/src/svelte.ts',
      },
    ]).map(completeForD4),
  ].map(completeCurrentAtCutover),
});
