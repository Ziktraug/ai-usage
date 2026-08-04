import { currentRecord } from '../helpers';
import { defineParityShard, type ParityRecord } from '../schema';

const owner = 'P3' as const;
const cutoverCommit = '75161d96109769a3f315565dfe4cf84ab398a708';
const completeAtCutover = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    {
      commit: cutoverCommit,
      kind: 'command',
      phase: 'target',
      reference: 'Canonical SvelteKit X0/X1 convergence gates preserve this packet parity.',
    },
    {
      commit: cutoverCommit,
      kind: 'review',
      phase: 'target',
      reference: 'Independent packet reviews and /root/x0_final_review ACCEPT the integrated SvelteKit composition.',
    },
  ],
  status: 'complete',
});
const implementationCommit = '198e7eecd545b3ab96195f24fc1b48306168a63f';
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
        'apps/web/src/lib/features/sessions/table/{session-table.svelte,session-cell.svelte,session-cell-projection.ts,session-table-model.ts,INTEGRATION.md}; apps/web/src/lib/features/report/composition/{live-report-destination.svelte,session-destination-refresh.svelte}; apps/web/src/session-surface-mode.ts',
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
        'apps/web/src/lib/features/sessions/table/{session-table-model,session-table-components}.test.ts; apps/web/src/session-table-schema.test.ts › exact 25 columns, full header tooltips, Work/Tokens/Reliability, unavailable cost/token/call/tool hints while Turns stays numeric with provenance, partial/unknown API-price provenance filtering, full RTK details, compact line deltas, cell filters/highlighting/campaign labels, sort defaults and legacy URL diffs',
    }),
    feature({
      baselineTest: 'apps/web/src/session-query-client.test.ts; apps/web/e2e/production-report.spec.ts › exact paging',
      currentOwner: 'apps/web/src/session-query-client.ts; apps/web/src/session-query-operation-owner.ts',
      id: 'SESSION-03',
      targetSource:
        'apps/web/src/lib/features/sessions/table/{session-table-query-owner.ts,INTEGRATION.md}; apps/web/src/lib/features/report/composition/{live-report-destination.svelte,session-destination-refresh.svelte,sessions-destination.svelte}; apps/web/src/lib/{rpc/session-client.ts,query/options/session.ts}; apps/web/src/session-query-operation-owner.ts',
      targetTest:
        'apps/web/src/lib/features/sessions/table/session-table-query-owner.test.ts; apps/web/src/{session-query-client,session-query-operation-owner}.test.ts; apps/web/src/lib/{rpc/session-client,query/options/session}.test.ts › exact revision/fingerprint and canonical cursor-keyed campaign Query options, one owner, dedupe, abort, supersession, authoritative campaign identity, replay of more than three loaded top-level pages and every loaded campaign-child page before one retry, and repeated-expiry preservation',
    }),
    feature({
      baselineTest: 'apps/web/e2e/session-scroll.scale.ts; apps/web/e2e/session-scroll-benchmark.scale.ts',
      currentOwner: 'apps/web/src/session-row-window.ts; apps/web/src/session-table.tsx',
      id: 'SESSION-04',
      targetSource:
        'apps/web/src/lib/features/sessions/table/{session-virtualization.ts,session-table.svelte,session-table-model.ts}; apps/web/src/session-row-window.ts',
      targetTest:
        'apps/web/src/lib/features/sessions/table/{session-table-model,session-table-components}.test.ts; apps/web/src/session-row-window.test.ts › exact 188/180 mobile geometry, inspect/filter/expand/duration semantics, sort direction preserved across column changes, single native-button activation, expanded aria-setsize, desktop/mobile sentinels, actual rendered 5,000-row bounded DOM and shared keyboard focus contract (X0 owns process scale/benchmark)',
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
        'apps/web/src/lib/features/sessions/table/{session-table.svelte,session-cell.svelte,session-cell-projection.ts,session-table-model.ts,session-table-query-owner.ts,session-virtualization.ts,INTEGRATION.md}; apps/web/src/lib/features/report/composition/{live-report-destination.svelte,session-destination-refresh.svelte,sessions-destination.svelte}',
      targetTest:
        'apps/web/src/lib/features/sessions/table/{session-table-components,session-table-model,session-table-query-owner,session-client-closure}.test.ts',
    }),
  ].map(completeAtCutover),
});
