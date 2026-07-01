import path from 'node:path';

export type SkillDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface SkillDiagnostic {
  code: string;
  message: string;
  path?: string;
  severity: SkillDiagnosticSeverity;
  skillName?: string;
  targetId?: string;
}

export type SkillTargetScope = 'system' | 'project';
export type SkillTargetKind = 'standard-interop' | 'native' | 'custom';

export interface SkillTokenThreshold {
  high: number;
  warn: number;
}

export interface SkillTokenThresholds {
  referenceFile: SkillTokenThreshold;
  skillMd: SkillTokenThreshold;
  totalSkill: SkillTokenThreshold;
}

export interface SkillManagementTargetConfig {
  enabled: boolean;
  kind: SkillTargetKind;
  path: string;
  scope: SkillTargetScope;
}

export interface SkillManagementConnectorConfig {
  consumesTargets: readonly string[];
  enabled: boolean;
}

export interface SkillManagementConfig {
  connectors?: Record<string, SkillManagementConnectorConfig>;
  ignoredTargetFindings?: readonly string[];
  projectsRootPath?: string;
  sourceRepoPath?: string;
  targets?: Record<string, SkillManagementTargetConfig>;
  tokenThresholds?: SkillTokenThresholds;
}

export interface SkillSourceState {
  skillEnabledByName: Record<string, boolean>;
  version: 1;
}

export type SkillValidationStatus = 'valid' | 'warning' | 'invalid';

export type SkillFrontmatterFieldKind = 'standard' | 'known-extension' | 'unknown-extension';

export interface SkillFrontmatterField {
  key: string;
  kind: SkillFrontmatterFieldKind;
  value: unknown;
}

export interface SkillManifest {
  description?: string;
  fields: readonly SkillFrontmatterField[];
  markdown: string;
  name?: string;
}

export interface SourceSkill {
  description: string;
  diagnostics: readonly SkillDiagnostic[];
  enabled: boolean;
  manifest: SkillManifest;
  name: string;
  path: string;
  skillMdPath: string;
  tokenCount?: {
    approximate: true;
    references: number;
    skillMd: number;
    total: number;
  };
  validationStatus: SkillValidationStatus;
}

export interface SkillTarget {
  connectorId?: string;
  enabled: boolean;
  id: string;
  kind: SkillTargetKind;
  label: string;
  missing: boolean;
  observed: boolean;
  path: string;
  scope: SkillTargetScope;
}

export type ProjectionState =
  | 'linked'
  | 'missing'
  | 'broken-link'
  | 'wrong-target'
  | 'unmanaged-copy'
  | 'unmanaged-symlink'
  | 'duplicate-same-content'
  | 'duplicate-name-conflict'
  | 'disabled-exposed'
  | 'missing-target';

export interface Projection {
  actualPath?: string;
  diagnostics: readonly SkillDiagnostic[];
  expectedPath: string;
  skillName: string;
  state: ProjectionState;
  targetId: string;
}

export type ProjectionAction =
  | {
      path: string;
      skillName: string;
      sourcePath: string;
      targetId: string;
      type: 'create-symlink' | 'repair-symlink' | 'unlink-managed-symlink';
    }
  | {
      path: string;
      reason: string;
      skillName: string;
      targetId: string;
      type: 'noop' | 'refuse-unmanaged-mutation';
    };

export interface SkillMutationInput {
  enabled?: boolean;
  skillName: string;
  targetId: string;
}

export const defaultTokenThresholds: SkillTokenThresholds = {
  referenceFile: { warn: 5000, high: 12_000 },
  skillMd: { warn: 2000, high: 5000 },
  totalSkill: { warn: 8000, high: 20_000 },
};

const namePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const targetIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const targetKinds = new Set<SkillTargetKind>(['standard-interop', 'native', 'custom']);
const targetScopes = new Set<SkillTargetScope>(['system', 'project']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

const parseOptionalNonEmptyString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const parseBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
};

const parseStringArray = (value: unknown, label: string): readonly string[] => {
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
};

const parsePositiveNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
};

const parseTokenThreshold = (value: unknown, label: string): SkillTokenThreshold => {
  const record = assertRecord(value, label);
  return {
    high: parsePositiveNumber(record.high, `${label}.high`),
    warn: parsePositiveNumber(record.warn, `${label}.warn`),
  };
};

const parseTokenThresholds = (value: unknown): SkillTokenThresholds => {
  const record = assertRecord(value, 'tokenThresholds');
  return {
    referenceFile: parseTokenThreshold(record.referenceFile, 'tokenThresholds.referenceFile'),
    skillMd: parseTokenThreshold(record.skillMd, 'tokenThresholds.skillMd'),
    totalSkill: parseTokenThreshold(record.totalSkill, 'tokenThresholds.totalSkill'),
  };
};

