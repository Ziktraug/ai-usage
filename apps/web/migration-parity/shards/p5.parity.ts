import { currentRecord } from '../helpers';
import { defineParityShard, type ParityKind, type ParityRecord } from '../schema';

const owner = 'P5' as const;
const implementationCommit = 'e951cd1554efd8d459c517c2376e93a4c9669535';

interface ReplacementEvidence {
  readonly command?: string;
  readonly source: string;
  readonly test: string;
}

const replacementRecord = (input: {
  readonly currentOwner: string;
  readonly currentTest?: string;
  readonly id: string;
  readonly kind: ParityKind;
  readonly replacement: ReplacementEvidence;
}): ParityRecord => {
  const record = currentRecord(owner, {
    currentOwner: input.currentOwner,
    evidence: [
      { kind: input.kind === 'render-suite' ? 'test' : 'source', reference: input.currentOwner },
      ...(input.currentTest === undefined ? [] : [{ kind: 'test' as const, reference: input.currentTest }]),
    ],
    id: input.id,
    kind: input.kind,
  });
  return {
    ...record,
    evidence: [
      ...record.evidence,
      {
        commit: implementationCommit,
        kind: 'source',
        phase: 'target',
        reference: input.replacement.source,
      },
      {
        commit: implementationCommit,
        kind: 'test',
        phase: 'target',
        reference: input.replacement.test,
      },
      ...(input.replacement.command === undefined
        ? []
        : [
            {
              commit: implementationCommit,
              kind: 'command' as const,
              phase: 'target' as const,
              reference: input.replacement.command,
            },
          ]),
    ],
  };
};

const sourceReplacement = (currentOwner: string, source: string, test: string): ParityRecord =>
  replacementRecord({
    currentOwner,
    id: `tsx:${currentOwner}`,
    kind: 'production-tsx',
    replacement: { source, test },
  });

