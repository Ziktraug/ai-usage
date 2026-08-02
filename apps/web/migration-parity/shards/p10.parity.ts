import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P10' as const;

export default defineParityShard({
  owner,
  records: [
    currentRecord(owner, {
      currentOwner:
        'apps/web/src/skills-consolidate.tsx; apps/web/src/skills-health.tsx; apps/web/src/skills-matrix.tsx',
      evidence: [
        {
          kind: 'test',
          reference: 'apps/web/e2e/skills.spec.ts › unmanaged, diagnostics, reconcile, and matrix cases',
        },
      ],
      id: 'SKILLS-06',
      kind: 'feature',
    }),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/skill-diagnostics.tsx',
      'apps/web/src/skills-consolidate.tsx',
      'apps/web/src/skills-health.tsx',
      'apps/web/src/skills-matrix.tsx',
    ]),
  ],
});
