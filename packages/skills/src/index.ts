import { lstat, mkdir, readdir, readFile, readlink, stat, symlink, unlink, writeFile } from 'node:fs/promises';
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

export type JsonValue = boolean | null | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface SkillFrontmatterField {
  key: string;
  kind: SkillFrontmatterFieldKind;
  value: JsonValue;
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

export interface SkillToggleInput {
  enabled: boolean;
  skillName: string;
}

export interface SkillTargetDirectoryInput {
  targetId: string;
}

export interface SkillSourceStateResult {
  diagnostics: readonly SkillDiagnostic[];
  state: SkillSourceState;
}

export interface ParsedSkillMarkdown {
  diagnostics: readonly SkillDiagnostic[];
  manifest: SkillManifest;
}

export interface SourceSkillScanOptions {
  ignoredDirectories?: readonly string[];
  maxFilesPerSkill?: number;
  maxTextFileBytes?: number;
  tokenThresholds?: SkillTokenThresholds;
}

export interface SourceSkillScanInput {
  options?: SourceSkillScanOptions;
  sourceRepoPath: string;
  state?: SkillSourceState;
}

export interface SourceSkillScan {
  diagnostics: readonly SkillDiagnostic[];
  skills: readonly SourceSkill[];
}

export interface TargetProjectionScanInput {
  skills: readonly SourceSkill[];
  targets: readonly SkillTarget[];
}

export interface TargetProjectionScan {
  diagnostics: readonly SkillDiagnostic[];
  projections: readonly Projection[];
  unmanagedEntries: readonly Projection[];
}

export interface SkillManagementConfigDocument {
  skills?: unknown;
  [key: string]: unknown;
}

export interface SkillManagementSnapshotSummary {
  activeSkillCount: number;
  diagnosticCount: number;
  healthyProjectionCount: number;
  skillCount: number;
  targetCount: number;
  unhealthyProjectionCount: number;
  unmanagedEntryCount: number;
}

export interface SkillManagementSnapshot {
  config: SkillManagementConfig;
  configured: boolean;
  diagnostics: readonly SkillDiagnostic[];
  nativeRuleFindings: readonly SkillDiagnostic[];
  projections: readonly Projection[];
  skills: readonly SourceSkill[];
  sourceState: SkillSourceState;
  summary: SkillManagementSnapshotSummary;
  targets: readonly SkillTarget[];
  unmanagedEntries: readonly Projection[];
}

export interface LoadSkillManagementSnapshotInput {
  config: SkillManagementConfigDocument;
  homePath: string;
}

export interface WriteSkillManagementConfigInput {
  config: SkillManagementConfigDocument;
  skills: unknown;
  writeConfig: (config: SkillManagementConfigDocument) => Promise<void>;
}

export interface ToggleSkillEnabledInput {
  enabled: boolean;
  skillName: string;
  sourceRepoPath: string;
}

export interface ReconcileSkillInput extends LoadSkillManagementSnapshotInput {
  skillName: string;
}

export interface SkillReconcileResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

export interface CreateSkillTargetDirectoryInput {
  path: string;
}

export const defaultTokenThresholds: SkillTokenThresholds = {
  referenceFile: { warn: 5000, high: 12_000 },
  skillMd: { warn: 2000, high: 5000 },
  totalSkill: { warn: 8000, high: 20_000 },
};

const namePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const targetIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const frontmatterClosePattern = /^\n---\r?\n?/;
const lineBreakPattern = /\r?\n/;
const whitespacePattern = /\s+/;
const targetKinds = new Set<SkillTargetKind>(['standard-interop', 'native', 'custom']);
const targetScopes = new Set<SkillTargetScope>(['system', 'project']);
const knownFrontmatterExtensions = new Set(['paths', 'disable-model-invocation']);
const standardFrontmatterFields = new Set(['name', 'description']);
const defaultIgnoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.turbo', 'styled-system']);
const defaultMaxFilesPerSkill = 200;
const defaultMaxTextFileBytes = 200_000;

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

const createDiagnostic = (
  code: string,
  severity: SkillDiagnosticSeverity,
  message: string,
  details: Omit<SkillDiagnostic, 'code' | 'message' | 'severity'> = {},
): SkillDiagnostic => ({
  code,
  message,
  severity,
  ...details,
});

const isMissingPathError = (error: unknown) =>
  isRecord(error) && typeof error.code === 'string' && error.code === 'ENOENT';

const isSkillSourceState = (value: unknown): value is SkillSourceState => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.skillEnabledByName)) {
    return false;
  }
  return Object.entries(value.skillEnabledByName).every(
    ([skillName, enabled]) => namePattern.test(skillName) && typeof enabled === 'boolean',
  );
};

