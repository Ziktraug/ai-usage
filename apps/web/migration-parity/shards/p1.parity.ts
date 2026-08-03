import { currentRecord } from '../helpers';
import { defineParityShard, type ParityRecord } from '../schema';

const owner = 'P1' as const;
const implementationCommit = '2422c2c64b914230b298260c9be5041d87ecbe89';
const coreTestCommand =
  'bun test apps/web/src/lib/features/report/core/*.test.ts apps/web/src/lib/features/report/lifecycle/*.test.ts apps/web/src/served-report-session.test.ts';

const withTarget = (
  record: ParityRecord,
  target: { readonly source: string; readonly test: string; readonly command?: string },
): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    { commit: implementationCommit, kind: 'source', phase: 'target', reference: target.source },
    { commit: implementationCommit, kind: 'test', phase: 'target', reference: target.test },
    {
      commit: implementationCommit,
      kind: 'command',
      phase: 'target',
      reference: target.command ?? coreTestCommand,
    },
  ],
});

const feature = (input: {
  readonly currentOwner: string;
  readonly id: string;
  readonly baselineTest: string;
  readonly targetSource: string;
  readonly targetTest: string;
}): ParityRecord =>
  withTarget(
    currentRecord(owner, {
      currentOwner: input.currentOwner,
      evidence: [
        { kind: 'source', reference: input.currentOwner },
        { kind: 'test', reference: input.baselineTest },
      ],
      id: input.id,
      kind: 'feature',
    }),
    { source: input.targetSource, test: input.targetTest },
  );

const productionRow = (input: {
  readonly currentOwner: string;
  readonly targetSource: string;
  readonly targetTest: string;
}): ParityRecord =>
  withTarget(
    currentRecord(owner, {
      currentOwner: input.currentOwner,
      evidence: [{ kind: 'source', reference: input.currentOwner }],
      id: `tsx:${input.currentOwner}`,
      kind: 'production-tsx',
    }),
    { source: input.targetSource, test: input.targetTest },
  );

export default defineParityShard({
  owner,
  records: [
    feature({
      baselineTest:
        'apps/web/e2e/production-report.spec.ts › renders the report timeline on the initial production Overview',
      currentOwner: 'apps/web/src/report-runtime.ts; apps/web/src/routes/index.tsx',
      id: 'REPORT-01',
      targetSource:
        'apps/web/src/lib/features/report/core/{INTEGRATION.md,report-bootstrap.ts,report-query.svelte.ts,report-root.svelte,report-bootstrap-overview.svelte}',
      targetTest:
        'apps/web/src/lib/features/report/core/{report-bootstrap,report-components,report-view-model}.test.ts › awaited current alias, hydrated ReportRoot HTML, compatible stored publication, typed unavailability',
    }),
    feature({
      baselineTest:
        'apps/web/src/served-report-session.test.ts; apps/web/e2e/dashboard.spec.ts › focused pending and retry',
      currentOwner: 'apps/web/src/dashboard-report-lifecycle.ts; apps/web/src/served-report-session.ts',
      id: 'REPORT-02',
      targetSource:
        'apps/web/src/lib/features/report/{core/report-workspace.svelte,lifecycle/report-lifecycle-owner.svelte,lifecycle/served-report-session-owner.svelte.ts}; apps/web/src/served-report-session.ts',
      targetTest:
        'apps/web/src/lib/features/report/lifecycle/served-report-session-owner.test.ts; apps/web/src/served-report-session.test.ts › pending, retained output, failure, supersession, abort and render/destroy cleanup',
    }),
    productionRow({
      currentOwner: 'apps/web/src/dashboard-header.tsx',
      targetSource: 'apps/web/src/lib/features/report/core/report-header.svelte',
      targetTest: 'apps/web/src/lib/features/report/core/{report-components,report-view-model}.test.ts',
    }),
    productionRow({
      currentOwner: 'apps/web/src/dashboard-pending-surface.tsx',
      targetSource: 'apps/web/src/lib/features/report/core/report-pending-surface.svelte',
      targetTest: 'apps/web/src/lib/features/report/core/report-components.test.ts › focused pending surface compile',
    }),
    productionRow({
      currentOwner: 'apps/web/src/dashboard-provider-status.tsx',
      targetSource:
        'apps/web/src/lib/features/report/core/{report-bootstrap-overview.svelte,report-view-model.ts} (bounded initial provider support; P2 owns full provider presentation)',
      targetTest: 'apps/web/src/lib/features/report/core/{report-components,report-view-model}.test.ts',
    }),
    productionRow({
      currentOwner: 'apps/web/src/dashboard-report-workspace.tsx',
      targetSource: 'apps/web/src/lib/features/report/core/report-workspace.svelte',
      targetTest: 'apps/web/src/lib/features/report/core/report-components.test.ts › retained complete output',
    }),
    productionRow({
      currentOwner: 'apps/web/src/dashboard-status.tsx',
      targetSource: 'apps/web/src/lib/features/report/core/report-status.svelte',
      targetTest: 'apps/web/src/lib/features/report/core/report-components.test.ts › localized refresh status compile',
    }),
    productionRow({
      currentOwner: 'apps/web/src/dashboard.tsx',
      targetSource:
        'apps/web/src/lib/features/report/core/{report-root.svelte,report-bootstrap-overview.svelte,report-warnings.svelte,report-workspace.svelte}',
      targetTest: 'apps/web/src/lib/features/report/core/report-components.test.ts › hydrated ReportRoot HTML',
    }),
    productionRow({
      currentOwner: 'apps/web/src/report-warnings.tsx',
      targetSource: 'apps/web/src/lib/features/report/core/report-warnings.svelte',
      targetTest: 'apps/web/src/lib/features/report/core/report-components.test.ts › warning cleanup action seam',
    }),
    productionRow({
      currentOwner: 'apps/web/src/routes/index.tsx',
      targetSource:
        'apps/web/src/lib/features/report/core/{INTEGRATION.md,report-bootstrap.ts,report-root.svelte}; coordinator apps/web/svelte-shadow/routes/{+page.ts,+page.svelte}',
      targetTest:
        'apps/web/src/lib/features/report/core/{report-bootstrap,report-components}.test.ts › route error and loader-to-hydrated-root composition',
    }),
  ],
});
