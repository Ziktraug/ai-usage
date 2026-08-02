import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P3' as const;
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
      'SESSION-01',
      'apps/web/src/session-table.tsx; apps/web/src/session-surface-mode.ts',
      'apps/web/e2e/dashboard.spec.ts › mounts one Sessions surface across viewport changes without losing state',
    ),
    feature(
      'SESSION-02',
      'apps/web/src/session-columns.tsx; apps/web/src/session-table-schema.ts',
      'apps/web/src/session-table-schema.test.ts; apps/web/e2e/dashboard.spec.ts › session presets',
    ),
    feature(
      'SESSION-03',
      'apps/web/src/session-query-client.ts; apps/web/src/session-query-operation-owner.ts',
      'apps/web/src/session-query-client.test.ts; apps/web/e2e/production-report.spec.ts › exact paging',
    ),
    feature(
      'SESSION-04',
      'apps/web/src/session-row-window.ts; apps/web/src/session-table.tsx',
      'apps/web/e2e/session-scroll.scale.ts; apps/web/e2e/session-scroll-benchmark.scale.ts',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/session-columns.tsx',
      'apps/web/src/session-table.tsx',
    ]),
  ],
});
