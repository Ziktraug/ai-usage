import type {
  JsonValue,
  Projection,
  ProjectionAction,
  ProjectionState,
  ProjectionTargetIdentity,
  ProjectSkillInventory,
  ProjectSkillObservation,
  ProjectSkillPlacement,
  SkillDiagnostic,
  SkillDiagnosticSeverity,
  SkillFrontmatterField,
  SkillFrontmatterFieldKind,
  SkillManagementSnapshot,
  SkillManagementSnapshotSummary,
  SkillManifest,
  SkillSourceState,
  SkillTarget,
  SkillTargetKind,
  SkillTargetScope,
  SkillValidationStatus,
  SourceSkill,
} from '@ai-usage/skills';
import { parseSkillConfigInput } from '@ai-usage/skills/config';
import type { KnownSkillProjectPath } from './server/skills-contracts';

export type SkillSnapshotResult =
  | { ok: true; data: SkillManagementSnapshot }
  | { ok: false; error: { message: string; tag: string } };

export type KnownProjectPathsResult =
  | { ok: true; data: readonly KnownSkillProjectPath[] }
  | { ok: false; error: { message: string; tag: string } };

export interface SkillReconcileResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

export type SkillReconcileServerResult =
  | { ok: true; data: SkillReconcileResult }
  | { ok: false; error: { message: string; tag: string } };

export type ProjectInventoriesResult =
  | { ok: true; data: readonly ProjectSkillInventory[] }
  | { ok: false; error: { message: string; tag: string } };

const invalidResult = (label: string): never => {
  throw new Error(`Invalid ${label} response`);
};

const recordValue = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidResult(label);
  }
  return Object.fromEntries(Object.entries(value));
};

const stringValue = (value: unknown, label: string): string =>
  typeof value === 'string' ? value : invalidResult(label);

const booleanValue = (value: unknown, label: string): boolean =>
  typeof value === 'boolean' ? value : invalidResult(label);

const nonNegativeInteger = (value: unknown, label: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalidResult(label);

const isAllowedLiteral = <Value extends string>(value: unknown, allowed: readonly Value[]): value is Value =>
  typeof value === 'string' && allowed.some((candidate) => candidate === value);

const literalValue = <Value extends string>(value: unknown, label: string, allowed: readonly Value[]): Value =>
  isAllowedLiteral(value, allowed) ? value : invalidResult(label);

const diagnosticSeverities = ['info', 'warning', 'error'] as const satisfies readonly SkillDiagnosticSeverity[];
const validationStatuses = ['valid', 'warning', 'invalid'] as const satisfies readonly SkillValidationStatus[];
const frontmatterFieldKinds = [
  'standard',
  'known-extension',
  'unknown-extension',
] as const satisfies readonly SkillFrontmatterFieldKind[];
const targetKinds = ['standard-interop', 'native', 'custom'] as const satisfies readonly SkillTargetKind[];
const targetScopes = ['system', 'project'] as const satisfies readonly SkillTargetScope[];
const projectionStates = [
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
] as const satisfies readonly ProjectionState[];
const projectSkillPlacements = [
  'owned-directory',
  'symlink-to-source',
  'project-symlink',
  'external-symlink',
] as const satisfies readonly ProjectSkillPlacement[];
const projectRuntimeIds = [
  'claude-project',
  'agents-project',
] as const satisfies readonly ProjectSkillObservation['runtimeDirId'][];

const diagnosticSeverity = (value: unknown, label: string): SkillDiagnosticSeverity =>
  literalValue(value, label, diagnosticSeverities);

const validationStatus = (value: unknown, label: string): SkillValidationStatus =>
  literalValue(value, label, validationStatuses);

const frontmatterFieldKind = (value: unknown, label: string): SkillFrontmatterFieldKind =>
  literalValue(value, label, frontmatterFieldKinds);

const targetKind = (value: unknown, label: string): SkillTargetKind => literalValue(value, label, targetKinds);

const targetScope = (value: unknown, label: string): SkillTargetScope => literalValue(value, label, targetScopes);

const projectionState = (value: unknown, label: string): ProjectionState =>
  literalValue(value, label, projectionStates);

const projectSkillPlacement = (value: unknown, label: string): ProjectSkillPlacement =>
  literalValue(value, label, projectSkillPlacements);

const projectRuntimeId = (value: unknown, label: string): ProjectSkillObservation['runtimeDirId'] =>
  literalValue(value, label, projectRuntimeIds);

const arrayValue = <T>(value: unknown, label: string, parse: (entry: unknown) => T): readonly T[] => {
  if (!Array.isArray(value)) {
    return invalidResult(label);
  }
  return value.map(parse);
};

const parseJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(parseJsonValue);
  }
  const record = recordValue(value, 'JSON value');
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, parseJsonValue(entry)]));
};