const approximateTokenCount = (text: string) => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return Math.ceil(trimmed.split(whitespacePattern).length * 1.35);
};

const looksBinary = (buffer: Buffer) => buffer.includes(0);

const parseScalarFrontmatterValue = (value: string): JsonValue => {
  const trimmed = value.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const classifyFrontmatterField = (key: string): SkillFrontmatterFieldKind => {
  if (standardFrontmatterFields.has(key)) {
    return 'standard';
  }
  if (knownFrontmatterExtensions.has(key)) {
    return 'known-extension';
  }
  return 'unknown-extension';
};

const parseFrontmatter = (text: string) => {
  if (!text.startsWith('---\n')) {
    return { fields: [] as SkillFrontmatterField[], markdown: text };
  }

  const endIndex = text.indexOf('\n---', 4);
  if (endIndex === -1) {
    return { fields: [] as SkillFrontmatterField[], markdown: text };
  }

  const frontmatter = text.slice(4, endIndex);
  const markdown = text.slice(endIndex).replace(frontmatterClosePattern, '');
  const lines = frontmatter.split(lineBreakPattern);
  const fields: SkillFrontmatterField[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0 || line.startsWith(' ')) {
      continue;
    }
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    let value: JsonValue = parseScalarFrontmatterValue(rawValue);
    if (rawValue.length === 0) {
      const arrayValue: string[] = [];
      while (lines[index + 1]?.trim().startsWith('- ')) {
        index += 1;
        const item = lines[index]?.trim().slice(2).trim();
        if (item) {
          arrayValue.push(item);
        }
      }
      value = arrayValue;
    }
    fields.push({
      key,
      kind: classifyFrontmatterField(key),
      value,
    });
  }

  return { fields, markdown };
};

const textField = (fields: readonly SkillFrontmatterField[], key: string): string | undefined => {
  const field = fields.find((entry) => entry.key === key);
  return typeof field?.value === 'string' && field.value.trim().length > 0 ? field.value : undefined;
};

const validationStatusFor = (diagnostics: readonly SkillDiagnostic[]): SkillValidationStatus => {
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return 'invalid';
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'warning')) {
    return 'warning';
  }
  return 'valid';
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

export const skillSourceStatePath = (sourceRepoPath: string): string =>
  path.join(sourceRepoPath, '.skill-tracker', 'state.json');

export const loadSkillSourceState = async (sourceRepoPath: string): Promise<SkillSourceStateResult> => {
  const filePath = skillSourceStatePath(sourceRepoPath);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!isSkillSourceState(parsed)) {
      return {
        diagnostics: [
          createDiagnostic('InvalidSourceState', 'error', 'Source skill state must be JSON version 1', {
            path: filePath,
          }),
        ],
        state: { version: 1, skillEnabledByName: {} },
      };
    }
    return { diagnostics: [], state: parsed };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { diagnostics: [], state: { version: 1, skillEnabledByName: {} } };
    }
    return {
      diagnostics: [
        createDiagnostic('InvalidSourceState', 'error', 'Source skill state must be readable JSON', {
          path: filePath,
        }),
      ],
      state: { version: 1, skillEnabledByName: {} },
    };
  }
};