export default defineParityShard({
  owner,
  records: [
    replacementRecord({
      currentOwner:
        'apps/web/src/routes/skills.global.tsx; apps/web/src/routes/skills.global.$skillName.tsx; apps/web/src/routes/skills.matrix.tsx; apps/web/src/routes/skills.projects.$projectKey.tsx; apps/web/src/routes/skills.projects.$projectKey.$skillName.tsx; apps/web/src/skills-selection-link.tsx',
      currentTest: 'apps/web/src/skills-page-model.test.ts; apps/web/e2e/skills.spec.ts › selection links',
      id: 'SKILLS-01',
      kind: 'feature',
      replacement: {
        command:
          'bun test apps/web/src/lib/features/skills/shell/model-parity.test.ts apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts',
        source:
          'apps/web/src/lib/features/skills/shell/model.ts; apps/web/src/lib/features/skills/shell/navigation.ts; apps/web/src/lib/features/skills/shell/selection-link.svelte; apps/web/src/lib/features/skills/shell/INTEGRATION.md',
        test: 'apps/web/src/lib/features/skills/shell/model-parity.test.ts › preserves grouped project identity and encoded nested selection links; apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › renders nested Project selection and its settled read-only document',
      },
    }),
    replacementRecord({
      currentOwner:
        'apps/web/src/routes/skills.tsx; apps/web/src/skills-workspace.tsx; apps/web/src/skills-tree.tsx; apps/web/src/skills-context-panel.tsx',
      currentTest: 'apps/web/e2e/skills.spec.ts › workspace geometry and mobile cases',
      id: 'SKILLS-02',
      kind: 'feature',
      replacement: {
        command: 'bun run --cwd apps/web check:svelte; bun run --cwd apps/web build:svelte',
        source:
          'apps/web/src/lib/features/skills/shell/skills-shell.svelte; apps/web/src/lib/features/skills/shell/skills-workspace.svelte; apps/web/src/lib/features/skills/shell/skills-tree.svelte; apps/web/src/lib/features/skills/shell/skills-inspector.svelte',
        test: 'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › renders a meaningful selected Global workspace without ClientOnly; exact Browse skills, Skill picker scopes, and Selected skill detail labels',
      },
    }),
    replacementRecord({
      currentOwner:
        'apps/web/src/skills-route-controller.ts; apps/web/src/skills-route-controller-state.ts; apps/web/src/web-query-options.ts',
      currentTest:
        'apps/web/src/skills-route-controller.test.ts; apps/web/e2e/skills.spec.ts › snapshot refresh, dirty draft, and deterministic backend cases',
      id: 'SKILLS-05',
      kind: 'feature',
      replacement: {
        command:
          'bun test apps/web/src/lib/features/skills/shell/snapshot-controller.test.ts apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts apps/web/src/lib/query/options/skills.test.ts',
        source:
          'apps/web/src/lib/features/skills/shell/skills-shell.svelte; apps/web/src/lib/features/skills/shell/snapshot-controller.ts; apps/web/src/lib/features/skills/shell/slot-context.ts; apps/web/src/lib/features/skills/shell/data.ts',
        test: 'apps/web/src/lib/features/skills/shell/snapshot-controller.test.ts › coordinates dirty retain, focus, and discard across real Query snapshot updates; apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › hydrates a bounded awaited route into a new provider without duplicate Skills acquisition',
      },
    }),
    sourceReplacement(
      'apps/web/src/routes/skills.global.$skillName.tsx',
      'apps/web/src/lib/features/skills/shell/model.ts; apps/web/src/lib/features/skills/shell/skills-shell.svelte',
      'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › renders a meaningful selected Global workspace without ClientOnly',
    ),
    sourceReplacement(
      'apps/web/src/routes/skills.global.tsx',
      'apps/web/src/lib/features/skills/shell/model.ts; apps/web/src/lib/features/skills/shell/navigation.ts',
      'apps/web/src/lib/features/skills/shell/model-parity.test.ts › requests canonical fallback for stale deep links after settled data',
    ),
    sourceReplacement(
      'apps/web/src/routes/skills.matrix.tsx',
      'apps/web/src/lib/features/skills/shell/skills-workspace.svelte; apps/web/src/lib/features/skills/shell/slot-context.ts',
      'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › exposes the management packet matrix slot without implementing it',
    ),
    sourceReplacement(
      'apps/web/src/routes/skills.projects.$projectKey.$skillName.tsx',
      'apps/web/src/lib/features/skills/shell/model.ts; apps/web/src/lib/features/skills/shell/skills-shell.svelte',
      'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › renders nested Project selection and its settled read-only document',
    ),
    sourceReplacement(
      'apps/web/src/routes/skills.projects.$projectKey.tsx',
      'apps/web/src/lib/features/skills/shell/model.ts; apps/web/src/lib/features/skills/shell/navigation.ts',
      'apps/web/src/lib/features/skills/shell/model-parity.test.ts › derives the nested selection from the URL without a second state owner',
    ),
    sourceReplacement(
      'apps/web/src/routes/skills.tsx',
      'apps/web/src/lib/features/skills/shell/data.ts; apps/web/src/lib/features/skills/shell/skills-shell.svelte; apps/web/src/lib/features/skills/shell/INTEGRATION.md',
      'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › hydrates a bounded awaited route into a new provider without duplicate Skills acquisition',
    ),
    sourceReplacement(
      'apps/web/src/skills-context-panel.tsx',
      'apps/web/src/lib/features/skills/shell/skills-inspector.svelte; apps/web/src/lib/features/skills/shell/slot-context.ts',
      'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › renders a meaningful selected Global workspace without ClientOnly',
    ),
    sourceReplacement(
      'apps/web/src/skills-detail.tsx',
      'apps/web/src/lib/features/skills/shell/skills-workspace.svelte; apps/web/src/lib/features/skills/shell/slot-context.ts',
      'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › renders nested Project selection and its settled read-only document',
    ),
    sourceReplacement(
      'apps/web/src/skills-selection-link.tsx',
      'apps/web/src/lib/features/skills/shell/selection-link.svelte; apps/web/src/lib/features/skills/shell/navigation.ts',
      'apps/web/src/lib/features/skills/shell/model-parity.test.ts › preserves grouped project identity and encoded nested selection links',
    ),
    sourceReplacement(
      'apps/web/src/skills-tree.tsx',
      'apps/web/src/lib/features/skills/shell/skills-tree.svelte; apps/web/src/lib/features/skills/shell/skills-workspace.svelte',
      'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › renders a meaningful selected Global workspace without ClientOnly',
    ),
    sourceReplacement(
      'apps/web/src/skills-workspace.tsx',
      'apps/web/src/lib/features/skills/shell/skills-workspace.svelte; apps/web/src/lib/features/skills/shell/skills-shell.svelte; apps/web/src/lib/features/skills/shell/slot-context.ts',
      'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › renders a meaningful selected Global workspace without ClientOnly; exposes the management packet matrix slot without implementing it',
    ),
    replacementRecord({
      currentOwner: 'apps/web/src/skills-detail.render.test.tsx',
      id: 'render:apps/web/src/skills-detail.render.test.tsx',
      kind: 'render-suite',
      replacement: {
        source:
          'apps/web/src/lib/features/skills/shell/skills-workspace.fixture.svelte; apps/web/src/lib/features/skills/shell/skills-workspace.svelte',
        test: 'apps/web/src/lib/features/skills/shell/skills-workspace.ssr.test.ts › renders a meaningful selected Global workspace without ClientOnly; renders nested Project selection and its settled read-only document',
      },
    }),
  ],
});
