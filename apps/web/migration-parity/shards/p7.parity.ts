import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P7' as const;

export default defineParityShard({
  owner,
  records: [
    currentRecord(owner, {
      currentOwner: 'apps/web/src/routes/sync.tsx; apps/web/src/sync-machine-fleet.tsx',
      evidence: [
        { kind: 'test', reference: 'apps/web/src/sync.render.test.tsx; apps/web/e2e/accessibility.spec.ts › Sync' },
      ],
      id: 'SYNC-01',
      kind: 'feature',
    }),
    currentRecord(owner, {
      currentOwner: 'apps/web/src/manual-transfer-model.ts; apps/web/src/server/manual-merge-upload.server.ts',
      evidence: [
        {
          kind: 'test',
          reference:
            'apps/web/src/server/manual-merge-upload.server.test.ts; apps/web/e2e/dashboard.spec.ts › explicit file transfers',
        },
      ],
      id: 'SYNC-02',
      kind: 'feature',
    }),
    currentRecord(owner, {
      currentOwner:
        'apps/web/src/server/web-read-observability.server.ts; apps/web/nitro/plugins/web-read-observability.ts',
      evidence: [{ kind: 'test', reference: 'apps/web/src/server/web-read-observability.server.test.ts' }],
      id: 'OPS-01',
      kind: 'feature',
    }),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/routes/sync.tsx',
      'apps/web/src/sync-machine-comparison.tsx',
      'apps/web/src/sync-machine-fleet.tsx',
    ]),
    ...sourceInventoryRecords(owner, 'render-suite', ['apps/web/src/sync.render.test.tsx']),
  ],
});