export const writeSkillSourceState = async (sourceRepoPath: string, stateValue: SkillSourceState): Promise<void> => {
  if (!isSkillSourceState(stateValue)) {
    throw new Error('source skill state must be JSON version 1');
  }
  const filePath = skillSourceStatePath(sourceRepoPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stateValue, null, 2)}\n`, 'utf8');
};

export const setSkillEnabled = async (
  sourceRepoPath: string,
  skillName: string,
  enabled: boolean,
): Promise<SkillSourceState> => {
  const parsedSkillName = parseSkillName(skillName);
  const current = await loadSkillSourceState(sourceRepoPath);
  const nextState: SkillSourceState = {
    version: 1,
    skillEnabledByName: {
      ...current.state.skillEnabledByName,
      [parsedSkillName]: parseBoolean(enabled, 'enabled'),
    },
  };
  await writeSkillSourceState(sourceRepoPath, nextState);
  return nextState;
};

export const parseSkillMarkdown = (skillName: string, text: string): ParsedSkillMarkdown => {
  const parsedSkillName = parseSkillName(skillName);
  const { fields, markdown } = parseFrontmatter(text);
  const manifestName = textField(fields, 'name');
  const description = textField(fields, 'description');
  const diagnostics: SkillDiagnostic[] = [];

  if (description === undefined) {
    diagnostics.push(
      createDiagnostic('MissingSkillDescription', 'warning', 'SKILL.md frontmatter should include description', {
        skillName: parsedSkillName,
      }),
    );
  }
  if (manifestName !== undefined && manifestName !== parsedSkillName) {
    diagnostics.push(
      createDiagnostic('SkillNameMismatch', 'error', 'SKILL.md frontmatter name does not match directory name', {
        skillName: parsedSkillName,
      }),
    );
  }
  for (const field of fields) {
    if (field.kind === 'unknown-extension') {
      diagnostics.push(
        createDiagnostic('UnknownFrontmatterField', 'warning', `Unknown SKILL.md frontmatter field: ${field.key}`, {
          skillName: parsedSkillName,
        }),
      );
    }
  }

  const manifest: SkillManifest = {
    fields,
    markdown,
  };
  if (manifestName !== undefined) {
    manifest.name = manifestName;
  }
  if (description !== undefined) {
    manifest.description = description;
  }
  return { diagnostics, manifest };
};

const collectSkillFiles = async (directory: string, ignoredDirectories: ReadonlySet<string>): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collectSkillFiles(entryPath, ignoredDirectories)));
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
};

const readTextForTokenCount = async (
  filePath: string,
  maxTextFileBytes: number,
  skillName: string,
): Promise<{ diagnostics: readonly SkillDiagnostic[]; text: string }> => {
  const fileStat = await stat(filePath);
  if (fileStat.size > maxTextFileBytes) {
    return {
      diagnostics: [
        createDiagnostic('SkillFileTooLarge', 'warning', 'Skill file is too large for token counting', {
          path: filePath,
          skillName,
        }),
      ],
      text: '',
    };
  }
  const buffer = await readFile(filePath);
  if (looksBinary(buffer)) {
    return {
      diagnostics: [
        createDiagnostic('BinarySkillFileSkipped', 'info', 'Binary skill file was skipped for token counting', {
          path: filePath,
          skillName,
        }),
      ],
      text: '',
    };
  }
  return { diagnostics: [], text: buffer.toString('utf8') };
};

const scanOneSkill = async (
  skillDirectory: string,
  stateValue: SkillSourceState,
  options: Required<Pick<SourceSkillScanOptions, 'maxFilesPerSkill' | 'maxTextFileBytes'>>,
  ignoredDirectories: ReadonlySet<string>,
): Promise<{ diagnostics: readonly SkillDiagnostic[]; skill?: SourceSkill }> => {
  const skillName = path.basename(skillDirectory);
  try {
    parseSkillName(skillName);
  } catch {
    return {
      diagnostics: [
        createDiagnostic('InvalidSkillDirectoryName', 'error', 'Skill directory name must be lowercase kebab-case', {
          path: skillDirectory,
        }),
      ],
    };
  }

  const skillMdPath = path.join(skillDirectory, 'SKILL.md');
  let skillMdText: string;
  try {
    skillMdText = await readFile(skillMdPath, 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        diagnostics: [
          createDiagnostic('MissingSkillMarkdown', 'error', 'Skill directory is missing SKILL.md', {
            path: skillMdPath,
            skillName,
          }),
        ],
      };
    }
    return {
      diagnostics: [
        createDiagnostic('UnreadableSkillMarkdown', 'error', 'SKILL.md could not be read', {
          path: skillMdPath,
          skillName,
        }),
      ],
    };
  }

  const parsedMarkdown = parseSkillMarkdown(skillName, skillMdText);
  const diagnostics: SkillDiagnostic[] = [...parsedMarkdown.diagnostics];
  let files: string[];
  try {
    files = await collectSkillFiles(skillDirectory, ignoredDirectories);
  } catch {
    files = [skillMdPath];
    diagnostics.push(
      createDiagnostic('UnreadableSkillDirectory', 'warning', 'Skill directory could not be fully scanned', {
        path: skillDirectory,
        skillName,
      }),
    );
  }

  if (files.length > options.maxFilesPerSkill) {
    diagnostics.push(
      createDiagnostic('SkillFileLimitExceeded', 'warning', 'Skill has more files than the configured scan limit', {
        path: skillDirectory,
        skillName,
      }),
    );
  }

  let referenceTokens = 0;
  for (const filePath of files) {
    if (path.basename(filePath) === 'SKILL.md') {
      continue;
    }
    const textResult = await readTextForTokenCount(filePath, options.maxTextFileBytes, skillName);
    diagnostics.push(...textResult.diagnostics);
    referenceTokens += approximateTokenCount(textResult.text);
  }

  const skillMdTokens = approximateTokenCount(skillMdText);
  const skill: SourceSkill = {
    description: parsedMarkdown.manifest.description ?? '',
    diagnostics,
    enabled: stateValue.skillEnabledByName[skillName] ?? true,
    manifest: parsedMarkdown.manifest,
    name: skillName,
    path: skillDirectory,
    skillMdPath,
    tokenCount: {
      approximate: true,
      references: referenceTokens,
      skillMd: skillMdTokens,
      total: skillMdTokens + referenceTokens,
    },
    validationStatus: validationStatusFor(diagnostics),
  };

  return { diagnostics, skill };
};

export const scanSkillSourceRepository = async (input: SourceSkillScanInput): Promise<SourceSkillScan> => {
  const sourceRepoPath = parseRequiredNonEmptyString(input.sourceRepoPath, 'sourceRepoPath');
  const stateResult =
    input.state === undefined ? await loadSkillSourceState(sourceRepoPath) : { diagnostics: [], state: input.state };
  const diagnostics: SkillDiagnostic[] = [...stateResult.diagnostics];
  const skillsDirectory = path.join(sourceRepoPath, 'skills');
  const ignoredDirectories = new Set([...defaultIgnoredDirectories, ...(input.options?.ignoredDirectories ?? [])]);
  const options = {
    maxFilesPerSkill: input.options?.maxFilesPerSkill ?? defaultMaxFilesPerSkill,
    maxTextFileBytes: input.options?.maxTextFileBytes ?? defaultMaxTextFileBytes,
  };

  let entries: Array<{ isDirectory: () => boolean; name: string }>;
  try {
    entries = await readdir(skillsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return { diagnostics, skills: [] };
    }
    return {
      diagnostics: [
        ...diagnostics,
        createDiagnostic('UnreadableSkillsDirectory', 'error', 'Source skills directory could not be read', {
          path: skillsDirectory,
        }),
      ],
      skills: [],
    };
  }

  const skills: SourceSkill[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const result = await scanOneSkill(
      path.join(skillsDirectory, entry.name),
      stateResult.state,
      options,
      ignoredDirectories,
    );
    diagnostics.push(...result.diagnostics);
    if (result.skill) {
      skills.push(result.skill);
    }
  }

  return { diagnostics, skills };
};

export const buildDefaultSkillTargets = (homePath: string): readonly SkillTarget[] => [
  {
    enabled: true,
    id: 'standard-agents',
    kind: 'standard-interop',
    label: 'Standard Agents',
    missing: false,
    observed: true,
    path: path.join(homePath, '.agents', 'skills'),
    scope: 'system',
  },
  {
    enabled: true,
    id: 'claude-code',
    kind: 'standard-interop',
    label: 'Claude Code',
    missing: false,
    observed: true,
    path: path.join(homePath, '.claude', 'skills'),
    scope: 'system',
  },
  {
    enabled: true,
    id: 'codex',
    kind: 'standard-interop',
    label: 'Codex',
    missing: false,
    observed: true,
    path: path.join(homePath, '.codex', 'skills'),
    scope: 'system',
  },
  {
    enabled: true,
    id: 'opencode',
    kind: 'standard-interop',
    label: 'OpenCode',
    missing: false,
    observed: true,
    path: path.join(homePath, '.config', 'opencode', 'skills'),
    scope: 'system',
  },
  {
    enabled: false,
    id: 'github-copilot',
    kind: 'standard-interop',
    label: 'GitHub Copilot',
    missing: false,
    observed: false,
    path: path.join(homePath, '.config', 'github-copilot', 'skills'),
    scope: 'system',
  },
  {
    enabled: false,
    id: 'cursor',
    kind: 'standard-interop',
    label: 'Cursor',
    missing: false,
    observed: false,
    path: path.join(homePath, '.cursor', 'skills'),
    scope: 'system',
  },
];

const projectionFor = (
  skillName: string,
  targetId: string,
  expectedPath: string,
  stateValue: ProjectionState,
  options: {
    actualPath?: string;
    diagnostics?: readonly SkillDiagnostic[];
  } = {},
): Projection => {
  const projection: Projection = {
    diagnostics: options.diagnostics ?? [],
    expectedPath,
    skillName,
    state: stateValue,
    targetId,
  };
  if (options.actualPath !== undefined) {
    projection.actualPath = options.actualPath;
  }
  return projection;
};

const classifyProjectedSkill = async (skill: SourceSkill, target: SkillTarget): Promise<Projection> => {
  const expectedPath = path.join(target.path, skill.name);
  if (target.missing) {
    return projectionFor(skill.name, target.id, expectedPath, 'missing-target', {
      diagnostics: [
        createDiagnostic('MissingTarget', 'warning', 'Target directory is missing', {
          path: target.path,
          skillName: skill.name,
          targetId: target.id,
        }),
      ],
    });
  }

  let entryStat: Awaited<ReturnType<typeof lstat>>;
  try {
    entryStat = await lstat(expectedPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return projectionFor(skill.name, target.id, expectedPath, 'missing');
    }
    return projectionFor(skill.name, target.id, expectedPath, 'missing-target', {
      diagnostics: [
        createDiagnostic('UnreadableTargetEntry', 'warning', 'Target entry could not be inspected', {
          path: expectedPath,
          skillName: skill.name,
          targetId: target.id,
        }),
      ],
    });
  }

  if (entryStat.isSymbolicLink()) {
    const linkTarget = await readlink(expectedPath);
    const actualPath = path.resolve(path.dirname(expectedPath), linkTarget);
    try {
      await stat(actualPath);
    } catch {
      return projectionFor(skill.name, target.id, expectedPath, 'broken-link', { actualPath });
    }
    if (path.resolve(skill.path) === actualPath) {
      return projectionFor(skill.name, target.id, expectedPath, skill.enabled ? 'linked' : 'disabled-exposed', {
        actualPath,
      });
    }
    return projectionFor(skill.name, target.id, expectedPath, 'wrong-target', { actualPath });
  }

  return projectionFor(skill.name, target.id, expectedPath, skill.enabled ? 'unmanaged-copy' : 'disabled-exposed', {
    actualPath: expectedPath,
  });
};

const scanUnmanagedTargetEntries = async (
  target: SkillTarget,
  managedSkillNames: ReadonlySet<string>,
): Promise<readonly Projection[]> => {
  let entries: Array<{
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
    name: string;
  }>;
  try {
    entries = await readdir(target.path, { withFileTypes: true });
  } catch {
    return [];
  }

  const projections: Projection[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (managedSkillNames.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(target.path, entry.name);
    if (entry.isSymbolicLink()) {
      projections.push(projectionFor(entry.name, target.id, entryPath, 'unmanaged-symlink', { actualPath: entryPath }));
      continue;
    }
    if (entry.isDirectory() || entry.isFile()) {
      projections.push(projectionFor(entry.name, target.id, entryPath, 'unmanaged-copy', { actualPath: entryPath }));
    }
  }
  return projections;
};

export const scanTargetProjections = async (input: TargetProjectionScanInput): Promise<TargetProjectionScan> => {
  const projections: Projection[] = [];
  const unmanagedEntries: Projection[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const managedSkillNames = new Set(input.skills.map((skill) => skill.name));

  for (const target of input.targets) {
    let targetMissing = target.missing;
    try {
      const targetStat = await lstat(target.path);
      targetMissing = !targetStat.isDirectory();
    } catch (error) {
      if (isMissingPathError(error)) {
        targetMissing = true;
      } else {
        diagnostics.push(
          createDiagnostic('UnreadableTarget', 'warning', 'Target directory could not be inspected', {
            path: target.path,
            targetId: target.id,
          }),
        );
        targetMissing = true;
      }
    }
    const observedTarget: SkillTarget = { ...target, missing: targetMissing, observed: !targetMissing };
    for (const skill of input.skills) {
      projections.push(await classifyProjectedSkill(skill, observedTarget));
    }
    if (!targetMissing) {
      unmanagedEntries.push(...(await scanUnmanagedTargetEntries(observedTarget, managedSkillNames)));
    }
  }

  diagnostics.push(...projections.flatMap((projection) => projection.diagnostics));
  return { diagnostics, projections, unmanagedEntries };
};

export const isProjectionHealthy = (projection: Projection | undefined): boolean => projection?.state === 'linked';

export const planProjection = (
  skill: SourceSkill,
  target: SkillTarget,
  projection: Projection | undefined,
): ProjectionAction => {
  const expectedPath = projection?.expectedPath ?? path.join(target.path, skill.name);
  if (projection === undefined) {
    return {
      path: expectedPath,
      reason: 'projection is unavailable',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  if (!skill.enabled) {
    if (
      projection.state === 'linked' ||
      (projection.state === 'disabled-exposed' && projection.actualPath === skill.path)
    ) {
      return {
        path: projection.expectedPath,
        skillName: skill.name,
        sourcePath: skill.path,
        targetId: target.id,
        type: 'unlink-managed-symlink',
      };
    }
    if (projection.state === 'disabled-exposed') {
      return {
        path: projection.expectedPath,
        reason: 'disabled skill remains exposed by unmanaged content',
        skillName: skill.name,
        targetId: target.id,
        type: 'refuse-unmanaged-mutation',
      };
    }
    return {
      path: projection.expectedPath,
      reason: 'disabled skill has no managed symlink to remove',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  if (skill.validationStatus !== 'valid') {
    return {
      path: projection.expectedPath,
      reason: 'invalid skills cannot be projected',
      skillName: skill.name,
      targetId: target.id,
      type: 'refuse-unmanaged-mutation',
    };
  }

  if (!target.enabled) {
    return {
      path: projection.expectedPath,
      reason: 'target is disabled',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  if (projection.state === 'missing') {
    return {
      path: projection.expectedPath,
      skillName: skill.name,
      sourcePath: skill.path,
      targetId: target.id,
      type: 'create-symlink',
    };
  }

  if (projection.state === 'broken-link' || projection.state === 'wrong-target') {
    return {
      path: projection.expectedPath,
      skillName: skill.name,
      sourcePath: skill.path,
      targetId: target.id,
      type: 'repair-symlink',
    };
  }

  if (projection.state === 'linked') {
    return {
      path: projection.expectedPath,
      reason: 'already linked',
      skillName: skill.name,
      targetId: target.id,
      type: 'noop',
    };
  }

  return {
    path: projection.expectedPath,
    reason: `refusing to mutate ${projection.state}`,
    skillName: skill.name,
    targetId: target.id,
    type: 'refuse-unmanaged-mutation',
  };
};

export const applyProjectionAction = async (action: ProjectionAction): Promise<void> => {
  if (action.type === 'noop' || action.type === 'refuse-unmanaged-mutation') {
    return;
  }

  if (action.type === 'create-symlink') {
    await mkdir(path.dirname(action.path), { recursive: true });
    await symlink(action.sourcePath, action.path);
    return;
  }

  if (action.type === 'repair-symlink') {
    const entryStat = await lstat(action.path);
    if (!entryStat.isSymbolicLink()) {
      throw new Error('Can only repair symlink entries');
    }
    await unlink(action.path);
    await symlink(action.sourcePath, action.path);
    return;
  }

  if (action.type === 'unlink-managed-symlink') {
    const entryStat = await lstat(action.path);
    if (!entryStat.isSymbolicLink()) {
      return;
    }
    const actualPath = path.resolve(path.dirname(action.path), await readlink(action.path));
    if (actualPath !== path.resolve(action.sourcePath)) {
      throw new Error('Refusing to unlink unmanaged symlink');
    }
    await unlink(action.path);
  }
};

const emptySkillManagementSnapshot = (
  config: SkillManagementConfig,
  diagnostics: readonly SkillDiagnostic[] = [],
): SkillManagementSnapshot => ({
  config,
  configured: false,
  diagnostics,
  nativeRuleFindings: [],
  projections: [],
  skills: [],
  sourceState: { version: 1, skillEnabledByName: {} },
  summary: {
    activeSkillCount: 0,
    diagnosticCount: diagnostics.length,
    healthyProjectionCount: 0,
    skillCount: 0,
    targetCount: 0,
    unhealthyProjectionCount: 0,
    unmanagedEntryCount: 0,
  },
  targets: [],
  unmanagedEntries: [],
});

const targetLabelFor = (targetId: string): string =>
  targetId
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');

const buildConfiguredSkillTargets = (config: SkillManagementConfig, homePath: string): readonly SkillTarget[] => {
  const configuredTargets = config.targets;
  if (configuredTargets === undefined) {
    return buildDefaultSkillTargets(homePath);
  }
  return Object.entries(configuredTargets).map(([targetId, targetConfig]) => ({
    enabled: targetConfig.enabled,
    id: targetId,
    kind: targetConfig.kind,
    label: targetLabelFor(targetId),
    missing: false,
    observed: false,
    path: targetConfig.path,
    scope: targetConfig.scope,
  }));
};

const observeSkillTargets = async (targets: readonly SkillTarget[]): Promise<readonly SkillTarget[]> => {
  const observedTargets: SkillTarget[] = [];
  for (const target of targets) {
    try {
      const targetStat = await lstat(target.path);
      const isDirectory = targetStat.isDirectory();
      observedTargets.push({
        ...target,
        missing: !isDirectory,
        observed: isDirectory,
      });
    } catch (error) {
      observedTargets.push({
        ...target,
        missing: isMissingPathError(error) ? true : target.missing,
        observed: false,
      });
    }
  }
  return observedTargets;
};

const snapshotSummary = (
  skills: readonly SourceSkill[],
  targets: readonly SkillTarget[],
  projections: readonly Projection[],
  unmanagedEntries: readonly Projection[],
  diagnostics: readonly SkillDiagnostic[],
): SkillManagementSnapshotSummary => {
  const healthyProjectionCount = projections.filter(isProjectionHealthy).length;
  return {
    activeSkillCount: skills.filter((skill) => skill.enabled).length,
    diagnosticCount: diagnostics.length,
    healthyProjectionCount,
    skillCount: skills.length,
    targetCount: targets.length,
    unhealthyProjectionCount: projections.length - healthyProjectionCount,
    unmanagedEntryCount: unmanagedEntries.length,
  };
};

export const loadSkillManagementSnapshot = async (
  input: LoadSkillManagementSnapshotInput,
): Promise<SkillManagementSnapshot> => {
  const config = input.config.skills === undefined ? {} : parseSkillConfigInput(input.config.skills);
  if (config.sourceRepoPath === undefined) {
    return emptySkillManagementSnapshot(config);
  }

  const sourceState = await loadSkillSourceState(config.sourceRepoPath);
  const sourceScanOptions: SourceSkillScanOptions = {};
  if (config.tokenThresholds !== undefined) {
    sourceScanOptions.tokenThresholds = config.tokenThresholds;
  }
  const sourceScan = await scanSkillSourceRepository({
    options: sourceScanOptions,
    sourceRepoPath: config.sourceRepoPath,
    state: sourceState.state,
  });
  const targets = await observeSkillTargets(buildConfiguredSkillTargets(config, input.homePath));
  const projectionScan = await scanTargetProjections({ skills: sourceScan.skills, targets });
  const diagnostics = [...sourceState.diagnostics, ...sourceScan.diagnostics, ...projectionScan.diagnostics];

  return {
    config,
    configured: true,
    diagnostics,
    nativeRuleFindings: [],
    projections: projectionScan.projections,
    skills: sourceScan.skills,
    sourceState: sourceState.state,
    summary: snapshotSummary(
      sourceScan.skills,
      targets,
      projectionScan.projections,
      projectionScan.unmanagedEntries,
      diagnostics,
    ),
    targets,
    unmanagedEntries: projectionScan.unmanagedEntries,
  };
};

export const writeSkillManagementConfig = async (
  input: WriteSkillManagementConfigInput,
): Promise<SkillManagementConfigDocument> => {
  const skills = parseSkillConfigInput(input.skills);
  const nextConfig: SkillManagementConfigDocument = {
    ...input.config,
    skills,
  };
  await input.writeConfig(nextConfig);
  return nextConfig;
};

export const toggleSkillEnabled = async (input: ToggleSkillEnabledInput): Promise<SkillSourceState> =>
  setSkillEnabled(input.sourceRepoPath, input.skillName, input.enabled);

const applyPlannedActions = async (
  snapshot: SkillManagementSnapshot,
  predicate: (skill: SourceSkill) => boolean,
): Promise<SkillReconcileResult> => {
  const actions: ProjectionAction[] = [];
  for (const skill of snapshot.skills.filter(predicate)) {
    for (const target of snapshot.targets.filter((candidate) => candidate.enabled)) {
      const projection = snapshot.projections.find(
        (candidate) => candidate.skillName === skill.name && candidate.targetId === target.id,
      );
      const action = planProjection(skill, target, projection);
      if (action.type !== 'noop') {
        actions.push(action);
      }
    }
  }

  if (actions.some((action) => action.type === 'refuse-unmanaged-mutation')) {
    return { actions, snapshot };
  }

  for (const action of actions) {
    await applyProjectionAction(action);
  }
  return { actions, snapshot };
};

export const reconcileSkill = async (input: ReconcileSkillInput): Promise<SkillReconcileResult> => {
  const skillName = parseSkillName(input.skillName);
  const snapshot = await loadSkillManagementSnapshot(input);
  return applyPlannedActions(snapshot, (skill) => skill.name === skillName);
};

export const reconcileAllActiveSkills = async (
  input: LoadSkillManagementSnapshotInput,
): Promise<SkillReconcileResult> => {
  const snapshot = await loadSkillManagementSnapshot(input);
  return applyPlannedActions(snapshot, (skill) => skill.enabled && skill.validationStatus === 'valid');
};

export const createSkillTargetDirectory = async (input: CreateSkillTargetDirectoryInput): Promise<void> => {
  const targetPath = parseRequiredNonEmptyString(input.path, 'target path');
  await mkdir(targetPath, { recursive: true });
};
