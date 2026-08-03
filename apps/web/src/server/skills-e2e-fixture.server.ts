import type {
  Projection,
  ProjectionAction,
  ProjectSkillInventory,
  SkillManagementConfig,
  SkillManagementSnapshot,
  SkillMarkdownDocument,
  SkillMarkdownWriteInput,
  SkillTarget,
  SkillTargetDirectoryInput,
  SkillToggleInput,
  SourceSkill,
} from '@ai-usage/skills';
import type {
  KnownSkillProjectPath,
  ProjectSkillMarkdownDocument,
  ProjectSkillMarkdownInput,
  SkillMarkdownSaveResult,
  SkillReconcileServerResult,
  SkillsServerResult,
} from './skills-contracts';

const target = (id: string, label: string, missing = false): SkillTarget => ({
  enabled: true,
  id,
  kind: 'standard-interop',
  label,
  missing,
  observed: !missing,
  path: `/fixture/targets/${id}`,
  scope: 'system',
});

const skill = (name: string): SourceSkill => ({
  description: `${name} deterministic Playwright fixture`,
  diagnostics: [],
  enabled: true,
  manifest: {
    description: `${name} deterministic Playwright fixture`,
    fields: [],
    markdown: `# ${name}\n`,
    name,
  },
  name,
  path: `/fixture/source/skills/${name}`,
  skillMdPath: `/fixture/source/skills/${name}/SKILL.md`,
  tokenCount: { approximate: true, references: 0, skillMd: 4, total: 4 },
  validationStatus: 'valid',
});

const projection = (skillName: string, targetId: string, state: Projection['state']): Projection => ({
  diagnostics: [],
  expectedPath: `/fixture/targets/${targetId}/${skillName}`,
  skillName,
  state,
  targetId,
});

const betaSkill: SourceSkill = {
  ...skill('beta-skill'),
  diagnostics: [
    {
      code: 'SkillMarkdownTokenWarning',
      message: 'SKILL.md is approaching the recommended token limit.',
      severity: 'warning',
      skillName: 'beta-skill',
      tokenMeasurement: { observed: 1240, threshold: 1000, unit: 'tokens' },
    },
    {
      code: 'SkillReferenceTokenWarning',
      message: 'Reference files are approaching the recommended token limit.',
      severity: 'warning',
      skillName: 'beta-skill',
      tokenMeasurement: { observed: 2400, threshold: 2000, unit: 'tokens' },
    },
  ],
  validationStatus: 'warning',
};

const skills = [skill('alpha-skill'), betaSkill];
const targets = [target('claude', 'Claude Code'), target('codex', 'Codex', true)];
const projections = [
  projection('alpha-skill', 'claude', 'linked'),
  projection('alpha-skill', 'codex', 'missing'),
  projection('beta-skill', 'claude', 'linked'),
  projection('beta-skill', 'codex', 'linked'),
];

const snapshot: SkillManagementSnapshot = {
  config: {
    sourceRepoPath: '/fixture/source',
    targets: Object.fromEntries(
      targets.map((entry) => [entry.id, { enabled: true, kind: entry.kind, path: entry.path, scope: entry.scope }]),
    ),
  },
  configured: true,
  diagnostics: [],
  nativeRuleFindings: [],
  projections,
  skills,
  sourceState: {
    skillEnabledByName: { 'alpha-skill': true, 'beta-skill': true },
    version: 1,
  },
  summary: {
    activeSkillCount: 2,
    diagnosticCount: 2,
    healthyProjectionCount: 3,
    skillCount: 2,
    targetCount: 2,
    unhealthyProjectionCount: 1,
    unmanagedEntryCount: 1,
  },
  targets,
  unmanagedEntries: [projection('legacy-local-copy', 'codex', 'unmanaged-copy')],
};

const snapshotCopy = (overrides: Partial<SkillManagementSnapshot> = {}): SkillManagementSnapshot => ({
  ...structuredClone(snapshot),
  ...overrides,
});

const reconciledAction: ProjectionAction = {
  path: '/fixture/targets/codex/alpha-skill',
  skillName: 'alpha-skill',
  sourcePath: '/fixture/source/skills/alpha-skill',
  targetId: 'codex',
  type: 'create-symlink',
};

const reconcileResult = (actions: readonly ProjectionAction[]): SkillsServerResult<SkillReconcileServerResult> => ({
  data: { actions, snapshot: snapshotCopy() },
  ok: true,
});

export const readE2ESkillManagementSnapshot = (): SkillsServerResult<SkillManagementSnapshot> => ({
  data: snapshotCopy(),
  ok: true,
});

