import { currentRecord } from '../helpers';
import { defineParityShard, type ParityKind, type ParityRecord } from '../schema';

const owner = 'P10' as const;
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
const implementationCommit = '8e35926307dabacd956189ba3aba0987212bee32';

const replacementRecord = (input: {
  readonly currentOwner: string;
  readonly currentTest?: string;
  readonly id: string;
  readonly kind: ParityKind;
  readonly source: string;
  readonly test: string;
}): ParityRecord => {
  const record = currentRecord(owner, {
    currentOwner: input.currentOwner,
    evidence: [
      { kind: input.kind === 'production-tsx' ? 'source' : 'test', reference: input.currentOwner },
      ...(input.currentTest === undefined ? [] : [{ kind: 'test' as const, reference: input.currentTest }]),
    ],
    id: input.id,
    kind: input.kind,
  });
  return {
    ...record,
    evidence: [
      ...record.evidence,
      { commit: implementationCommit, kind: 'source', phase: 'target', reference: input.source },
      { commit: implementationCommit, kind: 'test', phase: 'target', reference: input.test },
    ],
  };
};

const sourceReplacement = (currentOwner: string, source: string, test: string): ParityRecord =>
  replacementRecord({ currentOwner, id: `tsx:${currentOwner}`, kind: 'production-tsx', source, test });

const managementSsrEvidence =
  'apps/web/src/lib/features/skills/management/management.ssr.test.ts › renders individually named diagnostics and authoritative installation context; renders the responsive matrix, filters, reconcile action, and both projections from settled data; renders neutral unmanaged backlog without invoking a filesystem or RPC client';

export default defineParityShard({
  owner,
  records: [
    replacementRecord({
      currentOwner:
        'apps/web/src/skills-consolidate.tsx; apps/web/src/skills-health.tsx; apps/web/src/skills-matrix.tsx',
      currentTest: 'apps/web/e2e/skills.spec.ts › unmanaged, diagnostics, reconcile, and matrix cases',
      id: 'SKILLS-06',
      kind: 'feature',
      source:
        'apps/web/src/lib/features/skills/management/model.ts; apps/web/src/lib/features/skills/management/skills-health-slot.svelte; apps/web/src/lib/features/skills/management/skills-matrix-slot.svelte; apps/web/src/lib/features/skills/management/skills-matrix.svelte; apps/web/src/lib/features/skills/management/skills-consolidate.svelte; apps/web/src/lib/features/skills/management/skill-diagnostics.svelte; apps/web/src/lib/features/skills/management/INTEGRATION.md',
      test: `${managementSsrEvidence}; apps/web/src/lib/features/skills/management/model.test.ts › previews without applying unmanaged content and returns the server snapshot unchanged; maps enable and disable requests without changing skill identity`,
    }),
    sourceReplacement(
      'apps/web/src/skill-diagnostics.tsx',
      'apps/web/src/lib/features/skills/management/skill-diagnostics.svelte; apps/web/src/lib/features/skills/management/skills-health-slot.svelte',
      'apps/web/src/lib/features/skills/management/management.ssr.test.ts › renders individually named diagnostics and authoritative installation context',
    ),
    sourceReplacement(
      'apps/web/src/skills-consolidate.tsx',
      'apps/web/src/lib/features/skills/management/skills-consolidate.svelte',
      'apps/web/src/lib/features/skills/management/management.ssr.test.ts › renders neutral unmanaged backlog without invoking a filesystem or RPC client',
    ),
    sourceReplacement(
      'apps/web/src/skills-health.tsx',
      'apps/web/src/lib/features/skills/management/skills-health.svelte; apps/web/src/lib/features/skills/management/skills-health-slot.svelte',
      'apps/web/src/lib/features/skills/management/management.ssr.test.ts › renders the responsive matrix, filters, reconcile action, and both projections from settled data',
    ),
    sourceReplacement(
      'apps/web/src/skills-matrix.tsx',
      'apps/web/src/lib/features/skills/management/skills-matrix.svelte; apps/web/src/lib/features/skills/management/skills-matrix-slot.svelte; apps/web/src/lib/features/skills/management/model.ts',
      'apps/web/src/lib/features/skills/management/management.ssr.test.ts › renders the responsive matrix, filters, reconcile action, and both projections from settled data; apps/web/src/lib/features/skills/management/model.test.ts › preserves matrix sorting, filtering, origin, invocation, and projection tones',
    ),
  ].map(completeAtCutover),
});
