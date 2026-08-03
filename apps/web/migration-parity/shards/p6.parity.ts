import { currentRecord } from '../helpers';
import { defineParityShard, type ParityEvidence } from '../schema';

const owner = 'P6' as const;
const implementationCommit = 'f79b421e9b2bc0491a89dad9dd6bddeccdb8b0f9';
const lifecycleTestCommit = 'e7948bb908b93d0513c9d5e2ac23f54d8c0fa862';
const reviewCorrectionCommit = '64b9b020ebe40dd4dfcf5bfec6ebb3e799255ff0';
const renderedPendingTestCommit = 'f79b421e9b2bc0491a89dad9dd6bddeccdb8b0f9';
const targetEvidence = (kind: ParityEvidence['kind'], reference: string): ParityEvidence => ({
  commit: implementationCommit,
  kind,
  phase: 'target',
  reference,
});
const feature = (
  id: string,
  currentOwner: string,
  test: string,
  targetSource: string,
  targetTest: string,
  extraEvidence: readonly ParityEvidence[] = [],
) =>
  currentRecord(owner, {
    currentOwner,
    evidence: [
      { kind: 'test', reference: test },
      targetEvidence('source', targetSource),
      targetEvidence('test', targetTest),
      ...extraEvidence,
      targetEvidence(
        'command',
        'bun test apps/web/src/lib/features/sources/*.test.ts (19 passed); bun run --cwd apps/web check:svelte; bun x ultracite check scoped P6 files',
      ),
    ],
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
      'apps/web/src/lib/features/sources/sources-page.svelte; apps/web/src/lib/features/sources/service.ts; apps/web/svelte-shadow/routes/api/source-control/+server.ts; apps/web/svelte-shadow/routes/api/source-control/command/+server.ts',
      'apps/web/src/lib/features/sources/service.test.ts; apps/web/src/lib/features/sources/endpoint.server.test.ts',
      [
        {
          commit: lifecycleTestCommit,
          kind: 'test',
          phase: 'target',
          reference:
            'apps/web/src/lib/features/sources/event-stream.server.test.ts › virtual >30s heartbeat, abort cleanup, and backpressure coalescing',
        },
        {
          commit: renderedPendingTestCommit,
          kind: 'test',
          phase: 'target',
          reference:
            'apps/web/src/lib/features/sources/source-controls.ssr.test.ts › exact pending disabled/aria-busy and idle enabled Run now Svelte SSR output; apps/web/src/lib/features/sources/client-closure.test.ts',
        },
      ],
    ),
    feature(
      'SOURCES-02',
      'apps/web/src/source-control-context.tsx; apps/web/src/components/source-control-summary.tsx',
      'apps/web/e2e/production-report.spec.ts › provides one accessible responsive source-control surface',
      'apps/web/src/lib/features/sources/source-control-provider.svelte; apps/web/src/lib/features/sources/source-control-summary.svelte',
      'apps/web/src/lib/features/sources/service.test.ts › deduplicates publications and invalidates only current Report aliases',
      [
        {
          commit: renderedPendingTestCommit,
          kind: 'test',
          phase: 'target',
          reference:
            'apps/web/src/lib/features/sources/source-controls.ssr.test.ts › exact pending disabled/aria-busy and idle enabled Run all Svelte SSR output; apps/web/src/lib/features/sources/client-closure.test.ts',
        },
      ],
    ),
    currentRecord(owner, {
      currentOwner: 'apps/web/src/components/source-control-summary.tsx',
      evidence: [
        { kind: 'source', reference: 'apps/web/src/components/source-control-summary.tsx' },
        {
          commit: renderedPendingTestCommit,
          kind: 'source',
          phase: 'target',
          reference:
            'apps/web/src/lib/features/sources/source-control-summary.svelte; apps/web/src/lib/features/sources/INTEGRATION.md',
        },
        {
          commit: renderedPendingTestCommit,
          kind: 'test',
          phase: 'target',
          reference:
            'apps/web/src/lib/features/sources/source-components.test.ts; apps/web/src/lib/features/sources/source-controls.ssr.test.ts',
        },
      ],
      id: 'tsx:apps/web/src/components/source-control-summary.tsx',
      kind: 'production-tsx',
    }),
    currentRecord(owner, {
      currentOwner: 'apps/web/src/routes/sources.tsx',
      evidence: [
        { kind: 'source', reference: 'apps/web/src/routes/sources.tsx' },
        {
          commit: renderedPendingTestCommit,
          kind: 'source',
          phase: 'target',
          reference:
            'apps/web/src/lib/features/sources/sources-page.svelte; apps/web/src/lib/features/sources/source-card.svelte; apps/web/src/lib/features/sources/source-actions.svelte',
        },
        {
          commit: renderedPendingTestCommit,
          kind: 'test',
          phase: 'target',
          reference:
            'apps/web/src/lib/features/sources/source-components.test.ts; apps/web/src/lib/features/sources/source-controls.ssr.test.ts; apps/web/src/lib/features/sources/event-stream.server.test.ts',
        },
      ],
      id: 'tsx:apps/web/src/routes/sources.tsx',
      kind: 'production-tsx',
    }),
    currentRecord(owner, {
      currentOwner: 'apps/web/src/source-control-context.tsx',
      evidence: [
        { kind: 'source', reference: 'apps/web/src/source-control-context.tsx' },
        {
          commit: reviewCorrectionCommit,
          kind: 'source',
          phase: 'target',
          reference:
            'apps/web/src/lib/features/sources/context.svelte.ts; apps/web/src/lib/features/sources/service.ts; apps/web/src/lib/features/sources/source-control-provider.svelte',
        },
        {
          commit: reviewCorrectionCommit,
          kind: 'test',
          phase: 'target',
          reference:
            'apps/web/src/lib/features/sources/service.test.ts; apps/web/src/lib/features/sources/client-closure.test.ts',
        },
      ],
      id: 'tsx:apps/web/src/source-control-context.tsx',
      kind: 'production-tsx',
    }),
  ],
});