const parseDiagnostic = (value: unknown): SkillDiagnostic => {
  const diagnostic = recordValue(value, 'skill diagnostic');
  return {
    code: stringValue(diagnostic.code, 'skill diagnostic'),
    message: stringValue(diagnostic.message, 'skill diagnostic'),
    severity: diagnosticSeverity(diagnostic.severity, 'skill diagnostic'),
    ...(diagnostic.path === undefined ? {} : { path: stringValue(diagnostic.path, 'skill diagnostic') }),
    ...(diagnostic.skillName === undefined ? {} : { skillName: stringValue(diagnostic.skillName, 'skill diagnostic') }),
    ...(diagnostic.targetId === undefined ? {} : { targetId: stringValue(diagnostic.targetId, 'skill diagnostic') }),
  };
};

const parseTokenCount = (value: unknown): NonNullable<SourceSkill['tokenCount']> => {
  const count = recordValue(value, 'skill token count');
  if (count.approximate !== true) {
    return invalidResult('skill token count');
  }
  return {
    approximate: true,
    references: nonNegativeInteger(count.references, 'skill token count'),
    skillMd: nonNegativeInteger(count.skillMd, 'skill token count'),
    total: nonNegativeInteger(count.total, 'skill token count'),
  };
};

const parseFrontmatterField = (value: unknown): SkillFrontmatterField => {
  const field = recordValue(value, 'skill frontmatter field');
  return {
    key: stringValue(field.key, 'skill frontmatter field'),
    kind: frontmatterFieldKind(field.kind, 'skill frontmatter field'),
    value: parseJsonValue(field.value),
  };
};

const parseManifest = (value: unknown): SkillManifest => {
  const manifest = recordValue(value, 'skill manifest');
  return {
    fields: arrayValue(manifest.fields, 'skill manifest', parseFrontmatterField),
    markdown: stringValue(manifest.markdown, 'skill manifest'),
    ...(manifest.description === undefined ? {} : { description: stringValue(manifest.description, 'skill manifest') }),
    ...(manifest.name === undefined ? {} : { name: stringValue(manifest.name, 'skill manifest') }),
  };
};

const parseSourceSkill = (value: unknown): SourceSkill => {
  const skill = recordValue(value, 'source skill');
  return {
    description: stringValue(skill.description, 'source skill'),
    diagnostics: arrayValue(skill.diagnostics, 'source skill', parseDiagnostic),
    enabled: booleanValue(skill.enabled, 'source skill'),
    manifest: parseManifest(skill.manifest),
    name: stringValue(skill.name, 'source skill'),
    path: stringValue(skill.path, 'source skill'),
    skillMdPath: stringValue(skill.skillMdPath, 'source skill'),
    validationStatus: validationStatus(skill.validationStatus, 'source skill'),
    ...(skill.tokenCount === undefined ? {} : { tokenCount: parseTokenCount(skill.tokenCount) }),
  };
};

const parseTarget = (value: unknown): SkillTarget => {
  const target = recordValue(value, 'skill target');
  return {
    enabled: booleanValue(target.enabled, 'skill target'),
    id: stringValue(target.id, 'skill target'),
    kind: targetKind(target.kind, 'skill target'),
    label: stringValue(target.label, 'skill target'),
    missing: booleanValue(target.missing, 'skill target'),
    observed: booleanValue(target.observed, 'skill target'),
    path: stringValue(target.path, 'skill target'),
    scope: targetScope(target.scope, 'skill target'),
    ...(target.connectorId === undefined ? {} : { connectorId: stringValue(target.connectorId, 'skill target') }),
  };
};

const parseProjectionTargetIdentity = (value: unknown): ProjectionTargetIdentity => {
  const identity = recordValue(value, 'target identity');
  return {
    canonicalPath: stringValue(identity.canonicalPath, 'target identity'),
    dev: stringValue(identity.dev, 'target identity'),
    ino: stringValue(identity.ino, 'target identity'),
  };
};

