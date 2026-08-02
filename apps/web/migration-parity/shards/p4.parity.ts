import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P4' as const;
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
      'SESSION-05',
      'apps/web/src/dashboard-session-selection.ts; apps/web/src/session-drawer.tsx',
      'apps/web/src/dashboard-session-selection.test.ts; apps/web/e2e/dashboard.spec.ts › drawer navigation',
    ),
    feature(
      'SESSION-06',
      'apps/web/src/session-analysis.tsx; apps/web/src/session-vcs-summary.tsx',
      'apps/web/src/session-analysis.render.test.tsx; apps/web/e2e/production-report.spec.ts › chronology and VCS',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/drawer-detail-item.tsx',
      'apps/web/src/highlighted-text.tsx',
      'apps/web/src/session-analysis.tsx',
      'apps/web/src/session-drawer.tsx',
      'apps/web/src/session-vcs-summary.tsx',
    ]),
    ...sourceInventoryRecords(owner, 'render-suite', [
      'apps/web/src/drawer-detail-item.render.test.tsx',
      'apps/web/src/highlighted-text.render.test.tsx',
      'apps/web/src/session-analysis.render.test.tsx',
      'apps/web/src/session-drawer.render.test.tsx',
      'apps/web/src/session-vcs-summary.test.tsx',
    ]),
  ],
});
