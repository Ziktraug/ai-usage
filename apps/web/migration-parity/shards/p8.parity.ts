import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard, type ParityRecord } from '../schema';

const owner = 'P8' as const;
const implementationCommit = '12939b48df4bb362634287e8956996a781cbd1ca';
const quotaFocusCommit = '2bf22ee1b20640b2003297800b906b516dd3c0e0';
const browserEvidenceCommit = '2665d04182d965c6f57997ea008596049b5cc28b';
const focusedGate =
  'bun test apps/web/src/lib/features/report/breakdown/*.test.ts apps/web/src/lib/features/report/actions/*.test.ts (32 pass, 0 fail, 79 expect calls)';
const withTarget = (record: ParityRecord, source: string): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    { commit: implementationCommit, kind: 'source', phase: 'target', reference: source },
    { commit: browserEvidenceCommit, kind: 'test', phase: 'target', reference: focusedGate },
  ],
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
    'apps/web/src/lib/features/report/{breakdown,actions}/**',
  );

const productionTargets: Record<string, string> = {
  'apps/web/src/campaign-label-editor.tsx': 'apps/web/src/lib/features/report/actions/campaign-label-editor.svelte',
  'apps/web/src/dashboard-active-filters.tsx': 'apps/web/src/lib/features/report/breakdown/active-filters.svelte',
  'apps/web/src/dashboard-breakdown-harness-panel.tsx':
    'apps/web/src/lib/features/report/breakdown/harness-provider-panel.svelte',
  'apps/web/src/dashboard-breakdown-panels.tsx':
    'apps/web/src/lib/features/report/breakdown/{breakdown-panel,project-summary,cursor-attribution-panel}.svelte',
  'apps/web/src/dashboard-breakdown.tsx': 'apps/web/src/lib/features/report/breakdown/dashboard-breakdown.svelte',
  'apps/web/src/dashboard-filter-bar.tsx': 'apps/web/src/lib/features/report/breakdown/filter-bar.svelte',
  'apps/web/src/dashboard-filters.tsx':
    'apps/web/src/lib/features/report/breakdown/{navigation.ts,active-filters.svelte}',
  'apps/web/src/origin-filter.tsx': 'apps/web/src/lib/features/report/breakdown/origin-filter.svelte',
  'apps/web/src/project-group-editor.tsx': 'apps/web/src/lib/features/report/actions/project-group-editor.svelte',
  'apps/web/src/provider-quota-history-panel.tsx':
    'apps/web/src/lib/features/report/actions/{quota-history-owner,quota-history-panel}.svelte',
  'apps/web/src/report-sharing-actions.tsx': 'apps/web/src/lib/features/report/actions/report-sharing-actions.svelte',
};
const productionBrowserEvidence: Record<string, string> = {
  'apps/web/src/campaign-label-editor.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › campaign rename and reset update the effective label',
  'apps/web/src/dashboard-active-filters.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › labelled machine pill and Clear all mutate canonical URL state',
  'apps/web/src/dashboard-breakdown-harness-panel.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › controlled harness disclosure, child search and visible sorted CSV',
  'apps/web/src/dashboard-breakdown-panels.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › measured, partial, unavailable and zero rows plus responsive project and Cursor projections',
  'apps/web/src/dashboard-breakdown.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › four controlled breakdown tabs and sort interaction',
  'apps/web/src/dashboard-filter-bar.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › query replace run, raw machine identity and rendered Origin controls',
  'apps/web/src/dashboard-filters.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › URL-backed query, active pills and clear-all interaction',
  'apps/web/src/origin-filter.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › Popover, keyboard Checkbox, Default and All interactions',
  'apps/web/src/project-group-editor.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › quality action focuses management and project save recovers after announced failure',
  'apps/web/src/provider-quota-history-panel.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › demo/live acquisition, responsive range/filter/reset/gap/table and per-open focus restoration',
  'apps/web/src/report-sharing-actions.tsx':
    'apps/web/src/lib/features/report/breakdown/p8.browser.ts › exact URL and visible CSV success plus independent failure announcements',
};
const withProductionTarget = (record: ParityRecord): ParityRecord => {
  const source = productionTargets[record.currentOwner];
  const test = productionBrowserEvidence[record.currentOwner];
  if (!(source && test)) {
    return record;
  }
  return {
    ...record,
    evidence: [
      ...record.evidence,
      {
        commit:
          record.currentOwner === 'apps/web/src/provider-quota-history-panel.tsx'
            ? quotaFocusCommit
            : implementationCommit,
        kind: 'source',
        phase: 'target',
        reference: source,
      },
      { commit: browserEvidenceCommit, kind: 'test', phase: 'target', reference: test },
    ],
  };
};

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
    ]).map(withProductionTarget),
  ],
});