const parseProjection = (value: unknown): Projection => {
  const projection = recordValue(value, 'skill projection');
  return {
    diagnostics: arrayValue(projection.diagnostics, 'skill projection', parseDiagnostic),
    expectedPath: stringValue(projection.expectedPath, 'skill projection'),
    skillName: stringValue(projection.skillName, 'skill projection'),
    state: projectionState(projection.state, 'skill projection'),
    targetId: stringValue(projection.targetId, 'skill projection'),
    ...(projection.actualPath === undefined
      ? {}
      : { actualPath: stringValue(projection.actualPath, 'skill projection') }),
    ...(projection.targetIdentity === undefined
      ? {}
      : { targetIdentity: parseProjectionTargetIdentity(projection.targetIdentity) }),
  };
};

const parseSourceState = (value: unknown): SkillSourceState => {
  const state = recordValue(value, 'skill source state');
  if (state.version !== 1) {
    return invalidResult('skill source state');
  }
  const enabled = recordValue(state.skillEnabledByName, 'skill source state');
  const origins =
    state.skillOriginByName === undefined ? undefined : recordValue(state.skillOriginByName, 'skill source state');
  return {
    skillEnabledByName: Object.fromEntries(
      Object.entries(enabled).map(([name, value]) => [name, booleanValue(value, 'skill source state')]),
    ),
    version: 1,
    ...(origins === undefined
      ? {}
      : {
          skillOriginByName: Object.fromEntries(
            Object.entries(origins).map(([name, value]) => [name, stringValue(value, 'skill source state')]),
          ),
        }),
  };
};

const parseSummary = (value: unknown): SkillManagementSnapshotSummary => {
  const summary = recordValue(value, 'skills summary');
  return {
    activeSkillCount: nonNegativeInteger(summary.activeSkillCount, 'skills summary'),
    diagnosticCount: nonNegativeInteger(summary.diagnosticCount, 'skills summary'),
    healthyProjectionCount: nonNegativeInteger(summary.healthyProjectionCount, 'skills summary'),
    skillCount: nonNegativeInteger(summary.skillCount, 'skills summary'),
    targetCount: nonNegativeInteger(summary.targetCount, 'skills summary'),
    unhealthyProjectionCount: nonNegativeInteger(summary.unhealthyProjectionCount, 'skills summary'),
    unmanagedEntryCount: nonNegativeInteger(summary.unmanagedEntryCount, 'skills summary'),
  };
};

const parseSnapshot = (value: unknown): SkillManagementSnapshot => {
  const snapshot = recordValue(value, 'skills snapshot');
  let config: SkillManagementSnapshot['config'];
  try {
    config = parseSkillConfigInput(snapshot.config);
  } catch {
    return invalidResult('skills snapshot');
  }
  return {
    config,
    configured: booleanValue(snapshot.configured, 'skills snapshot'),
    diagnostics: arrayValue(snapshot.diagnostics, 'skills snapshot', parseDiagnostic),
    nativeRuleFindings: arrayValue(snapshot.nativeRuleFindings, 'skills snapshot', parseDiagnostic),
    projections: arrayValue(snapshot.projections, 'skills snapshot', parseProjection),
    skills: arrayValue(snapshot.skills, 'skills snapshot', parseSourceSkill),
    sourceState: parseSourceState(snapshot.sourceState),
    summary: parseSummary(snapshot.summary),
    targets: arrayValue(snapshot.targets, 'skills snapshot', parseTarget),
    unmanagedEntries: arrayValue(snapshot.unmanagedEntries, 'skills snapshot', parseProjection),
  };
};

const parseProjectionAction = (value: unknown): ProjectionAction => {
  const action = recordValue(value, 'projection action');
  const type = stringValue(action.type, 'projection action');
  const targetIdentity =
    action.targetIdentity === undefined ? {} : { targetIdentity: parseProjectionTargetIdentity(action.targetIdentity) };
  const common = {
    path: stringValue(action.path, 'projection action'),
    skillName: stringValue(action.skillName, 'projection action'),
    targetId: stringValue(action.targetId, 'projection action'),
  };
  if (type === 'noop' || type === 'refuse-unmanaged-mutation') {
    return { ...common, reason: stringValue(action.reason, 'projection action'), type };
  }
  if (type === 'create-symlink') {
    return { ...common, ...targetIdentity, sourcePath: stringValue(action.sourcePath, 'projection action'), type };
  }
  if (type === 'repair-symlink' || type === 'unlink-managed-symlink') {
    return {
      ...common,
      ...targetIdentity,
      observedSourcePath: stringValue(action.observedSourcePath, 'projection action'),
      sourcePath: stringValue(action.sourcePath, 'projection action'),
      type,
    };
  }
  return invalidResult('projection action');
};

