import type {
  KnownSkillProjectPath,
  ProjectSkillInventory,
  ProjectSkillMarkdownDocument,
  SkillManagementSnapshot,
  SkillMarkdownDocument,
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
