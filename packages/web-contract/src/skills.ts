import { isPrintableSkillObservationText, SKILL_OBSERVATION_TIERS } from '@ai-usage/report-core/skill-observation';
import { parseSkillConfigInput } from '@ai-usage/skills/config';
import { skillNamePattern, skillTargetIdPattern } from '@ai-usage/skills/shared';
import { oc } from '@orpc/contract';
import {
  array,
  boolean,
  check,
  custom,
  finite,
  type InferOutput,
  literal,
  maxBytes,
  maxLength,
  minLength,
  minValue,
  nullable,
  number,
  optional,
  picklist,
  pipe,
  rawTransform,
  record,
  regex,
  safeInteger,
  strictObject,
  string,
  transform,
  union,
} from 'valibot';
import { publicErrorDataSchema } from './errors';
import { emptyInputSchema, isJsonWireValue, jsonWireValueSchema } from './schema-conventions';

const MAX_DISCOVERED_ENTRY_NAME_LENGTH = 255;

// One definition of "renderable as text", owned by `report-core` so the producer that filters
// against this rule and the schema that enforces it cannot drift apart.
const isControlFreeText = isPrintableSkillObservationText;

// Path separators and control characters are the only characters that could turn a reported entry
// name into something other than a leaf name.
const isSafeEntryName = (value: string): boolean =>
  isControlFreeText(value) && !(value.includes('/') || value.includes('\\'));
const boundedStringSchema = pipe(string(), maxLength(4096));
const nonNegativeFiniteNumberSchema = pipe(number(), finite(), safeInteger(), minValue(0));
const skillNameSchema = pipe(string(), regex(skillNamePattern));
// A runtime target may hold any directory entry, including names a managed skill could never carry
// (Codex writes its own `.system` directory). A discovered name is reported data, not an identifier,
// so it is bounded to one safe path segment instead of the managed-name pattern. Validating it like a
// managed name lets a single unrecognized entry reject the whole snapshot.
const discoveredEntryNameSchema = pipe(
  string(),
  minLength(1),
  maxLength(MAX_DISCOVERED_ENTRY_NAME_LENGTH),
  check(isSafeEntryName, 'A discovered entry name must be one path segment.'),
  check((value) => value !== '.' && value !== '..', 'A discovered entry name must not be a relative segment.'),
);
const targetIdSchema = pipe(string(), regex(skillTargetIdPattern));
const sha256Schema = pipe(string(), regex(/^[a-f0-9]{64}$/));
const markdownContentSchema = pipe(string(), maxBytes(262_144));
const projectMarkdownContentSchema = pipe(string(), maxBytes(65_536));
const projectPathSchema = pipe(
  string(),
  transform((value) => value.trim()),
  minLength(1),
  maxLength(4096),
);
const textEncoder = new TextEncoder();
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_RECONCILE_BYTES = 10 * 1024 * 1024;
const MAX_COLLECTION_BYTES = 8 * 1024 * 1024;
const MAX_MANAGED_MARKDOWN_DOCUMENT_BYTES = 320 * 1024;
const MAX_PROJECT_MARKDOWN_DOCUMENT_BYTES = 96 * 1024;
const MAX_PATH_CHARACTERS = 4096;
const MAX_COLLECTION_ITEMS = 4096;
const jsonWirePreflightSchema = custom<unknown>(
  isJsonWireValue,
  'Expected a finite, acyclic JSON value without files, streams, dates, class instances, or accessors.',
);

const jsonWithinBytes = (value: unknown, maximumBytes: number): boolean =>
  textEncoder.encode(JSON.stringify(value)).byteLength <= maximumBytes;

const configPathsAreBounded = (config: ReturnType<typeof parseSkillConfigInput>): boolean => {
  const paths = [
    config.projectsRootPath,
    config.sourceRepoPath,
    ...(config.projectPaths ?? []),
    ...Object.values(config.targets ?? {}).map((target) => target.path),
  ];
  return paths.every((path) => path === undefined || path.length <= MAX_PATH_CHARACTERS);
};