const parseObservation = (value: unknown): ProjectSkillObservation => {
  const observation = recordValue(value, 'project skill observation');
  const invocation = stringValue(observation.invocation, 'project skill observation');
  if (!(invocation === 'auto' || invocation === 'manual')) {
    return invalidResult('project skill observation');
  }
  return {
    description: stringValue(observation.description, 'project skill observation'),
    diagnostics: arrayValue(observation.diagnostics, 'project skill observation', parseDiagnostic),
    invocation,
    markdownReadable: booleanValue(observation.markdownReadable, 'project skill observation'),
    name: stringValue(observation.name, 'project skill observation'),
    path: stringValue(observation.path, 'project skill observation'),
    placement: projectSkillPlacement(observation.placement, 'project skill observation'),
    runtimeDirId: projectRuntimeId(observation.runtimeDirId, 'project skill observation'),
    skillMdPath: stringValue(observation.skillMdPath, 'project skill observation'),
    validationStatus: validationStatus(observation.validationStatus, 'project skill observation'),
    ...(observation.tokenCount === undefined ? {} : { tokenCount: parseTokenCount(observation.tokenCount) }),
  };
};

const parseInventory = (value: unknown): ProjectSkillInventory => {
  const inventory = recordValue(value, 'skill inventory');
  return {
    diagnostics: arrayValue(inventory.diagnostics, 'skill inventory', parseDiagnostic),
    observations: arrayValue(inventory.observations, 'skill inventory', parseObservation),
    projectPath: stringValue(inventory.projectPath, 'skill inventory'),
  };
};

const parseKnownProject = (value: unknown): KnownSkillProjectPath => {
  const project = recordValue(value, 'known project path');
  return {
    label: stringValue(project.label, 'known project path'),
    path: stringValue(project.path, 'known project path'),
    project: stringValue(project.project, 'known project path'),
    sessions: nonNegativeInteger(project.sessions, 'known project path'),
    ...(project.groupId === undefined ? {} : { groupId: stringValue(project.groupId, 'known project path') }),
    ...(project.groupLabel === undefined ? {} : { groupLabel: stringValue(project.groupLabel, 'known project path') }),
    ...(project.machineLabel === undefined
      ? {}
      : { machineLabel: stringValue(project.machineLabel, 'known project path') }),
  };
};

const parseResultEnvelope = <T>(
  value: unknown,
  label: string,
  parseData: (data: unknown) => T,
): { ok: true; data: T } | { ok: false; error: { message: string; tag: string } } => {
  const result = recordValue(value, label);
  if (typeof result.ok !== 'boolean') {
    return invalidResult(label);
  }
  if (result.ok) {
    try {
      return { data: parseData(result.data), ok: true };
    } catch {
      return invalidResult(label);
    }
  }
  const error = recordValue(result.error, label);
  return {
    error: { message: stringValue(error.message, label), tag: stringValue(error.tag, label) },
    ok: false,
  };
};

export const parseSkillSnapshotResult = (value: unknown): SkillSnapshotResult =>
  parseResultEnvelope(value, 'skills snapshot', parseSnapshot);

export const parseSkillReconcileResult = (value: unknown): SkillReconcileServerResult =>
  parseResultEnvelope(value, 'skills reconcile', (data) => {
    const result = recordValue(data, 'skills reconcile');
    return {
      actions: arrayValue(result.actions, 'skills reconcile', parseProjectionAction),
      snapshot: parseSnapshot(result.snapshot),
    };
  });

export const parseKnownProjectPathsResult = (value: unknown): KnownProjectPathsResult =>
  parseResultEnvelope(value, 'known project paths', (data) =>
    arrayValue(data, 'known project paths', parseKnownProject),
  );

export const parseProjectInventoriesResult = (value: unknown): ProjectInventoriesResult =>
  parseResultEnvelope(value, 'skill inventories', (data) => arrayValue(data, 'skill inventories', parseInventory));
