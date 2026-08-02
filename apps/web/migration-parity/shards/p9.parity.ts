import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P9' as const;

export default defineParityShard({
  owner,
  records: [
    currentRecord(owner, {
      currentOwner: 'apps/web/src/skill-markdown-editor.tsx; apps/web/src/skill-markdown-editor-model.ts',
      evidence: [{ kind: 'test', reference: 'apps/web/e2e/skills.spec.ts › edit/save/conflict/shortcut cases' }],
      id: 'SKILLS-03',
      kind: 'feature',
    }),
    currentRecord(owner, {
      currentOwner: 'apps/web/src/routes/skills.tsx; apps/web/src/discard-confirmation-dialog.tsx',
      evidence: [
        {
          kind: 'test',
          reference: 'apps/web/e2e/skills.spec.ts › protects an unsaved SKILL.md draft during navigation and reload',
        },
      ],
      id: 'SKILLS-04',
      kind: 'feature',
    }),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/discard-confirmation-dialog.tsx',
      'apps/web/src/skill-markdown-editor.tsx',
    ]),
  ],
});
