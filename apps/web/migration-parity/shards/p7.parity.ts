import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'P7' as const;
const implementationCommit = 'f98f6b1d40f4cade8c7de47dc14475f6ad003461';
const targetEvidence = (kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit: implementationCommit,
  kind,
  phase: 'target',
  reference,
});
const withTargetEvidence = (record: ParityRecord, evidence: readonly ParityEvidence[]): ParityRecord => ({
  ...record,
  evidence: [...record.evidence, ...evidence],
});
const commandEvidence = targetEvidence(
  'command',
  'bun test apps/web/src/lib/features/sync apps/web/src/sync.render.test.tsx apps/web/src/manual-transfer-model.test.ts apps/web/src/server/manual-merge-upload.server.test.ts apps/web/src/server/sync-upload.server.test.ts apps/web/src/server/sync.server.test.ts apps/web/src/server/sync-e2e-fixture.server.test.ts apps/web/src/server/web-read-observability.server.test.ts apps/web/src/lib/query/options/sync.test.ts apps/web/src/lib/rpc/sync-client.test.ts apps/web/src/lib/rpc/sync-solid-client.test.ts apps/web/src/lib/server/rpc/sync.test.ts (66 pass, 303 assertions); bun x ultracite check apps/web/src/lib/features/sync apps/web/migration-parity/shards/p7.parity.ts; bun run --cwd apps/web typecheck; bun run --cwd apps/web build:svelte; bun run --cwd apps/web build; bun tools/check-package-boundaries.ts; bun tools/check-typescript-coverage.ts; bun tools/check-web-migration-parity.ts',
);
const evidencedFeature = (record: ParityRecord, source: string, test: string): ParityRecord =>
  withTargetEvidence(record, [targetEvidence('source', source), targetEvidence('test', test), commandEvidence]);

const productionReplacementBySource: Readonly<Record<string, { readonly source: string; readonly test: string }>> = {
  'apps/web/src/routes/sync.tsx': {
    source:
      'apps/web/src/lib/features/sync/sync-root.svelte; apps/web/src/lib/features/sync/sync-load.ts; apps/web/src/lib/features/sync/INTEGRATION.md',
    test: 'apps/web/src/lib/features/sync/sync-render.test.ts; apps/web/src/lib/features/sync/sync-load.test.ts',
  },
  'apps/web/src/sync-machine-comparison.tsx': {
    source: 'apps/web/src/lib/features/sync/machine-comparison.svelte',
    test: 'apps/web/src/lib/features/sync/sync-components.test.ts; apps/web/src/lib/features/sync/sync-render.test.ts',
  },
  'apps/web/src/sync-machine-fleet.tsx': {
    source: 'apps/web/src/lib/features/sync/machine-fleet.svelte',
    test: 'apps/web/src/lib/features/sync/sync-components.test.ts; apps/web/src/lib/features/sync/sync-render.test.ts',
  },
};
const evidenceProductionReplacement = (record: ParityRecord): ParityRecord => {
  const replacement = productionReplacementBySource[record.currentOwner];
  if (!replacement) {
    throw new Error(`Missing P7 replacement evidence for ${record.currentOwner}.`);
  }
  return withTargetEvidence(record, [
    targetEvidence('source', replacement.source),
    targetEvidence('test', replacement.test),
    commandEvidence,
  ]);
};

export default defineParityShard({
  owner,
  records: [
    evidencedFeature(
      currentRecord(owner, {
        currentOwner: 'apps/web/src/routes/sync.tsx; apps/web/src/sync-machine-fleet.tsx',
        evidence: [
          { kind: 'test', reference: 'apps/web/src/sync.render.test.tsx; apps/web/e2e/accessibility.spec.ts › Sync' },
        ],
        id: 'SYNC-01',
        kind: 'feature',
      }),
      'apps/web/src/lib/features/sync/sync-root.svelte; apps/web/src/lib/features/sync/machine-fleet.svelte; apps/web/src/lib/features/sync/machine-comparison.svelte; apps/web/src/lib/features/sync/styles.ts; apps/web/src/lib/features/sync/sync-load.ts; apps/web/src/lib/features/sync/sync-query.svelte.ts',
      'apps/web/src/lib/features/sync/sync-render.test.ts; apps/web/src/lib/features/sync/sync-load.test.ts; apps/web/src/lib/features/sync/sync-components.test.ts; apps/web/src/lib/features/sync/client-closure.test.ts',
    ),
    evidencedFeature(
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
      'apps/web/src/lib/features/sync/manual-transfer.svelte; apps/web/src/lib/features/sync/manual-transfer-progress.svelte; apps/web/src/lib/features/sync/manual-transfer-client.ts; apps/web/src/lib/features/sync/server/manual-merge-endpoints.server.ts; apps/web/src/lib/features/sync/INTEGRATION.md',
      'apps/web/src/lib/features/sync/sync-render.test.ts; apps/web/src/lib/features/sync/manual-transfer-client.test.ts; apps/web/src/lib/features/sync/server/manual-merge-endpoints.server.test.ts; apps/web/src/server/manual-merge-upload.server.test.ts',
    ),
    evidencedFeature(
      currentRecord(owner, {
        currentOwner:
          'apps/web/src/server/web-read-observability.server.ts; apps/web/nitro/plugins/web-read-observability.ts',
        evidence: [{ kind: 'test', reference: 'apps/web/src/server/web-read-observability.server.test.ts' }],
        id: 'OPS-01',
        kind: 'feature',
      }),
      'apps/web/src/lib/features/sync/INTEGRATION.md',
      'apps/web/src/server/web-read-observability.server.test.ts; apps/web/src/lib/features/sync/server/manual-merge-endpoints.server.test.ts',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/routes/sync.tsx',
      'apps/web/src/sync-machine-comparison.tsx',
      'apps/web/src/sync-machine-fleet.tsx',
    ]).map(evidenceProductionReplacement),
    ...sourceInventoryRecords(owner, 'render-suite', ['apps/web/src/sync.render.test.tsx']).map((record) =>
      withTargetEvidence(record, [
        targetEvidence(
          'source',
          'apps/web/src/lib/features/sync/machine-fleet.svelte; apps/web/src/lib/features/sync/machine-comparison.svelte',
        ),
        targetEvidence(
          'test',
          'apps/web/src/lib/features/sync/sync-render.test.ts; apps/web/src/lib/features/sync/sync-components.test.ts',
        ),
        commandEvidence,
      ]),
    ),
  ],
});
