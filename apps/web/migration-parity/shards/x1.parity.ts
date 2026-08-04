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
  ],
});
