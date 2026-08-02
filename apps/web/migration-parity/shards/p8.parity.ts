import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P8' as const;
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
      'REPORT-06',
      'apps/web/src/dashboard-breakdown.tsx; apps/web/src/dashboard-search.ts',
      'apps/web/e2e/dashboard.spec.ts › Breakdown navigation; apps/web/e2e/value-presentation.spec.ts',
    ),
    feature(
      'REPORT-07',
      'apps/web/src/report-sharing-actions.tsx; apps/web/src/report-export.ts',
      'apps/web/e2e/dashboard.spec.ts › copies the exact breakdown URL and exports only visible sorted model rows',
    ),
    feature(
      'FILTER-01',
      'apps/web/src/dashboard-search.ts; apps/web/src/dashboard-navigation-controller.ts',
      'apps/web/src/dashboard-search.test.ts; apps/web/e2e/dashboard.spec.ts › URL filter cases',
    ),
    feature(
      'FILTER-02',
      'packages/design-system/src/components/badge.tsx; apps/web/src/machine-staleness.ts',
      'apps/web/e2e/machine-staleness.spec.ts; apps/web/e2e/category-visibility.spec.ts',
    ),
    feature(
      'CAMPAIGN-02',
      'apps/web/src/campaign-label-editor.tsx; apps/web/src/project-group-editor.tsx',
      'apps/web/e2e/campaign-label-overrides.spec.ts; apps/web/src/project-group-control.test.ts',
    ),
    feature(
      'QUOTA-01',
      'apps/web/src/provider-quota-history-panel.tsx',
      'apps/web/e2e/dashboard.spec.ts › Codex quota history shows reset and gap-aware ranges on desktop and mobile',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/campaign-label-editor.tsx',
      'apps/web/src/dashboard-active-filters.tsx',
      'apps/web/src/dashboard-breakdown-harness-panel.tsx',
      'apps/web/src/dashboard-breakdown-panels.tsx',
      'apps/web/src/dashboard-breakdown.tsx',
      'apps/web/src/dashboard-filter-bar.tsx',
      'apps/web/src/dashboard-filters.tsx',
      'apps/web/src/origin-filter.tsx',
      'apps/web/src/project-group-editor.tsx',
      'apps/web/src/provider-quota-history-panel.tsx',
      'apps/web/src/report-sharing-actions.tsx',
    ]),
  ],
});