export const readE2ERefreshedSkillManagementSnapshot = (): SkillsServerResult<SkillManagementSnapshot> => {
  const remainingSkills = skills.filter((entry) => entry.name !== 'alpha-skill');
  return {
    data: snapshotCopy({
      projections: projections.filter((entry) => entry.skillName !== 'alpha-skill'),
      skills: remainingSkills,
      sourceState: { skillEnabledByName: { 'beta-skill': true }, version: 1 },
      summary: {
        ...snapshot.summary,
        activeSkillCount: remainingSkills.length,
        healthyProjectionCount: 2,
        skillCount: remainingSkills.length,
        unhealthyProjectionCount: 0,
      },
    }),
    ok: true,
  };
};

export const readE2EKnownSkillProjectPaths = (): SkillsServerResult<readonly KnownSkillProjectPath[]> => ({
  data: [
    {
      groupId: 'project/opaque',
      groupLabel: 'Opaque project',
      label: 'opaque-project-source',
      path: '/fixture/projects/opaque-project-source',
      project: 'opaque-project',
      sessions: 1,
    },
    {
      label: 'customer-analytics-platform-with-an-exceptionally-long-scope-name',
      path: '/fixture/projects/customer-analytics-platform-with-an-exceptionally-long-scope-name',
      project: 'customer-analytics-platform',
      sessions: 1,
    },
  ],
  ok: true,
});

export const readE2ESkillProjectInventories = (): SkillsServerResult<readonly ProjectSkillInventory[]> => ({
  data: [
    {
      diagnostics: [],
      observations: [
        {
          description: 'Opaque project skill fixture',
          diagnostics: [],
          invocation: 'auto',
          markdownReadable: true,
          name: 'skill-name',
          path: '/fixture/projects/opaque-project-source/.agents/skills/skill-name',
          placement: 'owned-directory',
          runtimeDirId: 'agents-project',
          skillMdPath: '/fixture/projects/opaque-project-source/.agents/skills/skill-name/SKILL.md',
          tokenCount: { approximate: true, references: 0, skillMd: 4, total: 4 },
          validationStatus: 'valid',
        },
      ],
      projectPath: '/fixture/projects/opaque-project-source',
    },
  ],
  ok: true,
});

export const writeE2ESkillManagementConfig = (
  config: SkillManagementConfig,
): SkillsServerResult<SkillManagementSnapshot> => ({
  data: snapshotCopy({ config: { ...snapshot.config, ...config } }),
  ok: true,
});

export const toggleE2ESkill = (input: SkillToggleInput): SkillsServerResult<SkillReconcileServerResult> => {
  const nextSkills = skills.map((entry) =>
    entry.name === input.skillName ? { ...entry, enabled: input.enabled } : entry,
  );
  return {
    data: {
      actions: [],
      snapshot: snapshotCopy({
        skills: nextSkills,
        sourceState: {
          skillEnabledByName: Object.fromEntries(nextSkills.map((entry) => [entry.name, entry.enabled])),
          version: 1,
        },
      }),
    },
    ok: true,
  };
};

export const reconcileE2ESkill = (_skillName: string): SkillsServerResult<SkillReconcileServerResult> =>
  reconcileResult([reconciledAction]);

export const reconcileAllE2ESkills = (): SkillsServerResult<SkillReconcileServerResult> =>
  reconcileResult([reconciledAction]);

export const previewE2EReconcileAllSkills = (): SkillsServerResult<SkillReconcileServerResult> =>
  reconcileResult([reconciledAction]);

export const createE2ESkillTargetDirectory = (
  input: SkillTargetDirectoryInput,
): SkillsServerResult<SkillManagementSnapshot> => ({
  data: snapshotCopy({
    targets: targets.map((entry) =>
      entry.id === input.targetId ? { ...entry, missing: false, observed: true } : entry,
    ),
  }),
  ok: true,
});

export const readE2EProjectSkillMarkdown = (
  input: ProjectSkillMarkdownInput,
): SkillsServerResult<ProjectSkillMarkdownDocument> => ({
  data: {
    content: `# ${input.skillName}\n\nDeterministic project fixture.\n`,
    path: `${input.projectPath}/.agents/skills/${input.skillName}/SKILL.md`,
    skillName: input.skillName,
    truncated: false,
  },
  ok: true,
});

export const readE2ESkillMarkdown = (skillName: string): SkillsServerResult<SkillMarkdownDocument> => ({
  data: {
    content: `# ${skillName}\n\nDeterministic Playwright fixture.\n`,
    path: `/fixture/source/skills/${skillName}/SKILL.md`,
    sha256: skillName === 'alpha-skill' ? 'a'.repeat(64) : 'b'.repeat(64),
    skillName,
  },
  ok: true,
});

export const writeE2ESkillMarkdown = (input: SkillMarkdownWriteInput): SkillsServerResult<SkillMarkdownSaveResult> => ({
  data: {
    document: {
      content: input.content,
      path: `/fixture/source/skills/${input.skillName}/SKILL.md`,
      sha256: input.baseSha256,
      skillName: input.skillName,
    },
    snapshot: snapshotCopy(),
  },
  ok: true,
});
