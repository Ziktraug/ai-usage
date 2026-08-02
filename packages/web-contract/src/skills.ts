import { skillNamePattern, skillTargetIdPattern } from '@ai-usage/skills/shared';
import { oc } from '@orpc/contract';
import {
  array,
  boolean,
  finite,
  type InferOutput,
  literal,
  maxBytes,
  minLength,
  minValue,
  number,
  optional,
  picklist,
  pipe,
  record,
  regex,
  safeInteger,
  strictObject,
  string,
  transform,
  union,
} from 'valibot';
import { publicErrorDataSchema } from './errors';
import { emptyInputSchema, jsonWireValueSchema } from './schema-conventions';

const nonEmptyStringSchema = pipe(string(), minLength(1));
const nonNegativeFiniteNumberSchema = pipe(number(), finite(), safeInteger(), minValue(0));
const positiveFiniteNumberSchema = pipe(number(), finite(), minValue(Number.MIN_VALUE));
const skillNameSchema = pipe(string(), regex(skillNamePattern));
const targetIdSchema = pipe(string(), regex(skillTargetIdPattern));
const sha256Schema = pipe(string(), regex(/^[a-f0-9]{64}$/));
const markdownContentSchema = pipe(string(), maxBytes(262_144));
const projectPathSchema = pipe(
  string(),
  transform((value) => value.trim()),
  minLength(1),
);

const diagnosticSchema = strictObject({
  code: string(),
  message: string(),
  path: optional(string()),
  severity: picklist(['info', 'warning', 'error']),
  skillName: optional(skillNameSchema),
  targetId: optional(targetIdSchema),
  tokenMeasurement: optional(
    strictObject({
      observed: nonNegativeFiniteNumberSchema,
      threshold: nonNegativeFiniteNumberSchema,
      unit: literal('tokens'),
    }),
  ),
});

const tokenThresholdSchema = strictObject({
  high: positiveFiniteNumberSchema,
  warn: positiveFiniteNumberSchema,
});

export const skillManagementConfigSchema = strictObject({
  connectors: optional(
    record(
      nonEmptyStringSchema,
      strictObject({
        consumesTargets: array(targetIdSchema),
        enabled: boolean(),
      }),
    ),
  ),
  ignoredTargetFindings: optional(array(nonEmptyStringSchema)),
  projectPaths: optional(array(nonEmptyStringSchema)),
  projectsRootPath: optional(nonEmptyStringSchema),
  sourceRepoPath: optional(nonEmptyStringSchema),
  targets: optional(
    record(
      targetIdSchema,
      strictObject({
        enabled: boolean(),
        kind: picklist(['standard-interop', 'native', 'custom']),
        path: nonEmptyStringSchema,
        scope: picklist(['system', 'project']),
      }),
    ),
  ),
  tokenThresholds: optional(
    strictObject({
      referenceFile: tokenThresholdSchema,
      skillMd: tokenThresholdSchema,
      totalSkill: tokenThresholdSchema,
    }),
  ),
});

const manifestSchema = strictObject({
  description: optional(string()),
  fields: array(
    strictObject({
      key: string(),
      kind: picklist(['standard', 'known-extension', 'unknown-extension']),
      value: jsonWireValueSchema,
    }),
  ),
  markdown: string(),
  name: optional(string()),
});

const tokenCountSchema = strictObject({
  approximate: literal(true),
  references: nonNegativeFiniteNumberSchema,
  skillMd: nonNegativeFiniteNumberSchema,
  total: nonNegativeFiniteNumberSchema,
});

const sourceSkillSchema = strictObject({
  description: string(),
  diagnostics: array(diagnosticSchema),
  enabled: boolean(),
  manifest: manifestSchema,
  name: skillNameSchema,
  path: string(),
  skillMdPath: string(),
  tokenCount: optional(tokenCountSchema),
  validationStatus: picklist(['valid', 'warning', 'invalid']),
});

const targetIdentitySchema = strictObject({
  canonicalPath: string(),
  dev: string(),
  ino: string(),
});

const projectionSchema = strictObject({
  actualPath: optional(string()),
  diagnostics: array(diagnosticSchema),
  expectedPath: string(),
  skillName: skillNameSchema,
  state: picklist([
    'linked',
    'missing',
    'broken-link',
    'wrong-target',
    'unmanaged-copy',
    'unmanaged-symlink',
    'duplicate-same-content',
    'duplicate-name-conflict',
    'disabled-exposed',
    'missing-target',
  ]),
  targetId: targetIdSchema,
  targetIdentity: optional(targetIdentitySchema),
});

