import type { SkillObservation } from '@ai-usage/report-core/skill-observation';
import {
  createSkillObservationDataset,
  type SkillObservationDataset,
} from '@ai-usage/report-core/skill-observation-summary';
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
  UnmanagedEntry,
} from '@ai-usage/skills';
import type { SkillObservations } from '@ai-usage/web-contract/skills';
import { joinSkillObservations } from './skill-observation-join';
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

const unmanagedEntry = (entryName: string, targetId: string, state: UnmanagedEntry['state']): UnmanagedEntry => ({
  diagnostics: [],
  entryName,
  expectedPath: `/fixture/targets/${targetId}/${entryName}`,
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
  unmanagedEntries: [unmanagedEntry('legacy-local-copy', 'codex', 'unmanaged-copy')],
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
      label: 'customer-analytics-platform-with-an-exceptionally-long-scope-name',
      path: '/fixture/projects/customer-analytics-platform-with-an-exceptionally-long-scope-name',
      project: 'customer-analytics-platform',
      sessions: 1,
    },
  ],
  ok: true,
});

export const readE2ESkillProjectInventories = (): SkillsServerResult<readonly ProjectSkillInventory[]> => ({
  data: [],
  ok: true,
});

export const readExtendedE2EKnownSkillProjectPaths = (): SkillsServerResult<readonly KnownSkillProjectPath[]> => ({
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
      groupId: 'project/opaque-twin',
      groupLabel: 'Opaque project',
      label: 'opaque-project-source',
      path: '/fixture/work/opaque-project-source',
      project: 'opaque-project-twin',
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

export const readExtendedE2ESkillProjectInventories = (): SkillsServerResult<readonly ProjectSkillInventory[]> => ({
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
    {
      diagnostics: [],
      observations: [
        {
          description: 'Opaque twin project skill fixture',
          diagnostics: [],
          invocation: 'auto',
          markdownReadable: true,
          name: 'twin-skill',
          path: '/fixture/work/opaque-project-source/.agents/skills/twin-skill',
          placement: 'owned-directory',
          runtimeDirId: 'agents-project',
          skillMdPath: '/fixture/work/opaque-project-source/.agents/skills/twin-skill/SKILL.md',
          tokenCount: { approximate: true, references: 0, skillMd: 4, total: 4 },
          validationStatus: 'valid',
        },
      ],
      projectPath: '/fixture/work/opaque-project-source',
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

/**
 * The skill names of the shared synthetic home (`seedHarnessHome({ skillSignals: true })`) that
 * resolve to no managed inventory entry: a Claude Code bundled skill, a Codex skill both offered
 * and read, and a Codex skill offered but never read. Kept in step with that fixture by
 * `skills-e2e-fixture.server.test.ts`, so what the browser renders here is the same vocabulary a
 * real collection over that home produces.
 */
const E2E_UNMANAGED_OBSERVED_SKILLS = {
  claudeBundled: 'artifact-design',
  codexOfferedAndRead: 'pr-review',
  codexOfferedOnly: 'imagegen',
} as const;

/**
 * The project-local skill the project inventory above already carries. Kept out of
 * `E2E_UNMANAGED_OBSERVED_SKILLS`, which is pinned to the names the shared synthetic harness home
 * seeds; this one is a fixture of *this* runtime's project inventory, not of that home.
 */
const E2E_PROJECT_OBSERVED_SKILL = 'skill-name';

const e2eObservation = (
  harnessKey: string,
  tier: SkillObservation['tier'],
  skillName: string,
  ordinal: number,
  resolvedPath: string | null = null,
): SkillObservation => ({
  argsPresent: null,
  harnessKey,
  observationKey: `${harnessKey}-${tier}-${skillName}-${ordinal}`,
  observedAt: new Date(Date.UTC(2026, 7, 1, 9, ordinal)).toISOString(),
  projectPath: '/fixture/projects/alpha',
  resolvedPath,
  sessionId: `${harnessKey}-fixture-session`,
  skillName,
  success: null,
  tier,
});

/**
 * A deterministic observation set covering every reading the surface has to get right:
 * a mixed-tier managed skill, a managed skill nothing observed (deletion candidate), unmanaged
 * skills that were observed (adoption candidates), a skill offered but never read, and Cursor —
 * which contributes nothing because it cannot observe, and must never be drawn as a zero.
 */
const e2eObservations: readonly SkillObservation[] = [
  e2eObservation('claude', 'declared', 'alpha-skill', 1, '/fixture/source/skills/alpha-skill'),
  e2eObservation('claude', 'declared', 'alpha-skill', 2, '/fixture/source/skills/alpha-skill'),
  e2eObservation('claude', 'declared', 'alpha-skill', 3, '/fixture/source/skills/alpha-skill'),
  e2eObservation('opencode', 'declared', 'alpha-skill', 4),
  e2eObservation('codex', 'exposed', 'alpha-skill', 5),
  e2eObservation('codex', 'exposed', 'alpha-skill', 6),
  e2eObservation('codex', 'inferred', 'alpha-skill', 7),
  e2eObservation('claude', 'declared', E2E_UNMANAGED_OBSERVED_SKILLS.claudeBundled, 8),
  e2eObservation('codex', 'exposed', E2E_UNMANAGED_OBSERVED_SKILLS.codexOfferedAndRead, 9),
  e2eObservation('codex', 'inferred', E2E_UNMANAGED_OBSERVED_SKILLS.codexOfferedAndRead, 10),
  e2eObservation('codex', 'exposed', E2E_UNMANAGED_OBSERVED_SKILLS.codexOfferedOnly, 11),
  // A skill that lives in a project's own runtime directory rather than the managed source
  // repository. Deliberately named for the project inventory above, so selecting it in the tree
  // exercises the project-skill detail branch — the branch that shipped with no observations at all
  // because every fixture before this one selected a global skill.
  e2eObservation(
    'opencode',
    'declared',
    E2E_PROJECT_OBSERVED_SKILL,
    12,
    '/fixture/projects/opaque-project-source/.agents/skills/skill-name',
  ),
  e2eObservation('codex', 'inferred', E2E_PROJECT_OBSERVED_SKILL, 13),
];

export const e2eSkillObservationDataset = (): SkillObservationDataset => createSkillObservationDataset(e2eObservations);

/**
 * The fixture runs the real join, so the e2e surface exercises the same verdict rules production
 * does rather than a hand-written answer that could disagree with them.
 */
const e2eJoinedObservations = (): SkillObservations =>
  joinSkillObservations({
    observations: e2eSkillObservationDataset(),
    // The same residence inputs production wires: the snapshot's runtime-directory entries and the
    // scan's project roots, so `skill-name` classifies as project-owned and the bundled ones as
    // external — through the real rules, not a hand-written answer.
    projectPathPrefixes: ['/fixture/projects/opaque-project-source', '/fixture/work/opaque-project-source'],
    projections,
    skills,
    targets,
    unmanagedEntryNames: snapshot.unmanagedEntries.map((entry) => entry.entryName),
  });

export const e2eUnmanagedObservedSkillNames = (): readonly string[] => Object.values(E2E_UNMANAGED_OBSERVED_SKILLS);

export const readE2ESkillObservations = (): SkillsServerResult<SkillObservations> => ({
  data: e2eJoinedObservations(),
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
