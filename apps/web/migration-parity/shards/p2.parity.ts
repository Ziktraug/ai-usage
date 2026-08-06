import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'P2' as const;
const cutoverCommit = '75161d96109769a3f315565dfe4cf84ab398a708';
const completeAtCutover = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    {
      commit: cutoverCommit,
      kind: 'command',
      phase: 'target',
      reference: 'Canonical SvelteKit X0/X1 convergence gates preserve this packet parity.',
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
const implementationCommit = '045e279242aeef7b76cf86a307974fc8722b3945';
const focusedGate =
  'bun test apps/web/src/dashboard-metrics.test.ts apps/web/src/date-range-controller.test.ts apps/web/src/date-range.test.ts apps/web/src/overview-model.test.ts apps/web/src/provider-status-clock.test.ts apps/web/src/provider-status-model.test.ts apps/web/src/provider-status-panel-model.test.ts apps/web/src/provider-status-progress.test.ts apps/web/src/time-range-control-state.test.ts apps/web/src/lib/features/report/overview/*.test.ts apps/web/src/lib/features/report/range/*.test.ts (95 pass, 0 fail, 352 expect calls)';

const targetEvidence = (
  kind: ParityEvidence['kind'],
  reference: string,
  commit = implementationCommit,
): ParityEvidence => ({
  commit,
  kind,
  phase: 'target',
  reference,
});

const withTarget = (
  record: ParityRecord,
  source: string,
  test: string,
  commit = implementationCommit,
): ParityRecord => ({
  ...record,
  evidence: [...record.evidence, targetEvidence('source', source, commit), targetEvidence('test', test, commit)],
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

interface ReplacementTarget {
  readonly commit?: string;
  readonly source: string;
  readonly test: string;
}

const productionTargets: Record<string, ReplacementTarget> = {
  'apps/web/src/cursor-attribution-panel.tsx': {
    commit: cutoverCommit,
    source: 'apps/web/src/lib/features/report/breakdown/cursor-attribution-panel.svelte',
    test: 'apps/web/src/lib/features/report/breakdown/cursor.test.ts; apps/web/src/lib/features/report/breakdown/breakdown-components.test.ts; apps/web/src/lib/features/report/breakdown/p8.browser.server.ts',
  },
  'apps/web/src/dashboard-metrics.tsx': {
    source: 'apps/web/src/lib/features/report/overview/dashboard-metrics.svelte',
    test: 'apps/web/src/lib/features/report/overview/overview-components.test.ts; apps/web/src/lib/features/report/overview/view-model.test.ts',
  },
  'apps/web/src/group-panel.tsx': {
    commit: cutoverCommit,
    source:
      'apps/web/src/lib/features/report/breakdown/{breakdown-panel.svelte,breakdown-row.svelte,harness-provider-panel.svelte,model.ts,harness-provider-model.ts}',
    test: 'apps/web/src/lib/features/report/breakdown/{breakdown-components,model,harness-provider-model}.test.ts; apps/web/src/lib/features/report/breakdown/p8.browser.server.ts',
  },
  'apps/web/src/overview.tsx': {
    source:
      'apps/web/src/lib/features/report/overview/overview-page.svelte; apps/web/src/lib/features/report/overview/activity-timeline.svelte; apps/web/src/lib/features/report/overview/activity-heatmap.svelte; apps/web/src/lib/features/report/overview/session-shape.svelte; apps/web/src/lib/features/report/overview/records.svelte',
    test: 'apps/web/src/lib/features/report/overview/overview-components.test.ts; apps/web/src/lib/features/report/overview/timeline-model.test.ts; apps/web/src/lib/features/report/overview/session-shape-model.test.ts',
  },
  'apps/web/src/project-summary.tsx': {
    commit: cutoverCommit,
    source: 'apps/web/src/lib/features/report/breakdown/{project-summary.svelte,projects-panel.svelte}',
    test: 'apps/web/src/lib/features/report/breakdown/breakdown-components.test.ts; apps/web/src/lib/features/report/breakdown/p8.browser.server.ts',
  },
  'apps/web/src/provider-status-panel.tsx': {
    source: 'apps/web/src/lib/features/report/overview/provider-status.svelte',
    test: 'apps/web/src/lib/features/report/overview/overview-components.test.ts; apps/web/src/lib/features/report/overview/provider-presentation.test.ts',
  },
  'apps/web/src/shared.tsx': {
    commit: cutoverCommit,
    source:
      'apps/web/src/shared.ts; apps/web/src/lib/foundation/presentation/{format.ts,report-value.ts}; packages/design-system/src/svelte/controls/{segment-bar.svelte,segment-bar.ts}',
    test: 'apps/web/src/lib/foundation/presentation/presentation-closure.test.ts; packages/design-system/src/svelte/controls/controls.test.ts',
  },
  'apps/web/src/time-range-control.tsx': {
    source:
      'apps/web/src/lib/features/report/range/report-range-control.svelte; apps/web/src/lib/features/report/range/report-range-model.ts',
    test: 'apps/web/src/lib/features/report/overview/overview-components.test.ts; apps/web/src/lib/features/report/range/report-range-model.test.ts',
  },
};

const withProductionTarget = (record: ParityRecord): ParityRecord => {
  const target = productionTargets[record.currentOwner];
  if (target) {
    return withTarget(record, target.source, target.test, target.commit);
  }

  return record;
};

const renderTargets: Record<string, ReplacementTarget> = {
  'apps/web/src/dashboard-metrics.render.test.tsx': {
    source: 'apps/web/src/lib/features/report/overview/dashboard-metrics.svelte',
    test: 'apps/web/src/lib/features/report/overview/overview-components.test.ts; apps/web/src/lib/features/report/overview/view-model.test.ts',
  },
  'apps/web/src/group-panel.render.test.tsx': {
    commit: cutoverCommit,
    source:
      'apps/web/src/lib/features/report/breakdown/{breakdown-panel.svelte,breakdown-row.svelte,harness-provider-panel.svelte}',
    test: 'apps/web/src/lib/features/report/breakdown/{breakdown-components,model,harness-provider-model}.test.ts; apps/web/src/lib/features/report/breakdown/p8.browser.server.ts',
  },
  'apps/web/src/overview.render.test.tsx': {
    source: 'apps/web/src/lib/features/report/overview/overview-page.svelte',
    test: 'apps/web/src/lib/features/report/overview/overview-components.test.ts',
  },
  'apps/web/src/project-summary.render.test.tsx': {
    commit: cutoverCommit,
    source: 'apps/web/src/lib/features/report/breakdown/{project-summary.svelte,projects-panel.svelte}',
    test: 'apps/web/src/lib/features/report/breakdown/breakdown-components.test.ts; apps/web/src/lib/features/report/breakdown/p8.browser.server.ts',
  },
};

const withRenderTarget = (record: ParityRecord): ParityRecord => {
  const target = renderTargets[record.currentOwner];
  if (target) {
    return withTarget(record, target.source, target.test, target.commit);
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
  ].map(completeAtCutover),
});
