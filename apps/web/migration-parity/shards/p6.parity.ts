import { currentRecord } from '../helpers';
import { defineParityShard, type ParityEvidence } from '../schema';

const owner = 'P6' as const;
const implementationCommit = 'f02f29f3f8f260407d003426f0e44d884743d883';
const lifecycleTestCommit = 'f598271e01c46edfe5213f6fb8479171810c7495';
const reviewCorrectionCommit = 'afe31e1b035c95ec461236b6c2f29467a6714268';
const renderedPendingTestCommit = '3f9985f2c0b3dec6055b6027a33705dff8b2bb8d';
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
        'bun test scoped P6 tests (5 passed); bun run --cwd apps/web check:svelte (0 errors); bun x ultracite check scoped P6 files',
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
            'apps/web/src/lib/features/sources/source-controls.ssr.test.ts › renders and omits per-source Run now aria-busy from actual Svelte SSR output',
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
            'apps/web/src/lib/features/sources/source-controls.ssr.test.ts › renders and omits summary Run all aria-busy from actual Svelte SSR output',
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
            'apps/web/src/lib/features/sources/context.ts; apps/web/src/lib/features/sources/service.ts; apps/web/src/lib/features/sources/source-control-provider.svelte',
        },
        {
          commit: reviewCorrectionCommit,
          kind: 'test',
          phase: 'target',
          reference: 'apps/web/src/lib/features/sources/service.test.ts',
        },
      ],
      id: 'tsx:apps/web/src/source-control-context.tsx',
      kind: 'production-tsx',
    }),
  ],
});