const parseTargets = (value: unknown): Record<string, SkillManagementTargetConfig> => {
  const targets = assertRecord(value, 'targets');
  const parsed: Record<string, SkillManagementTargetConfig> = {};
  for (const [targetId, targetValue] of Object.entries(targets)) {
    parseTargetId(targetId);
    const target = assertRecord(targetValue, `targets.${targetId}`);
    if (typeof target.kind !== 'string' || !targetKinds.has(target.kind as SkillTargetKind)) {
      throw new Error(`targets.${targetId}.kind must be a supported target kind`);
    }
    if (typeof target.scope !== 'string' || !targetScopes.has(target.scope as SkillTargetScope)) {
      throw new Error(`targets.${targetId}.scope must be a supported target scope`);
    }
    parsed[targetId] = {
      enabled: parseBoolean(target.enabled, `targets.${targetId}.enabled`),
      kind: target.kind as SkillTargetKind,
      path: parseRequiredNonEmptyString(target.path, `targets.${targetId}.path`),
      scope: target.scope as SkillTargetScope,
    };
  }
  return parsed;
};

const parseConnectors = (value: unknown): Record<string, SkillManagementConnectorConfig> => {
  const connectors = assertRecord(value, 'connectors');
  const parsed: Record<string, SkillManagementConnectorConfig> = {};
  for (const [connectorId, connectorValue] of Object.entries(connectors)) {
    parseTargetId(connectorId);
    const connector = assertRecord(connectorValue, `connectors.${connectorId}`);
    parsed[connectorId] = {
      consumesTargets: parseStringArray(connector.consumesTargets, `connectors.${connectorId}.consumesTargets`),
      enabled: parseBoolean(connector.enabled, `connectors.${connectorId}.enabled`),
    };
    for (const targetId of parsed[connectorId].consumesTargets) {
      parseTargetId(targetId);
    }
  }
  return parsed;
};

const parseRequiredNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

export const parseSkillName = (value: unknown): string => {
  if (typeof value !== 'string' || !namePattern.test(value)) {
    throw new Error('skill name must be lowercase kebab-case');
  }
  return value;
};

export const parseTargetId = (value: unknown): string => {
  if (typeof value !== 'string' || !targetIdPattern.test(value)) {
    throw new Error('target id must be lowercase kebab-case');
  }
  return value;
};

export const parseSkillFilePath = (value: unknown, skillDirectory: string): string => {
  const relativePath = parseRequiredNonEmptyString(value, 'skill file path');
  if (path.isAbsolute(relativePath)) {
    throw new Error('skill file path must be relative');
  }
  const basePath = path.resolve(skillDirectory);
  const resolvedPath = path.resolve(basePath, relativePath);
  const pathFromBase = path.relative(basePath, resolvedPath);
  if (pathFromBase === '' || pathFromBase.startsWith('..') || path.isAbsolute(pathFromBase)) {
    throw new Error('skill file path must stay inside the selected skill directory');
  }
  return pathFromBase.split(path.sep).join('/');
};

export const parseSkillMutationInput = (value: unknown): SkillMutationInput => {
  const input = assertRecord(value, 'skill mutation input');
  const parsed: SkillMutationInput = {
    skillName: parseSkillName(input.skillName),
    targetId: parseTargetId(input.targetId),
  };
  if (input.enabled !== undefined) {
    parsed.enabled = parseBoolean(input.enabled, 'enabled');
  }
  return parsed;
};

export const parseSkillConfigInput = (value: unknown): SkillManagementConfig => {
  const input = assertRecord(value, 'skills config');
  const parsed: SkillManagementConfig = {};

  const sourceRepoPath = parseOptionalNonEmptyString(input.sourceRepoPath, 'sourceRepoPath');
  if (sourceRepoPath !== undefined) {
    parsed.sourceRepoPath = sourceRepoPath;
  }

  const projectsRootPath = parseOptionalNonEmptyString(input.projectsRootPath, 'projectsRootPath');
  if (projectsRootPath !== undefined) {
    parsed.projectsRootPath = projectsRootPath;
  }

  if (input.targets !== undefined) {
    parsed.targets = parseTargets(input.targets);
  }
  if (input.connectors !== undefined) {
    parsed.connectors = parseConnectors(input.connectors);
  }
  if (input.tokenThresholds !== undefined) {
    parsed.tokenThresholds = parseTokenThresholds(input.tokenThresholds);
  }
  if (input.ignoredTargetFindings !== undefined) {
    parsed.ignoredTargetFindings = parseStringArray(input.ignoredTargetFindings, 'ignoredTargetFindings');
  }

  return parsed;
};
