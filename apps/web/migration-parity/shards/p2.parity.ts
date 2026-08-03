import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'P2' as const;
const implementationCommit = '0f252cafffbdaf863da5a235c848143154231e07';
const focusedGate =
  'bun test apps/web/src/dashboard-metrics.test.ts apps/web/src/date-range-controller.test.ts apps/web/src/date-range.test.ts apps/web/src/overview-model.test.ts apps/web/src/provider-status-clock.test.ts apps/web/src/provider-status-model.test.ts apps/web/src/provider-status-panel-model.test.ts apps/web/src/provider-status-progress.test.ts apps/web/src/time-range-control-state.test.ts apps/web/src/lib/features/report/overview/*.test.ts apps/web/src/lib/features/report/range/*.test.ts (76 pass, 0 fail, 278 expect calls)';

const targetEvidence = (kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit: implementationCommit,
  kind,
  phase: 'target',
  reference,
});

const withTarget = (record: ParityRecord, source: string, test: string): ParityRecord => ({
  ...record,
  evidence: [...record.evidence, targetEvidence('source', source), targetEvidence('test', test)],
});

const feature = (id: string, currentOwner: string, test: string) =>
  withTarget(
    currentRecord(owner, {
      currentOwner,
      evidence: [
        { kind: 'source', reference: currentOwner },
        { kind: 'test', reference: test },
      ],
      id,
      kind: 'feature',
    }),
    'apps/web/src/lib/features/report/overview/**; apps/web/src/lib/features/report/range/**',
    focusedGate,
  );

const productionTargets: Record<string, { source: string; test: string }> = {
  'apps/web/src/dashboard-metrics.tsx': {
    source: 'apps/web/src/lib/features/report/overview/dashboard-metrics.svelte',
    test: 'apps/web/src/lib/features/report/overview/dashboard-metrics.test.ts',
  },
  'apps/web/src/overview.tsx': {
    source:
      'apps/web/src/lib/features/report/overview/overview-page.svelte; apps/web/src/lib/features/report/overview/activity-timeline.svelte; apps/web/src/lib/features/report/overview/records-section.svelte',
    test: 'apps/web/src/lib/features/report/overview/overview-page.ssr.test.ts; apps/web/src/lib/features/report/overview/activity-timeline.test.ts; apps/web/src/lib/features/report/overview/records-section.test.ts',
  },
  'apps/web/src/provider-status-panel.tsx': {
    source: 'apps/web/src/lib/features/report/overview/provider-status.svelte',
    test: 'apps/web/src/lib/features/report/overview/provider-status.test.ts',
  },
  'apps/web/src/time-range-control.tsx': {
    source:
      'apps/web/src/lib/features/report/range/report-range-control.svelte; apps/web/src/lib/features/report/range/report-range-navigation.ts; apps/web/src/lib/features/report/range/report-range-transition.ts',
    test: 'apps/web/src/lib/features/report/range/report-range-control.ssr.test.ts; apps/web/src/lib/features/report/range/report-range-control.test.ts; apps/web/src/lib/features/report/range/report-range-navigation.test.ts; apps/web/src/lib/features/report/range/report-range-transition.test.ts',
  },
};

const withProductionTarget = (record: ParityRecord): ParityRecord => {
  const target = productionTargets[record.currentOwner];
  if (target) {
    return withTarget(record, target.source, target.test);
  }

  return record;
};

const renderTargets: Record<string, { source: string; test: string }> = {
  'apps/web/src/dashboard-metrics.render.test.tsx': {
    source: 'apps/web/src/lib/features/report/overview/dashboard-metrics.svelte',
    test: 'apps/web/src/lib/features/report/overview/dashboard-metrics.ssr.test.ts',
  },
  'apps/web/src/overview.render.test.tsx': {
    source: 'apps/web/src/lib/features/report/overview/overview-page.svelte',
    test: 'apps/web/src/lib/features/report/overview/overview-page.ssr.test.ts',
  },
};

const withRenderTarget = (record: ParityRecord): ParityRecord => {
  const target = renderTargets[record.currentOwner];
  if (target) {
    return withTarget(record, target.source, target.test);
  }

  return record;
};

export default defineParityShard({
  owner,
  records: [
    feature(
      'REPORT-03',
      'apps/web/src/dashboard-metrics.tsx; apps/web/src/provider-status-panel.tsx; apps/web/src/report-warnings.tsx',
      'apps/web/e2e/dashboard-presentation.spec.ts',
    ),
    feature(
      'REPORT-04',
      'apps/web/src/time-range-control.tsx; apps/web/src/date-range-controller.ts',
      'apps/web/e2e/time-range.spec.ts › report range pointer, keyboard, URL, and wheel cases',
    ),
    feature(
      'REPORT-05',
      'apps/web/src/overview.tsx; apps/web/src/overview-model.ts',
      'apps/web/e2e/time-range.spec.ts; apps/web/e2e/dashboard-presentation.spec.ts',
    ),
    feature(
      'CAMPAIGN-01',
      'apps/web/src/dashboard-model.ts; apps/web/src/overview.tsx',
      'apps/web/e2e/origin-campaign.spec.ts; apps/web/e2e/origin-gap.spec.ts',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/cursor-attribution-panel.tsx',
      'apps/web/src/dashboard-metrics.tsx',
      'apps/web/src/group-panel.tsx',
      'apps/web/src/overview.tsx',
      'apps/web/src/project-summary.tsx',
      'apps/web/src/provider-status-panel.tsx',
      'apps/web/src/shared.tsx',
      'apps/web/src/time-range-control.tsx',
    ]).map(withProductionTarget),
    ...sourceInventoryRecords(owner, 'render-suite', [
      'apps/web/src/dashboard-metrics.render.test.tsx',
      'apps/web/src/group-panel.render.test.tsx',
      'apps/web/src/overview.render.test.tsx',
      'apps/web/src/project-summary.render.test.tsx',
    ]).map(withRenderTarget),
  ],
});
