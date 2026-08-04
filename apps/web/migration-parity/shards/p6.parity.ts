import { currentRecord } from '../helpers';
import { defineParityShard, type ParityEvidence, type ParityRecord } from '../schema';

const owner = 'P6' as const;
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
const implementationCommit = 'f996ece3f50d225ed3f374c4a06d6ee45718224e';
const lifecycleTestCommit = 'f996ece3f50d225ed3f374c4a06d6ee45718224e';
const reviewCorrectionCommit = 'f996ece3f50d225ed3f374c4a06d6ee45718224e';
const renderedPendingTestCommit = 'f996ece3f50d225ed3f374c4a06d6ee45718224e';
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
        'bun test apps/web/src/lib/features/sources/*.test.ts apps/web/src/source-control-client.test.ts apps/web/src/source-control-presentation.test.ts (59 pass, 0 fail, 150 expect calls); bun run --cwd apps/web check; bun run --cwd apps/web build:svelte; bun x ultracite check apps/web/src/lib/features/sources',
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
      'apps/web/src/lib/features/sources/sources-page.svelte; apps/web/src/lib/features/sources/copy-feedback.ts; apps/web/src/source-control-presentation-model.ts; apps/web/src/lib/features/sources/service.ts; apps/web/svelte-shadow/routes/api/source-control/+server.ts; apps/web/svelte-shadow/routes/api/source-control/command/+server.ts',
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
            'apps/web/src/lib/features/sources/source-controls.ssr.test.ts › exact pending disabled/aria-busy and idle enabled Run now Svelte SSR output; apps/web/src/lib/features/sources/copy-feedback.test.ts › repeat cancellation and registered destruction lifecycle; apps/web/src/lib/features/sources/presentation-model.test.ts › accepted legacy projection parity; apps/web/src/lib/features/sources/client-closure.test.ts › recursive aliases, workspace exports, barrels, and synthetic forbidden leaks',
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
  ].map(completeAtCutover),
});
