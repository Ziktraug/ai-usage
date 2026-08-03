import { currentRecord } from '../helpers';
import { defineParityShard, type ParityRecord } from '../schema';

const owner = 'P3' as const;
const implementationCommit = 'dddd96bc6a37b084fd9ec4aa2fdc07d85d3ceaf6';
const packetTestCommand =
  'bun test apps/web/src/lib/features/sessions/table/*.test.ts apps/web/src/session-{table-schema,row-window,query-client,query-operation-owner,surface-mode}.test.ts apps/web/src/lib/{rpc/session-client,query/options/session}.test.ts apps/web/src/served-report-session.test.ts';

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
      reference: target.command ?? packetTestCommand,
    },
  ],
});

const feature = (input: {
  readonly baselineTest: string;
  readonly currentOwner: string;
  readonly id: string;
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
        'apps/web/e2e/dashboard.spec.ts › mounts one Sessions surface across viewport changes without losing state',
      currentOwner: 'apps/web/src/session-table.tsx; apps/web/src/session-surface-mode.ts',
      id: 'SESSION-01',
      targetSource:
        'apps/web/src/lib/features/sessions/table/{session-table.svelte,session-cell.svelte,session-cell-projection.ts,session-table-owner.svelte,session-table-model.ts,INTEGRATION.md}; apps/web/src/session-surface-mode.ts',
      targetTest:
        'apps/web/src/lib/features/sessions/table/{session-table-components,session-table-model}.test.ts; apps/web/src/session-surface-mode.test.ts › one owner, exact responsive geometry, rendered 5,000-row bounded windows, retained stable expansion and keyboard focus',
    }),
    feature({
      baselineTest: 'apps/web/src/session-table-schema.test.ts; apps/web/e2e/dashboard.spec.ts › session presets',
      currentOwner: 'apps/web/src/session-columns.tsx; apps/web/src/session-table-schema.ts',
      id: 'SESSION-02',
      targetSource:
        'apps/web/src/lib/features/sessions/table/{session-columns.ts,session-cell.svelte,session-cell-projection.ts,session-table.svelte}; apps/web/src/session-table-schema.ts',
      targetTest:
        'apps/web/src/lib/features/sessions/table/{session-table-model,session-table-components}.test.ts; apps/web/src/session-table-schema.test.ts › exact 25 columns, Work/Tokens/Reliability, cell filters/highlighting/provenance/campaign labels, sort defaults and legacy URL diffs',
    }),
    feature({
      baselineTest: 'apps/web/src/session-query-client.test.ts; apps/web/e2e/production-report.spec.ts › exact paging',
      currentOwner: 'apps/web/src/session-query-client.ts; apps/web/src/session-query-operation-owner.ts',
      id: 'SESSION-03',
      targetSource:
        'apps/web/src/lib/features/sessions/table/{session-table-query-owner.ts,session-table-owner.svelte,INTEGRATION.md}; apps/web/src/lib/{rpc/session-client.ts,query/options/session.ts}; apps/web/src/session-query-operation-owner.ts',
      targetTest:
        'apps/web/src/lib/features/sessions/table/session-table-query-owner.test.ts; apps/web/src/{session-query-client,session-query-operation-owner}.test.ts; apps/web/src/lib/{rpc/session-client,query/options/session}.test.ts › exact revision/fingerprint, one owner, dedupe, abort, supersession, authoritative campaign identity, incremental one-retry recovery and failure preservation',
    }),
    feature({
      baselineTest: 'apps/web/e2e/session-scroll.scale.ts; apps/web/e2e/session-scroll-benchmark.scale.ts',
      currentOwner: 'apps/web/src/session-row-window.ts; apps/web/src/session-table.tsx',
      id: 'SESSION-04',
      targetSource:
        'apps/web/src/lib/features/sessions/table/{session-virtualization.ts,session-table.svelte,session-table-model.ts}; apps/web/src/session-row-window.ts',
      targetTest:
        'apps/web/src/lib/features/sessions/table/{session-table-model,session-table-components}.test.ts; apps/web/src/session-row-window.test.ts › exact 188/180 mobile geometry, desktop/mobile sentinels, actual rendered 5,000-row bounded DOM and shared keyboard focus contract (X0 owns process scale/benchmark)',
    }),
    productionRow({
      currentOwner: 'apps/web/src/session-columns.tsx',
      targetSource: 'apps/web/src/lib/features/sessions/table/session-columns.ts',
      targetTest:
        'apps/web/src/lib/features/sessions/table/session-table-model.test.ts; apps/web/src/session-table-schema.test.ts',
    }),
    productionRow({
      currentOwner: 'apps/web/src/session-table.tsx',
      targetSource:
        'apps/web/src/lib/features/sessions/table/{session-table.svelte,session-cell.svelte,session-cell-projection.ts,session-table-owner.svelte,session-table-model.ts,session-table-query-owner.ts,session-virtualization.ts,INTEGRATION.md}',
      targetTest:
        'apps/web/src/lib/features/sessions/table/{session-table-components,session-table-model,session-table-query-owner,session-client-closure}.test.ts',
    }),
  ],
});
