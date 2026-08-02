import { currentRecord, designExportRecords } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'D0' as const;
const foundationCommit = '6c6d6c4ebe134d980dd630a13ab53086e38aa142';
const finalD0Commit = '8474f185f0bef832bae5bb0338f1af316ba02401';
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
const retainForD4 = (record: ParityRecord): ParityRecord =>
  appendTargetEvidence(record, retainedPublicCompositionEvidence);
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
    // D4 still owns public report and /solid-/svelte composition; D0 only proved the passive closure.
    retainForD4(
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
    // D4 owns package export-map and public report composition; D0 evidence records only neutral-foundation progress.
    retainForD4(
      currentRecord(owner, {
        currentOwner: 'packages/design-system/package.json',
        id: 'design-export:./css::<module>',
        kind: 'design-export',
      }),
    ),
    // D4 owns package export-map and public report composition; D0 evidence records only neutral-foundation progress.
    retainForD4(
      currentRecord(owner, {
        currentOwner: 'packages/design-system/package.json',
        id: 'design-export:./panda.buildinfo.json::<asset>',
        kind: 'design-export',
      }),
    ),
    // D4 owns package export-map and public report composition; D0 evidence records only neutral-foundation progress.
    retainForD4(
      currentRecord(owner, {
        currentOwner: 'packages/design-system/package.json',
        id: 'design-export:./styles.css::<asset>',
        kind: 'design-export',
      }),
    ),
    // Named public exports also stay current until D4 composes and proves the /solid and /svelte surfaces.
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
    ]).map(retainForD4),
  ],
});
