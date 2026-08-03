import { currentRecord } from '../helpers';
import { defineParityShard, type ParityKind, type ParityRecord } from '../schema';

const owner = 'P4' as const;
const implementationCommit = 'ff683bf921d81f3e10ee7883585f43626189c038';

interface TargetEvidence {
  readonly command?: string;
  readonly source: string;
  readonly test: string;
}

const replacementRecord = (input: {
  readonly currentOwner: string;
  readonly currentTest?: string;
  readonly id: string;
  readonly kind: ParityKind;
  readonly target: TargetEvidence;
}): ParityRecord => {
  const record = currentRecord(owner, {
    currentOwner: input.currentOwner,
    evidence: [
      { kind: input.kind === 'render-suite' ? 'test' : 'source', reference: input.currentOwner },
      ...(input.currentTest ? [{ kind: 'test' as const, reference: input.currentTest }] : []),
    ],
    id: input.id,
    kind: input.kind,
  });
  return {
    ...record,
    evidence: [
      ...record.evidence,
      { commit: implementationCommit, kind: 'source', phase: 'target', reference: input.target.source },
      { commit: implementationCommit, kind: 'test', phase: 'target', reference: input.target.test },
      ...(input.target.command
        ? [
            {
              commit: implementationCommit,
              kind: 'command' as const,
              phase: 'target' as const,
              reference: input.target.command,
            },
          ]
        : []),
    ],
  };
};

const sourceReplacement = (currentOwner: string, source: string, test: string): ParityRecord =>
  replacementRecord({
    currentOwner,
    id: `tsx:${currentOwner}`,
    kind: 'production-tsx',
    target: { source, test },
  });

const renderReplacement = (currentOwner: string, source: string, test: string): ParityRecord =>
  replacementRecord({
    currentOwner,
    id: `render:${currentOwner}`,
    kind: 'render-suite',
    target: { source, test },
  });

const detailTestCommand =
  'bun test apps/web/src/lib/features/sessions/detail/*.test.ts apps/web/src/dashboard-session-selection.test.ts apps/web/src/session-analysis.test.ts apps/web/src/session-analysis-model.test.ts apps/web/src/session-analysis-presentation.test.ts apps/web/src/session-analysis-error.test.ts apps/web/src/session-analysis-target.test.ts apps/web/src/session-neighbor-request-controller.test.ts apps/web/src/lib/query/options/session.test.ts';

