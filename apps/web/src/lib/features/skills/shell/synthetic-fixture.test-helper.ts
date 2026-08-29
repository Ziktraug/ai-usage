import type {
  KnownSkillProjectPath,
  ProjectSkillInventory,
  ProjectSkillMarkdownDocument,
  SkillManagementSnapshot,
  SkillMarkdownDocument,
  SkillObservations,
} from '@ai-usage/web-contract/skills';

type WireSourceSkill = SkillManagementSnapshot['skills'][number];

const skill = (name: string): WireSourceSkill => ({
  description: `${name} synthetic description`,
  diagnostics: [],
  enabled: true,
  manifest: { description: `${name} synthetic description`, fields: [], markdown: `# ${name}\n`, name },
  name,
  path: `/synthetic/source/skills/${name}`,
  skillMdPath: `/synthetic/source/skills/${name}/SKILL.md`,
  tokenCount: { approximate: true, references: 1, skillMd: 2, total: 3 },
  validationStatus: 'valid',
});

export const syntheticSnapshot = (
  skills: SkillManagementSnapshot['skills'] = [skill('alpha-skill')],
): SkillManagementSnapshot => ({
  config: { projectPaths: ['/synthetic/project'], sourceRepoPath: '/synthetic/source' },
  configured: true,
  diagnostics: [],
  nativeRuleFindings: [],
  projections: [],
  skills,
  sourceState: { skillEnabledByName: Object.fromEntries(skills.map(({ name }) => [name, true])), version: 1 },
  summary: {
    activeSkillCount: skills.length,
    diagnosticCount: 0,
    healthyProjectionCount: 0,
    skillCount: skills.length,
    targetCount: 0,
    unhealthyProjectionCount: 0,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
});

/**
 * One managed skill observed in two harnesses at two tiers, one unmanaged skill observed by Claude
 * Code, and Cursor enumerated as unable to observe. Enough to exercise every reading the surface has
 * to keep straight without inflating the counts any test asserts on.
 */
export const syntheticObservations: SkillObservations = {
  harnesses: [
    { harnessKey: 'claude', label: 'Claude Code', observability: 'observable' },
    { harnessKey: 'codex', label: 'Codex', observability: 'observable' },
    { harnessKey: 'opencode', label: 'OpenCode', observability: 'observable' },
    { harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' },
  ],
  lowerBound: false,
  skills: [
    {
      lastObservedAt: '2026-08-02T09:00:00.000Z',
      resolvedPaths: ['/synthetic/source/skills/alpha-skill'],
      skillName: 'alpha-skill',
      tallies: [
        {
          count: 2,
          harnessKey: 'claude',
          harnessLabel: 'Claude Code',
          lastObservedAt: '2026-08-02T09:00:00.000Z',
          tier: 'declared',
        },
        {
          count: 1,
          harnessKey: 'codex',
          harnessLabel: 'Codex',
          lastObservedAt: '2026-08-01T09:00:00.000Z',
          tier: 'inferred',
        },
      ],
    },
    {
      lastObservedAt: '2026-08-01T10:00:00.000Z',
      resolvedPaths: [],
      skillName: 'artifact-design',
      tallies: [
        {
          count: 1,
          harnessKey: 'claude',
          harnessLabel: 'Claude Code',
          lastObservedAt: '2026-08-01T10:00:00.000Z',
          tier: 'declared',
        },
      ],
    },
  ],
  skipped: 0,
};

export const syntheticKnownPaths: readonly KnownSkillProjectPath[] = [
  {
    groupId: 'synthetic-group',
    groupLabel: 'Synthetic group',
    label: 'Synthetic project',
    path: '/synthetic/project',
    project: 'synthetic-project',
    sessions: 2,
  },
];

export const syntheticInventories: readonly ProjectSkillInventory[] = [
  {
    diagnostics: [],
    observations: [
      {
        description: 'Project review skill',
        diagnostics: [],
        invocation: 'auto',
        markdownReadable: true,
        name: 'project-review',
        path: '/synthetic/project/.agents/skills/project-review',
        placement: 'owned-directory',
        runtimeDirId: 'agents-project',
        skillMdPath: '/synthetic/project/.agents/skills/project-review/SKILL.md',
        tokenCount: { approximate: true, references: 0, skillMd: 4, total: 4 },
        validationStatus: 'valid',
      },
    ],
    projectPath: '/synthetic/project',
  },
];

export const syntheticManagedDocument: SkillMarkdownDocument = {
  content: '# Alpha synthetic document',
  path: '/synthetic/source/skills/alpha-skill/SKILL.md',
  sha256: 'a'.repeat(64),
  skillName: 'alpha-skill',
};

export const syntheticProjectDocument: ProjectSkillMarkdownDocument = {
  content: '# Project synthetic document',
  path: '/synthetic/project/.agents/skills/project-review/SKILL.md',
  skillName: 'project-review',
  truncated: false,
};
