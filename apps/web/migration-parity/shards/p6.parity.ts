import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P6' as const;
const feature = (id: string, currentOwner: string, test: string) =>
  currentRecord(owner, {
    currentOwner,
    evidence: [{ kind: 'test', reference: test }],
    id,
    kind: 'feature',
  });

export default defineParityShard({
  owner,
  records: [
    feature(
      'SOURCES-01',
      'apps/web/src/routes/sources.tsx; apps/web/src/source-control-client.ts',
      'apps/web/e2e/sources.spec.ts',
    ),
    feature(
      'SOURCES-02',
      'apps/web/src/source-control-context.tsx; apps/web/src/components/source-control-summary.tsx',
      'apps/web/e2e/production-report.spec.ts › provides one accessible responsive source-control surface',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/components/source-control-summary.tsx',
      'apps/web/src/routes/sources.tsx',
      'apps/web/src/source-control-context.tsx',
    ]),
  ],
});