export const skillManagementSnapshotSchema = strictObject({
  config: skillManagementConfigSchema,
  configured: boolean(),
  diagnostics: array(diagnosticSchema),
  nativeRuleFindings: array(diagnosticSchema),
  projections: array(projectionSchema),
  skills: array(sourceSkillSchema),
  sourceState: strictObject({
    skillEnabledByName: record(skillNameSchema, boolean()),
    skillOriginByName: optional(record(skillNameSchema, string())),
    version: literal(1),
  }),
  summary: strictObject({
    activeSkillCount: nonNegativeFiniteNumberSchema,
    diagnosticCount: nonNegativeFiniteNumberSchema,
    healthyProjectionCount: nonNegativeFiniteNumberSchema,
    skillCount: nonNegativeFiniteNumberSchema,
    targetCount: nonNegativeFiniteNumberSchema,
    unhealthyProjectionCount: nonNegativeFiniteNumberSchema,
    unmanagedEntryCount: nonNegativeFiniteNumberSchema,
  }),
  targets: array(
    strictObject({
      connectorId: optional(string()),
      enabled: boolean(),
      id: targetIdSchema,
      kind: picklist(['standard-interop', 'native', 'custom']),
      label: string(),
      missing: boolean(),
      observed: boolean(),
      path: string(),
      scope: picklist(['system', 'project']),
    }),
  ),
  unmanagedEntries: array(projectionSchema),
});

const projectionActionSchema = union([
  strictObject({
    path: string(),
    skillName: skillNameSchema,
    sourcePath: string(),
    targetId: targetIdSchema,
    targetIdentity: optional(targetIdentitySchema),
    type: literal('create-symlink'),
  }),
  strictObject({
    observedSourcePath: string(),
    path: string(),
    skillName: skillNameSchema,
    sourcePath: string(),
    targetId: targetIdSchema,
    targetIdentity: optional(targetIdentitySchema),
    type: picklist(['repair-symlink', 'unlink-managed-symlink']),
  }),
  strictObject({
    path: string(),
    reason: string(),
    skillName: skillNameSchema,
    targetId: targetIdSchema,
    type: picklist(['noop', 'refuse-unmanaged-mutation']),
  }),
]);

export const skillReconcileResultSchema = strictObject({
  actions: array(projectionActionSchema),
  snapshot: skillManagementSnapshotSchema,
});

export const knownSkillProjectPathSchema = strictObject({
  groupId: optional(string()),
  groupLabel: optional(string()),
  label: string(),
  machineLabel: optional(string()),
  path: string(),
  project: string(),
  sessions: nonNegativeFiniteNumberSchema,
});

const projectSkillObservationSchema = strictObject({
  description: string(),
  diagnostics: array(diagnosticSchema),
  invocation: picklist(['auto', 'manual']),
  markdownReadable: boolean(),
  name: skillNameSchema,
  path: string(),
  placement: picklist(['owned-directory', 'symlink-to-source', 'project-symlink', 'external-symlink']),
  runtimeDirId: picklist(['claude-project', 'agents-project']),
  skillMdPath: string(),
  tokenCount: optional(tokenCountSchema),
  validationStatus: picklist(['valid', 'warning', 'invalid']),
});

export const projectSkillInventorySchema = strictObject({
  diagnostics: array(diagnosticSchema),
  observations: array(projectSkillObservationSchema),
  projectPath: string(),
});

export const skillMarkdownDocumentSchema = strictObject({
  content: string(),
  path: string(),
  sha256: sha256Schema,
  skillName: skillNameSchema,
});

export const projectSkillMarkdownDocumentSchema = strictObject({
  content: string(),
  path: string(),
  skillName: skillNameSchema,
  truncated: boolean(),
});

export const skillMarkdownSaveResultSchema = union([
  strictObject({ reason: picklist(['conflict', 'not-found', 'too-large']) }),
  strictObject({
    document: skillMarkdownDocumentSchema,
    snapshot: skillManagementSnapshotSchema,
  }),
]);

export const saveSkillMarkdownInputSchema = strictObject({
  baseSha256: sha256Schema,
  content: markdownContentSchema,
  skillName: skillNameSchema,
});

export const projectSkillMarkdownInputSchema = strictObject({
  projectPath: projectPathSchema,
  runtimeDirId: picklist(['claude-project', 'agents-project']),
  skillName: skillNameSchema,
});

export const skillToggleInputSchema = strictObject({
  enabled: boolean(),
  skillName: skillNameSchema,
});

export const skillNameInputSchema = strictObject({ skillName: skillNameSchema });
export const skillTargetInputSchema = strictObject({ targetId: targetIdSchema });