const configCollectionsAreBounded = (config: ReturnType<typeof parseSkillConfigInput>): boolean => {
  const connectors = Object.values(config.connectors ?? {});
  return (
    (config.projectPaths?.length ?? 0) <= MAX_COLLECTION_ITEMS &&
    (config.ignoredTargetFindings?.length ?? 0) <= MAX_COLLECTION_ITEMS &&
    Object.keys(config.targets ?? {}).length <= MAX_COLLECTION_ITEMS &&
    connectors.length <= MAX_COLLECTION_ITEMS &&
    connectors.every((connector) => connector.consumesTargets.length <= MAX_COLLECTION_ITEMS)
  );
};

const diagnosticSchema = strictObject({
  code: string(),
  message: string(),
  path: optional(boundedStringSchema),
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

export const skillManagementConfigSchema = pipe(
  jsonWirePreflightSchema,
  rawTransform(({ dataset, addIssue, NEVER }) => {
    try {
      const config = parseSkillConfigInput(dataset.value);
      if (
        !(
          configPathsAreBounded(config) &&
          configCollectionsAreBounded(config) &&
          jsonWithinBytes(config, MAX_CONFIG_BYTES)
        )
      ) {
        throw new Error('Skills config exceeds its public bounds.');
      }
      return config;
    } catch {
      addIssue({ message: 'Expected an exact bounded Skills config.' });
      return NEVER;
    }
  }),
);

const manifestSchema = strictObject({
  description: optional(string()),
  fields: pipe(
    array(
      strictObject({
        key: string(),
        kind: picklist(['standard', 'known-extension', 'unknown-extension']),
        value: jsonWireValueSchema,
      }),
    ),
    maxLength(MAX_COLLECTION_ITEMS),
  ),
  markdown: markdownContentSchema,
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
  diagnostics: pipe(array(diagnosticSchema), maxLength(MAX_COLLECTION_ITEMS)),
  enabled: boolean(),
  manifest: manifestSchema,
  name: skillNameSchema,
  path: boundedStringSchema,
  skillMdPath: boundedStringSchema,
  tokenCount: optional(tokenCountSchema),
  validationStatus: picklist(['valid', 'warning', 'invalid']),
});

const targetIdentitySchema = strictObject({
  canonicalPath: boundedStringSchema,
  dev: string(),
  ino: string(),
});

const projectionBaseShape = {
  actualPath: optional(boundedStringSchema),
  diagnostics: pipe(array(diagnosticSchema), maxLength(MAX_COLLECTION_ITEMS)),
  expectedPath: boundedStringSchema,
  targetId: targetIdSchema,
  targetIdentity: optional(targetIdentitySchema),
};

const projectionSchema = strictObject({
  ...projectionBaseShape,
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
});
const unmanagedEntrySchema = strictObject({
  ...projectionBaseShape,
  entryName: discoveredEntryNameSchema,
  state: picklist(['unmanaged-copy', 'unmanaged-symlink']),
});

const skillManagementSnapshotShapeSchema = strictObject({
  config: skillManagementConfigSchema,
  configured: boolean(),
  diagnostics: pipe(array(diagnosticSchema), maxLength(MAX_COLLECTION_ITEMS)),
  nativeRuleFindings: pipe(array(diagnosticSchema), maxLength(MAX_COLLECTION_ITEMS)),
  projections: pipe(array(projectionSchema), maxLength(MAX_COLLECTION_ITEMS)),
  skills: pipe(array(sourceSkillSchema), maxLength(MAX_COLLECTION_ITEMS)),
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
  targets: pipe(
    array(
      strictObject({
        connectorId: optional(string()),
        enabled: boolean(),
        id: targetIdSchema,
        kind: picklist(['standard-interop', 'native', 'custom']),
        label: string(),
        missing: boolean(),
        observed: boolean(),
        path: boundedStringSchema,
        scope: picklist(['system', 'project']),
      }),
    ),
    maxLength(MAX_COLLECTION_ITEMS),
  ),
  unmanagedEntries: pipe(array(unmanagedEntrySchema), maxLength(MAX_COLLECTION_ITEMS)),
});

export const skillManagementSnapshotSchema = pipe(
  jsonWirePreflightSchema,
  skillManagementSnapshotShapeSchema,
  check((value) => jsonWithinBytes(value, MAX_SNAPSHOT_BYTES), 'Skills snapshot exceeds its byte budget.'),
);

const projectionActionSchema = union([
  strictObject({
    path: boundedStringSchema,
    skillName: skillNameSchema,
    sourcePath: boundedStringSchema,
    targetId: targetIdSchema,
    targetIdentity: optional(targetIdentitySchema),
    type: literal('create-symlink'),
  }),
  strictObject({
    observedSourcePath: boundedStringSchema,
    path: boundedStringSchema,
    skillName: skillNameSchema,
    sourcePath: boundedStringSchema,
    targetId: targetIdSchema,
    targetIdentity: optional(targetIdentitySchema),
    type: picklist(['repair-symlink', 'unlink-managed-symlink']),
  }),
  strictObject({
    path: boundedStringSchema,
    reason: string(),
    skillName: skillNameSchema,
    targetId: targetIdSchema,
    type: picklist(['noop', 'refuse-unmanaged-mutation']),
  }),
]);

const skillReconcileResultShapeSchema = strictObject({
  actions: pipe(array(projectionActionSchema), maxLength(MAX_COLLECTION_ITEMS)),
  snapshot: skillManagementSnapshotSchema,
});

export const skillReconcileResultSchema = pipe(
  jsonWirePreflightSchema,
  skillReconcileResultShapeSchema,
  check((value) => jsonWithinBytes(value, MAX_RECONCILE_BYTES), 'Skills reconcile result exceeds its byte budget.'),
);

const knownSkillProjectPathShapeSchema = strictObject({
  groupId: optional(string()),
  groupLabel: optional(string()),
  label: string(),
  machineLabel: optional(string()),
  path: boundedStringSchema,
  project: string(),
  sessions: nonNegativeFiniteNumberSchema,
});

export const knownSkillProjectPathSchema = pipe(jsonWirePreflightSchema, knownSkillProjectPathShapeSchema);

const MAX_OBSERVED_SKILL_NAME_LENGTH = 512;
const MAX_OBSERVATION_HARNESSES = 32;
// One tally per harness × tier. Four harnesses times three tiers is twelve; the ceiling leaves room
// for a harness this build does not yet know about without ever admitting an unbounded list.
const MAX_OBSERVATION_TALLIES = 64;
const MAX_OBSERVATION_RESOLVED_PATHS = 8;
const MAX_OBSERVATION_BYTES = 2 * 1024 * 1024;

const isStrictIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const observationTimestampSchema = custom<string>(isStrictIsoTimestamp, 'Expected a canonical ISO timestamp.');

/**
 * An observed skill name is reported data with an open vocabulary, not an identifier this product
 * issued. Harness-bundled skills, plugin-provided skills, and skills deleted since the observation
 * all appear here, and none of them need to match the managed-name pattern — validating this like a
 * managed name would reject exactly the population that carries the "invoked but unmanaged" verdict
 * (ADR 0022). Only control characters are refused, because they are the one class that could not be
 * rendered as text.
 */
const observedSkillNameSchema = pipe(
  string(),
  minLength(1),
  maxLength(MAX_OBSERVED_SKILL_NAME_LENGTH),
  check(isControlFreeText, 'An observed skill name must be printable text.'),
);

const harnessKeySchema = pipe(string(), minLength(1), maxLength(MAX_OBSERVED_SKILL_NAME_LENGTH));

/**
 * A count that cannot travel without its tier and its harness. There is deliberately no total here
 * and no per-harness roll-up: summing `declared` and `inferred` is a defect, and the wire shape
 * refuses to offer a field to sum them into.
 */
const skillObservationTallySchema = strictObject({
  count: nonNegativeFiniteNumberSchema,
  harnessKey: harnessKeySchema,
  harnessLabel: pipe(string(), maxLength(MAX_OBSERVED_SKILL_NAME_LENGTH)),
  lastObservedAt: observationTimestampSchema,
  tier: picklist(SKILL_OBSERVATION_TIERS),
});

/**
 * The verdict, decided on the server where the inventory is (decision 3).
 *
 * - `invoked` — a managed skill some harness recorded being used.
 * - `invoked-unmanaged` — used, but resolving to no inventory entry: the adoption candidate.
 * - `offered-only` — the skill was put in front of a model and there is no evidence it was used.
 *   That is a fact about *offering*, not about use, so it can never carry an adoption verdict; the
 *   `exposed` tier is what a catalogue injection looks like, and a catalogue lists everything.
 * - `never-observed` — no harness that can observe recorded anything at all.
 */
export const skillObservationVerdicts = ['invoked', 'invoked-unmanaged', 'offered-only', 'never-observed'] as const;

const observedSkillSchema = strictObject({
  /**
   * Managed *and* projected everywhere *and* never invoked. Computed from the inventory's
   * projections rather than from managed-ness alone: a skill that is not actually installed in
   * every runtime has an unremarkable reason to be unused, and proposing its deletion on that
   * evidence would be wrong.
   */
  deletionCandidate: boolean(),
  lastObservedAt: nullable(observationTimestampSchema),
  /** Whether the name resolves to an entry in the managed inventory. */
  managed: boolean(),
  /** Whether every projection this skill has is healthy, and it has at least one. */
  projectedEverywhere: boolean(),
  // Empty is the unresolved case and is carried, not dropped.
  resolvedPaths: pipe(array(boundedStringSchema), maxLength(MAX_OBSERVATION_RESOLVED_PATHS)),
  /**
   * The skill resolved to more directories than this list carries. Required, not optional: every
   * bound in this family reports itself, and an omitted flag would let a producer ship a short list
   * that reads as complete.
   */
  resolvedPathsTruncated: boolean(),
  skillName: observedSkillNameSchema,
  /** A skill can appear with no tallies: that is the never-observed verdict, not a dropped row. */
  tallies: pipe(array(skillObservationTallySchema), maxLength(MAX_OBSERVATION_TALLIES)),
  /**
   * Where an unmanaged name lives, decided at the join from data the read already carries
   * (runtime-directory unmanaged entries and known project paths). It refines the adoption verdict
   * for presentation — three populations calling for three different treatments — without touching
   * verdict semantics (ADR 0022):
   *
   * - `runtime-installed` — the name has an unmanaged entry in a runtime skills directory. This is
   *   the adoptable backlog: files this product could own.
   * - `project-owned` — a resolved directory sits inside a known project. Deliberately
   *   project-scoped; adopting it would change its ownership, not repair an omission.
   * - `external` — everything else: harness-bundled, plugin-provided, or since deleted.
   *
   * `null` for managed names, whose home is the source repository and needs no classifying.
   */
  unmanagedResidence: nullable(picklist(['runtime-installed', 'project-owned', 'external'])),
  verdict: picklist(skillObservationVerdicts),
  /**
   * The read was bounded or skipped rows, so this verdict rests on an incomplete absence. Set only
   * where absence is what the verdict claims — a positive verdict is not weakened by a short read.
   */
  verdictProvisional: boolean(),
});

/**
 * Harness coverage is enumerated rather than implied. `not-observable` is what keeps a harness with
 * no collector — Cursor today — from being rendered as a harness that observed nothing.
 */
const skillObservationHarnessSchema = strictObject({
  harnessKey: harnessKeySchema,
  label: pipe(string(), minLength(1), maxLength(MAX_OBSERVED_SKILL_NAME_LENGTH)),
  observability: picklist(['observable', 'not-observable']),
});

const skillObservationsShapeSchema = strictObject({
  harnesses: pipe(array(skillObservationHarnessSchema), minLength(1), maxLength(MAX_OBSERVATION_HARNESSES)),
  /**
   * The `declared`/`inferred` read reached its own budget, so invocation evidence is incomplete.
   *
   * Distinct from `lowerBound`, and the distinction is the point. Exposure is written once per
   * catalogue entry per session, so it dwarfs the invocation tiers and a read that truncates it is
   * routine. Only this flag says the evidence behind "never invoked" was itself cut short — which is
   * why it, and not `lowerBound`, is what makes an absence verdict provisional.
   */
  invocationLowerBound: boolean(),
  /** The read stopped at its bound, so every count is a lower bound rather than a number. */
  lowerBound: boolean(),
  /** No observable producer has persisted a completeness answer for this collection yet. */
  producerCompletenessMissing: boolean(),
  skills: pipe(array(observedSkillSchema), maxLength(MAX_COLLECTION_ITEMS)),
  /** Persisted rows the reader could not re-validate. Reported, never folded into a count. */
  skipped: nonNegativeFiniteNumberSchema,
});

export const skillObservationsSchema = pipe(
  jsonWirePreflightSchema,
  skillObservationsShapeSchema,
  check((value) => jsonWithinBytes(value, MAX_OBSERVATION_BYTES), 'Skill observations exceed their byte budget.'),
);

/**
 * The response caps, published so the server can clamp *to* them instead of assembling a response
 * this schema will reject. A store may legitimately hold more skills or more bytes than one
 * response carries; the producer's job is to bound and say so, not to fail.
 *
 * Every cap the assembled response can grow past is published, not only the ones the read applies:
 * the read is clamped before the inventory join, and the join adds rows, harness keys, and fields.
 * A cap that only the pre-join read knows about is a cap the final payload can still exceed.
 */
export const MAX_SKILL_OBSERVATION_SKILLS = MAX_COLLECTION_ITEMS;
export const MAX_SKILL_OBSERVATIONS_RESPONSE_BYTES = MAX_OBSERVATION_BYTES;
export const MAX_SKILL_OBSERVATION_HARNESS_ROSTER = MAX_OBSERVATION_HARNESSES;
export const MAX_SKILL_OBSERVATION_SKILL_TALLIES = MAX_OBSERVATION_TALLIES;
export const MAX_SKILL_OBSERVATION_SKILL_RESOLVED_PATHS = MAX_OBSERVATION_RESOLVED_PATHS;

const projectSkillObservationSchema = strictObject({
  description: string(),
  diagnostics: pipe(array(diagnosticSchema), maxLength(MAX_COLLECTION_ITEMS)),
  invocation: picklist(['auto', 'manual']),
  markdownReadable: boolean(),
  name: skillNameSchema,
  path: boundedStringSchema,
  placement: picklist(['owned-directory', 'symlink-to-source', 'project-symlink', 'external-symlink']),
  runtimeDirId: picklist(['claude-project', 'agents-project']),
  skillMdPath: boundedStringSchema,
  tokenCount: optional(tokenCountSchema),
  validationStatus: picklist(['valid', 'warning', 'invalid']),
});

const projectSkillInventoryShapeSchema = strictObject({
  diagnostics: pipe(array(diagnosticSchema), maxLength(MAX_COLLECTION_ITEMS)),
  observations: pipe(array(projectSkillObservationSchema), maxLength(MAX_COLLECTION_ITEMS)),
  projectPath: boundedStringSchema,
});

export const projectSkillInventorySchema = pipe(jsonWirePreflightSchema, projectSkillInventoryShapeSchema);

const skillMarkdownDocumentShapeSchema = strictObject({
  content: markdownContentSchema,
  path: boundedStringSchema,
  sha256: sha256Schema,
  skillName: skillNameSchema,
});

const projectSkillMarkdownDocumentShapeSchema = strictObject({
  content: projectMarkdownContentSchema,
  path: boundedStringSchema,
  skillName: skillNameSchema,
  truncated: boolean(),
});

export const skillMarkdownDocumentSchema = pipe(
  jsonWirePreflightSchema,
  skillMarkdownDocumentShapeSchema,
  check(
    (value) => jsonWithinBytes(value, MAX_MANAGED_MARKDOWN_DOCUMENT_BYTES),
    'Managed Skills markdown document exceeds its byte budget.',
  ),
);
export const projectSkillMarkdownDocumentSchema = pipe(
  jsonWirePreflightSchema,
  projectSkillMarkdownDocumentShapeSchema,
  check(
    (value) => jsonWithinBytes(value, MAX_PROJECT_MARKDOWN_DOCUMENT_BYTES),
    'Project Skills markdown document exceeds its byte budget.',
  ),
);

export const skillMarkdownSaveResultSchema = pipe(
  jsonWirePreflightSchema,
  union([
    strictObject({ reason: picklist(['conflict', 'not-found', 'too-large']) }),
    strictObject({
      document: skillMarkdownDocumentSchema,
      snapshot: skillManagementSnapshotSchema,
    }),
  ]),
  check(
    (value) => jsonWithinBytes(value, MAX_RECONCILE_BYTES),
    'Managed Skills markdown save result exceeds its byte budget.',
  ),
);

export const saveSkillMarkdownInputSchema = pipe(
  jsonWirePreflightSchema,
  strictObject({
    baseSha256: sha256Schema,
    content: markdownContentSchema,
    skillName: skillNameSchema,
  }),
  check(
    (value) => jsonWithinBytes(value, MAX_MANAGED_MARKDOWN_DOCUMENT_BYTES),
    'Managed Skills markdown input exceeds its byte budget.',
  ),
);

export const projectSkillMarkdownInputSchema = pipe(
  jsonWirePreflightSchema,
  strictObject({
    projectPath: projectPathSchema,
    runtimeDirId: picklist(['claude-project', 'agents-project']),
    skillName: skillNameSchema,
  }),
);

export const skillToggleInputSchema = pipe(
  jsonWirePreflightSchema,
  strictObject({
    enabled: boolean(),
    skillName: skillNameSchema,
  }),
);

export const skillNameInputSchema = pipe(jsonWirePreflightSchema, strictObject({ skillName: skillNameSchema }));
export const skillTargetInputSchema = pipe(jsonWirePreflightSchema, strictObject({ targetId: targetIdSchema }));

export const knownSkillProjectPathsSchema = pipe(
  jsonWirePreflightSchema,
  array(knownSkillProjectPathSchema),
  maxLength(MAX_COLLECTION_ITEMS),
  check(
    (value) => jsonWithinBytes(value, MAX_COLLECTION_BYTES),
    'Known Skills project paths exceed their byte budget.',
  ),
);

export const projectSkillInventoriesSchema = pipe(
  jsonWirePreflightSchema,
  array(projectSkillInventorySchema),
  maxLength(MAX_COLLECTION_ITEMS),
  check(
    (value) => jsonWithinBytes(value, MAX_COLLECTION_BYTES),
    'Project Skills inventories exceed their byte budget.',
  ),
);

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
    .output(projectSkillInventoriesSchema),
  knownProjectPaths: skills
    .route({ method: 'GET', path: '/skills/known-paths' })
    .input(emptyInputSchema)
    .output(knownSkillProjectPathsSchema),
  observations: skills
    .route({ method: 'GET', path: '/skills/observations' })
    .input(emptyInputSchema)
    .output(skillObservationsSchema),
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
  observations: 'query',
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
export type SkillObservations = InferOutput<typeof skillObservationsSchema>;
export type ObservedSkill = InferOutput<typeof observedSkillSchema>;
export type SkillObservationTally = InferOutput<typeof skillObservationTallySchema>;
export type SkillObservationHarness = InferOutput<typeof skillObservationHarnessSchema>;
export type SkillObservationVerdict = (typeof skillObservationVerdicts)[number];
export type SkillUnmanagedResidence = NonNullable<ObservedSkill['unmanagedResidence']>;
/**
 * Re-exported so browser code never has to reach past the contract for the tier vocabulary
 * (ADR 0010/0012). The values themselves are owned by `report-core`.
 */
export { SKILL_OBSERVATION_TIERS } from '@ai-usage/report-core/skill-observation';
export type SkillObservationTier = (typeof SKILL_OBSERVATION_TIERS)[number];
export type SkillReconcileResult = InferOutput<typeof skillReconcileResultSchema>;
export type SkillTargetInput = InferOutput<typeof skillTargetInputSchema>;
export type SkillToggleInput = InferOutput<typeof skillToggleInputSchema>;
