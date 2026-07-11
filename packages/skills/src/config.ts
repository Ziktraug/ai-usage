import type {
  SkillManagementConfig,
  SkillManagementConnectorConfig,
  SkillManagementTargetConfig,
  SkillMutationInput,
  SkillTargetDirectoryInput,
  SkillTargetKind,
  SkillTargetScope,
  SkillToggleInput,
  SkillTokenThreshold,
  SkillTokenThresholds,
} from './contracts';
import { parseSkillName, parseTargetId } from './shared';
import { assertRecord, parseBoolean, parseRequiredNonEmptyString } from './validation';

const targetKinds = new Set<SkillTargetKind>(['standard-interop', 'native', 'custom']);
const targetScopes = new Set<SkillTargetScope>(['system', 'project']);

const parseOptionalNonEmptyString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const parseStringArray = (value: unknown, label: string): readonly string[] => {
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
};

const parseNonEmptyStringArray = (value: unknown, label: string): readonly string[] => {
  const entries = parseStringArray(value, label);
  if (entries.some((entry) => entry.trim().length === 0)) {
    throw new Error(`${label} must contain only non-empty strings`);
  }
  return entries;
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

export const parseSkillToggleInput = (value: unknown): SkillToggleInput => {
  const input = assertRecord(value, 'skill toggle input');
  return {
    enabled: parseBoolean(input.enabled, 'enabled'),
    skillName: parseSkillName(input.skillName),
  };
};

export const parseSkillTargetDirectoryInput = (value: unknown): SkillTargetDirectoryInput => {
  const input = assertRecord(value, 'skill target directory input');
  return {
    targetId: parseTargetId(input.targetId),
  };
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

  if (input.projectPaths !== undefined) {
    parsed.projectPaths = parseNonEmptyStringArray(input.projectPaths, 'projectPaths');
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
