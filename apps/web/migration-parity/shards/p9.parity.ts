import { currentRecord } from '../helpers';
import { defineParityShard, type ParityKind, type ParityRecord } from '../schema';

const owner = 'P9' as const;
const implementationCommit = '9d483032ab369e374165248782f7641af0e62ccf';
const packetTestCommand =
  'bun test apps/web/src/lib/features/skills/editor/*.test.ts apps/web/src/skill-markdown-editor-model.test.ts apps/web/src/lib/features/skills/shell/snapshot-controller.test.ts apps/web/src/lib/features/shell/dirty-navigation-context.test.ts apps/web/src/lib/query/options/skills.test.ts';

interface ReplacementEvidence {
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
      {
        commit: implementationCommit,
        kind: 'command',
        phase: 'target',
        reference: packetTestCommand,
      },
    ],
  };
};

const sourceReplacement = (currentOwner: string, replacement: ReplacementEvidence): ParityRecord =>
  replacementRecord({
    currentOwner,
    id: `tsx:${currentOwner}`,
    kind: 'production-tsx',
    replacement,
  });

export default defineParityShard({
  owner,
  records: [
    replacementRecord({
      currentOwner: 'apps/web/src/skill-markdown-editor.tsx; apps/web/src/skill-markdown-editor-model.ts',
      currentTest: 'apps/web/e2e/skills.spec.ts › edit/save/conflict/shortcut cases',
      id: 'SKILLS-03',
      kind: 'feature',
      replacement: {
        source:
          'apps/web/src/lib/features/skills/editor/controller.ts; apps/web/src/lib/features/skills/editor/skill-markdown-editor.svelte; apps/web/src/lib/features/skills/editor/slot-controller.ts; apps/web/src/lib/features/skills/editor/skills-editor-slot.svelte; apps/web/src/lib/features/skills/editor/INTEGRATION.md',
        test: 'apps/web/src/lib/features/skills/editor/controller.test.ts; apps/web/src/lib/features/skills/editor/slot-controller.test.ts; apps/web/src/lib/features/skills/editor/editor-components.ssr.test.ts; apps/web/src/lib/features/skills/editor/editor-client-closure.test.ts › exact drafts, save/refresh conflict, stale generations, same-document resynchronization, shortcuts, smallest-key cache, and settled SSR',
      },
    }),
    replacementRecord({
      currentOwner: 'apps/web/src/routes/skills.tsx; apps/web/src/discard-confirmation-dialog.tsx',
      currentTest: 'apps/web/e2e/skills.spec.ts › protects an unsaved SKILL.md draft during navigation and reload',
      id: 'SKILLS-04',
      kind: 'feature',
      replacement: {
        source:
          'apps/web/src/lib/features/skills/editor/discard-dialog-controller.ts; apps/web/src/lib/features/skills/editor/discard-confirmation-dialog.svelte; apps/web/src/lib/features/skills/editor/skills-editor-slot.svelte; apps/web/src/lib/features/skills/editor/slot-controller.ts; apps/web/src/lib/features/skills/editor/INTEGRATION.md; apps/web/src/lib/features/shell/dirty-navigation-context.ts; apps/web/src/lib/features/skills/shell/snapshot-controller.ts; apps/web/src/lib/features/skills/shell/slot-context.ts',
        test: 'apps/web/src/lib/features/skills/editor/discard-dialog-controller.test.ts; apps/web/src/lib/features/skills/editor/slot-controller.test.ts; apps/web/src/lib/features/skills/editor/editor-components.ssr.test.ts; apps/web/src/lib/features/shell/dirty-navigation-context.test.ts; apps/web/src/lib/features/skills/shell/snapshot-controller.test.ts › one stable dirty identity, keep/discard/focus, pending Escape handling, and cleanup',
      },
    }),
    sourceReplacement('apps/web/src/discard-confirmation-dialog.tsx', {
      source:
        'apps/web/src/lib/features/skills/editor/discard-dialog-controller.ts; apps/web/src/lib/features/skills/editor/discard-confirmation-dialog.svelte',
      test: 'apps/web/src/lib/features/skills/editor/discard-dialog-controller.test.ts; apps/web/src/lib/features/skills/editor/editor-components.ssr.test.ts › focus trap, Keep, awaited discard, disabled duplicate actions, and focus restoration',
    }),
    sourceReplacement('apps/web/src/skill-markdown-editor.tsx', {
      source:
        'apps/web/src/lib/features/skills/editor/controller.ts; apps/web/src/lib/features/skills/editor/skill-markdown-editor.svelte; apps/web/src/lib/features/skills/editor/slot-controller.ts; apps/web/src/lib/features/skills/editor/skills-editor-slot.svelte',
      test: 'apps/web/src/lib/features/skills/editor/controller.test.ts; apps/web/src/lib/features/skills/editor/slot-controller.test.ts; apps/web/src/lib/features/skills/editor/editor-components.ssr.test.ts; apps/web/src/lib/features/skills/editor/editor-client-closure.test.ts',
    }),
  ],
});
