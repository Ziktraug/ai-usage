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
 * The already-joined observation payload, as the server produces it: one skill of each verdict, and
 * Cursor enumerated as unable to observe. Written out rather than derived so the fixture states
 * exactly what the surface is being asked to render — the verdict rules themselves are tested
 * against `joinSkillObservations` directly.
 */
export const syntheticObservations: SkillObservations = {
  harnesses: [
    { harnessKey: 'claude', label: 'Claude Code', observability: 'observable' },
    { harnessKey: 'codex', label: 'Codex', observability: 'observable' },
    { harnessKey: 'opencode', label: 'OpenCode', observability: 'observable' },
    { harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' },
  ],
  invocationLowerBound: false,
  lowerBound: false,
  skills: [
    {
      deletionCandidate: false,
      lastObservedAt: '2026-08-02T09:00:00.000Z',
      managed: true,
      projectedEverywhere: true,
      resolvedPaths: ['/synthetic/source/skills/alpha-skill'],
      resolvedPathsTruncated: false,
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
      verdict: 'invoked',
      verdictProvisional: false,
    },
    {
      // Installed everywhere and still never invoked: the deletion candidate.
      deletionCandidate: true,
      lastObservedAt: null,
      managed: true,
      projectedEverywhere: true,
      resolvedPaths: [],
      resolvedPathsTruncated: false,
      skillName: 'beta-skill',
      tallies: [],
      verdict: 'never-observed',
      verdictProvisional: false,
    },
    {
      // Invoked, resolving to no inventory entry: the adoption candidate.
      deletionCandidate: false,
      lastObservedAt: '2026-08-01T10:00:00.000Z',
      managed: false,
      projectedEverywhere: false,
      resolvedPaths: [],
      resolvedPathsTruncated: false,
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
      verdict: 'invoked-unmanaged',
      verdictProvisional: false,
    },
    {
      // Offered to a model and never used. Real signal, but about offering, not use.
      deletionCandidate: false,
      lastObservedAt: '2026-08-01T11:00:00.000Z',
      managed: false,
      projectedEverywhere: false,
      resolvedPaths: [],
      resolvedPathsTruncated: false,
      skillName: 'imagegen',
      tallies: [
        {
          count: 1,
          harnessKey: 'codex',
          harnessLabel: 'Codex',
          lastObservedAt: '2026-08-01T11:00:00.000Z',
          tier: 'exposed',
        },
      ],
      verdict: 'offered-only',
      verdictProvisional: false,
    },
    {
      // A project-local skill, observed. It lives in a project's own runtime directory rather than
      // the managed source repository, so it is unmanaged by construction — and on a real machine
      // this is the *majority* population, not an edge case. Every fixture used to hold global
      // skills only, which is precisely why the project-skill detail surface shipped with no
      // observations at all and no test noticed.
      deletionCandidate: false,
      lastObservedAt: '2026-08-03T12:00:00.000Z',
      managed: false,
      projectedEverywhere: false,
      resolvedPaths: ['/synthetic/project/.agents/skills/project-review'],
      resolvedPathsTruncated: false,
      skillName: 'project-review',
      tallies: [
        {
          count: 4,
          harnessKey: 'codex',
          harnessLabel: 'Codex',
          lastObservedAt: '2026-08-03T12:00:00.000Z',
          tier: 'inferred',
        },
        {
          count: 2,
          harnessKey: 'opencode',
          harnessLabel: 'OpenCode',
          lastObservedAt: '2026-08-02T12:00:00.000Z',
          tier: 'declared',
        },
      ],
      verdict: 'invoked-unmanaged',
      verdictProvisional: false,
    },
  ],
  skipped: 0,
};

/** The same payload from a read that could not prove absence: every absence claim is provisional. */
/**
 * A read whose *invocation* evidence was cut short — the only kind that makes an absence claim
 * provisional. Exposure truncation alone leaves the verdicts intact and is covered separately by
 * `syntheticExposureTruncatedObservations`.
 */
export const syntheticProvisionalObservations: SkillObservations = {
  ...syntheticObservations,
  invocationLowerBound: true,
  lowerBound: true,
  skills: syntheticObservations.skills.map((skill) => ({
    ...skill,
    verdictProvisional: !skill.tallies.some((tally) => tally.tier === 'declared' || tally.tier === 'inferred'),
  })),
};

/**
 * The ordinary state of a store with real Codex history: the exposure catalogue outran the read
 * budget, every recorded invocation is present, and no verdict is weakened. The counts are floors;
 * the verdicts are not provisional.
 */
export const syntheticExposureTruncatedObservations: SkillObservations = {
  ...syntheticObservations,
  invocationLowerBound: false,
  lowerBound: true,
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
      {
        // A project-local install whose name is *also* a managed skill — the operator's real
        // `pr-review` shape. Observations aggregate by name, so this install and the managed one
        // share one set of counts, and the managed-derived verdict belongs to the other install.
        // No fixture had this collision, which is exactly why the misattribution shipped.
        description: 'A project copy of a name that is also managed',
        diagnostics: [],
        invocation: 'auto',
        markdownReadable: true,
        name: 'alpha-skill',
        path: '/synthetic/project/.agents/skills/alpha-skill',
        placement: 'owned-directory',
        runtimeDirId: 'agents-project',
        skillMdPath: '/synthetic/project/.agents/skills/alpha-skill/SKILL.md',
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