export default defineParityShard({
  owner,
  records: [
    replacementRecord({
      currentOwner: 'apps/web/src/dashboard-session-selection.ts; apps/web/src/session-drawer.tsx',
      currentTest:
        'apps/web/src/dashboard-session-selection.test.ts; apps/web/e2e/dashboard.spec.ts › drawer navigation',
      id: 'SESSION-05',
      kind: 'feature',
      target: {
        command: detailTestCommand,
        source:
          'apps/web/src/lib/features/sessions/detail/controller.ts; apps/web/src/lib/features/sessions/detail/query-owner.ts; apps/web/src/lib/features/sessions/detail/session-detail-slot.svelte; apps/web/src/lib/features/sessions/detail/session-drawer.svelte; apps/web/src/lib/features/sessions/detail/INTEGRATION.md',
        test: 'apps/web/src/lib/features/sessions/detail/controller.test.ts; apps/web/src/lib/features/sessions/detail/query-owner.test.ts; apps/web/src/lib/features/sessions/detail/components.ssr.test.ts; apps/web/src/lib/features/sessions/detail/composition.test.ts; apps/web/src/lib/features/sessions/detail/client-closure.test.ts',
      },
    }),
    replacementRecord({
      currentOwner: 'apps/web/src/session-analysis.tsx; apps/web/src/session-vcs-summary.tsx',
      currentTest:
        'apps/web/src/session-analysis.render.test.tsx; apps/web/e2e/production-report.spec.ts › chronology and VCS',
      id: 'SESSION-06',
      kind: 'feature',
      target: {
        command: detailTestCommand,
        source:
          'apps/web/src/lib/features/sessions/detail/session-analysis.svelte; apps/web/src/lib/features/sessions/detail/session-vcs-summary.svelte; apps/web/src/lib/features/sessions/detail/external-link-icon.svelte; apps/web/src/lib/features/sessions/detail/drawer-detail-item.svelte; apps/web/src/lib/features/sessions/detail/highlighted-text.svelte',
        test: 'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts; apps/web/src/lib/features/sessions/detail/composition.test.ts; apps/web/src/session-analysis-model.test.ts; apps/web/src/session-analysis-presentation.test.ts; apps/web/src/session-analysis-error.test.ts; apps/web/src/session-analysis-target.test.ts',
      },
    }),
    sourceReplacement(
      'apps/web/src/drawer-detail-item.tsx',
      'apps/web/src/lib/features/sessions/detail/drawer-detail-item.svelte',
      'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › preserves literal Unicode highlighting and Popover accessibility',
    ),
    sourceReplacement(
      'apps/web/src/highlighted-text.tsx',
      'apps/web/src/lib/features/sessions/detail/highlighted-text.svelte',
      'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › preserves literal Unicode highlighting and Popover accessibility',
    ),
    sourceReplacement(
      'apps/web/src/session-analysis.tsx',
      'apps/web/src/lib/features/sessions/detail/session-analysis.svelte',
      'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › renders recorded/partial chronology, compressed gaps, phase trust, and multi-harness labels; keeps unavailable Retry semantics and sanitized VCS links exact; apps/web/src/lib/features/sessions/detail/composition.test.ts › keeps phase keys collision-safe and phase bands on the selected timeline scale',
    ),
    sourceReplacement(
      'apps/web/src/session-drawer.tsx',
      'apps/web/src/lib/features/sessions/detail/controller.ts; apps/web/src/lib/features/sessions/detail/query-owner.ts; apps/web/src/lib/features/sessions/detail/session-detail-slot.svelte; apps/web/src/lib/features/sessions/detail/session-drawer.svelte',
      'apps/web/src/lib/features/sessions/detail/controller.test.ts; apps/web/src/lib/features/sessions/detail/query-owner.test.ts; apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › keeps the portal Drawer client-owned while its controlled selection is settled during SSR; apps/web/src/lib/features/sessions/detail/composition.test.ts › keeps one Drawer and final-focus owner while selection moves between neighboring rows; keeps the P8 campaign slot between the comparison summary and the detail grid',
    ),
    sourceReplacement(
      'apps/web/src/session-vcs-summary.tsx',
      'apps/web/src/lib/features/sessions/detail/session-vcs-summary.svelte; apps/web/src/lib/features/sessions/detail/external-link-icon.svelte',
      'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › keeps unavailable Retry semantics and sanitized VCS links exact',
    ),
    renderReplacement(
      'apps/web/src/drawer-detail-item.render.test.tsx',
      'apps/web/src/lib/features/sessions/detail/drawer-detail-item.svelte',
      'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › preserves literal Unicode highlighting and Popover accessibility',
    ),
    renderReplacement(
      'apps/web/src/highlighted-text.render.test.tsx',
      'apps/web/src/lib/features/sessions/detail/highlighted-text.svelte',
      'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › preserves literal Unicode highlighting and Popover accessibility',
    ),
    renderReplacement(
      'apps/web/src/session-analysis.render.test.tsx',
      'apps/web/src/lib/features/sessions/detail/session-analysis.svelte',
      'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › renders recorded/partial chronology, compressed gaps, phase trust, and multi-harness labels; keeps unavailable Retry semantics and sanitized VCS links exact',
    ),
    renderReplacement(
      'apps/web/src/session-drawer.render.test.tsx',
      'apps/web/src/lib/features/sessions/detail/session-drawer.svelte; apps/web/src/lib/features/sessions/detail/session-detail-slot.svelte',
      'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › keeps the portal Drawer client-owned while its controlled selection is settled during SSR; apps/web/src/lib/features/sessions/detail/controller.test.ts; apps/web/src/lib/features/sessions/detail/composition.test.ts',
    ),
    renderReplacement(
      'apps/web/src/session-vcs-summary.test.tsx',
      'apps/web/src/lib/features/sessions/detail/session-vcs-summary.svelte; apps/web/src/lib/features/sessions/detail/external-link-icon.svelte',
      'apps/web/src/lib/features/sessions/detail/components.ssr.test.ts › keeps unavailable Retry semantics and sanitized VCS links exact',
    ),
  ],
});
