import { currentRecord, sourceInventoryRecords } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'P5' as const;
const feature = (id: string, currentOwner: string, test: string) =>
  currentRecord(owner, {
    currentOwner,
    evidence: [
      { kind: 'source', reference: currentOwner },
      { kind: 'test', reference: test },
    ],
    id,
    kind: 'feature',
  });

export default defineParityShard({
  owner,
  records: [
    feature(
      'SKILLS-01',
      'apps/web/src/routes/skills*.tsx; apps/web/src/skills-selection-link.tsx',
      'apps/web/src/skills-page-model.test.ts; apps/web/e2e/skills.spec.ts › selection links',
    ),
    feature(
      'SKILLS-02',
      'apps/web/src/routes/skills.tsx; apps/web/src/skills-workspace.tsx',
      'apps/web/e2e/skills.spec.ts › workspace geometry and mobile cases',
    ),
    feature(
      'SKILLS-05',
      'apps/web/src/skills-route-controller.ts; apps/web/src/web-query-options.ts',
      'apps/web/e2e/skills.spec.ts › snapshot refresh, dirty draft, and deterministic backend cases',
    ),
    ...sourceInventoryRecords(owner, 'production-tsx', [
      'apps/web/src/routes/skills.global.$skillName.tsx',
      'apps/web/src/routes/skills.global.tsx',
      'apps/web/src/routes/skills.matrix.tsx',
      'apps/web/src/routes/skills.projects.$projectKey.$skillName.tsx',
      'apps/web/src/routes/skills.projects.$projectKey.tsx',
      'apps/web/src/routes/skills.tsx',
      'apps/web/src/skills-context-panel.tsx',
      'apps/web/src/skills-detail.tsx',
      'apps/web/src/skills-selection-link.tsx',
      'apps/web/src/skills-tree.tsx',
      'apps/web/src/skills-workspace.tsx',
    ]),
    ...sourceInventoryRecords(owner, 'render-suite', ['apps/web/src/skills-detail.render.test.tsx']),
  ],
});
