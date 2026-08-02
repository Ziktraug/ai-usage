import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P2' as const;
const feature = (id: string, currentOwner: string, test: string) =>
  currentRecord(owner, {
    currentOwner,
    evidence: [
      { kind: 'source', reference: currentOwner },
      { kind: 'test', reference: test },
    ],
    id,
    kind: 'feature',
  });

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
    ]),
    ...sourceInventoryRecords(owner, 'render-suite', [
      'apps/web/src/dashboard-metrics.render.test.tsx',
      'apps/web/src/group-panel.render.test.tsx',
      'apps/web/src/overview.render.test.tsx',
      'apps/web/src/project-summary.render.test.tsx',
    ]),
  ],
});