export const skillsErrorMap = {
  ForbiddenDemo: {
    data: publicErrorDataSchema,
    message: 'Skills are unavailable in demo mode.',
    status: 403,
  },
  InvalidInput: {
    data: publicErrorDataSchema,
    message: 'The Skills request is invalid.',
    status: 400,
  },
  SkillsConflict: {
    data: publicErrorDataSchema,
    message: 'Skills state changed. Refresh and try again.',
    status: 409,
  },
  Unavailable: {
    data: publicErrorDataSchema,
    message: 'Skills are unavailable.',
    status: 503,
  },
} as const;

const skills = oc.errors(skillsErrorMap);

export const skillsContract = {
  createTargetDirectory: skills
    .route({ method: 'POST', path: '/skills/targets' })
    .input(skillTargetInputSchema)
    .output(skillManagementSnapshotSchema),
  projectInventories: skills
    .route({ method: 'GET', path: '/skills/inventories' })
    .input(emptyInputSchema)
    .output(array(projectSkillInventorySchema)),
  knownProjectPaths: skills
    .route({ method: 'GET', path: '/skills/known-paths' })
    .input(emptyInputSchema)
    .output(array(knownSkillProjectPathSchema)),
  managedMarkdown: skills
    .route({ method: 'POST', path: '/skills/markdown/read' })
    .input(skillNameInputSchema)
    .output(skillMarkdownDocumentSchema),
  previewReconcileAll: skills
    .route({ method: 'GET', path: '/skills/reconcile/preview' })
    .input(emptyInputSchema)
    .output(skillReconcileResultSchema),
  projectMarkdown: skills
    .route({ method: 'GET', path: '/skills/project-markdown' })
    .input(projectSkillMarkdownInputSchema)
    .output(projectSkillMarkdownDocumentSchema),
  reconcileAll: skills
    .route({ method: 'POST', path: '/skills/reconcile' })
    .input(emptyInputSchema)
    .output(skillReconcileResultSchema),
  reconcileOne: skills
    .route({ method: 'POST', path: '/skills/reconcile/:skillName' })
    .input(skillNameInputSchema)
    .output(skillReconcileResultSchema),
  refreshSnapshot: skills
    .route({ method: 'POST', path: '/skills/refresh' })
    .input(emptyInputSchema)
    .output(skillManagementSnapshotSchema),
  saveConfig: skills
    .route({ method: 'POST', path: '/skills/config' })
    .input(skillManagementConfigSchema)
    .output(skillManagementSnapshotSchema),
  saveManagedMarkdown: skills
    .route({ method: 'POST', path: '/skills/markdown' })
    .input(saveSkillMarkdownInputSchema)
    .output(skillMarkdownSaveResultSchema),
  snapshot: skills
    .route({ method: 'GET', path: '/skills' })
    .input(emptyInputSchema)
    .output(skillManagementSnapshotSchema),
  toggleProjection: skills
    .route({ method: 'POST', path: '/skills/toggle' })
    .input(skillToggleInputSchema)
    .output(skillReconcileResultSchema),
};

export const skillsProcedureIntents = {
  createTargetDirectory: 'mutation',
  projectInventories: 'query',
  knownProjectPaths: 'query',
  managedMarkdown: 'query',
  previewReconcileAll: 'query',
  projectMarkdown: 'query',
  reconcileAll: 'mutation',
  reconcileOne: 'mutation',
  refreshSnapshot: 'mutation',
  saveConfig: 'mutation',
  saveManagedMarkdown: 'mutation',
  snapshot: 'query',
  toggleProjection: 'mutation',
} as const;

export type KnownSkillProjectPath = InferOutput<typeof knownSkillProjectPathSchema>;
export type ProjectSkillInventory = InferOutput<typeof projectSkillInventorySchema>;
export type ProjectSkillMarkdownDocument = InferOutput<typeof projectSkillMarkdownDocumentSchema>;
export type ProjectSkillMarkdownInput = InferOutput<typeof projectSkillMarkdownInputSchema>;
export type SaveSkillMarkdownInput = InferOutput<typeof saveSkillMarkdownInputSchema>;
export type SkillManagementConfig = InferOutput<typeof skillManagementConfigSchema>;
export type SkillManagementSnapshot = InferOutput<typeof skillManagementSnapshotSchema>;
export type SkillMarkdownDocument = InferOutput<typeof skillMarkdownDocumentSchema>;
export type SkillMarkdownSaveResult = InferOutput<typeof skillMarkdownSaveResultSchema>;
export type SkillNameInput = InferOutput<typeof skillNameInputSchema>;
export type SkillReconcileResult = InferOutput<typeof skillReconcileResultSchema>;
export type SkillTargetInput = InferOutput<typeof skillTargetInputSchema>;
export type SkillToggleInput = InferOutput<typeof skillToggleInputSchema>;
