import type { SkillManagementSnapshot } from '@ai-usage/skills';
import { normalizeSkillsQuerySnapshot } from '../shell/model';
import { syntheticSnapshot as shellSyntheticSnapshot } from '../shell/synthetic-fixture.test-helper';

export const syntheticManagementSnapshot = (): SkillManagementSnapshot => {
  const base = normalizeSkillsQuerySnapshot(shellSyntheticSnapshot());
  const alpha = base.skills[0];
  if (alpha === undefined) {
    throw new Error('Synthetic shell fixture must contain alpha-skill');
  }
  const skills: SkillManagementSnapshot['skills'] = [
    {
      ...alpha,
      diagnostics: [
        {
          code: 'SkillMarkdownTokenWarning',
          message: 'SKILL.md is approaching the recommended token limit.',
          path: '/synthetic/source/skills/alpha-skill/SKILL.md',
          severity: 'warning',
          skillName: 'alpha-skill',
          tokenMeasurement: { observed: 1240, threshold: 1000, unit: 'tokens' },
        },
      ],
      tokenCount: { approximate: true, references: 2, skillMd: 1240, total: 1242 },
      validationStatus: 'warning',
    },
    {
      ...alpha,
      description: 'Manual synthetic skill',
      enabled: false,
      manifest: {
        ...alpha.manifest,
        description: 'Manual synthetic skill',
        fields: [{ key: 'disable-model-invocation', kind: 'standard', value: true }],
        name: 'beta-skill',
      },
      name: 'beta-skill',
      path: '/synthetic/source/skills/beta-skill',
      skillMdPath: '/synthetic/source/skills/beta-skill/SKILL.md',
    },
  ];
  return {
    ...base,
    projections: [
      {
        diagnostics: [],
        expectedPath: '/synthetic/runtime/skills/alpha-skill',
        skillName: 'alpha-skill',
        state: 'missing',
        targetId: 'codex',
      },
    ],
    skills,
    sourceState: {
      skillEnabledByName: { 'alpha-skill': true, 'beta-skill': false },
      skillOriginByName: { 'alpha-skill': 'github', 'beta-skill': 'skills.sh' },
      version: 1,
    },
    summary: {
      activeSkillCount: 1,
      diagnosticCount: 1,
      healthyProjectionCount: 0,
      skillCount: 2,
      targetCount: 1,
      unhealthyProjectionCount: 1,
      unmanagedEntryCount: 1,
    },
    targets: [
      {
        enabled: true,
        id: 'codex',
        kind: 'standard-interop',
        label: 'Codex',
        missing: false,
        observed: true,
        path: '/synthetic/runtime/skills',
        scope: 'system',
      },
    ],
    unmanagedEntries: [
      {
        actualPath: '/synthetic/runtime/skills/legacy-local-copy',
        diagnostics: [],
        expectedPath: '/synthetic/runtime/skills/legacy-local-copy',
        skillName: 'legacy-local-copy',
        state: 'unmanaged-copy',
        targetId: 'codex',
      },
    ],
  };
};
