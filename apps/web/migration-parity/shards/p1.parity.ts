import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P1' as const;
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
      'REPORT-01',
      'apps/web/src/report-runtime.ts; apps/web/src/routes/index.tsx',
      'apps/web/e2e/production-report.spec.ts › renders the report timeline on the initial production Overview',
    ),
    feature(
      'REPORT-02',
      'apps/web/src/dashboard-report-lifecycle.ts; apps/web/src/served-report-session.ts',
      'apps/web/src/served-report-session.test.ts; apps/web/e2e/dashboard.spec.ts › focused pending and retry',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/dashboard-header.tsx',
      'apps/web/src/dashboard-pending-surface.tsx',
      'apps/web/src/dashboard-provider-status.tsx',
      'apps/web/src/dashboard-report-workspace.tsx',
      'apps/web/src/dashboard-status.tsx',
      'apps/web/src/dashboard.tsx',
      'apps/web/src/report-warnings.tsx',
      'apps/web/src/routes/index.tsx',
    ]),
  ],
});
