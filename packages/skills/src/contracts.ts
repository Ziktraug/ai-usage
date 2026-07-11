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
  projectPaths?: readonly string[];
  projectsRootPath?: string;
  sourceRepoPath?: string;
  targets?: Record<string, SkillManagementTargetConfig>;
  tokenThresholds?: SkillTokenThresholds;
}

export interface SkillSourceState {
  skillEnabledByName: Record<string, boolean>;
  skillOriginByName?: Record<string, string>;
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
      type: 'create-symlink';
    }
  | {
      observedSourcePath: string;
      path: string;
      skillName: string;
      sourcePath: string;
      targetId: string;
      type: 'repair-symlink' | 'unlink-managed-symlink';
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
  maxRuntimeEntries?: number;
  maxSkills?: number;
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

export const projectSkillDirectories = [
  { id: 'claude-project', label: 'Claude Code', relativePath: '.claude/skills' },
  { id: 'agents-project', label: 'Standard Agents', relativePath: '.agents/skills' },
] as const;

export type ProjectSkillPlacement = 'owned-directory' | 'symlink-to-source' | 'project-symlink' | 'external-symlink';

export interface ProjectSkillObservation {
  description: string;
  diagnostics: readonly SkillDiagnostic[];
  invocation: 'auto' | 'manual';
  markdownReadable: boolean;
  name: string;
  path: string;
  placement: ProjectSkillPlacement;
  runtimeDirId: (typeof projectSkillDirectories)[number]['id'];
  skillMdPath: string;
  tokenCount?: SourceSkill['tokenCount'];
  validationStatus: SkillValidationStatus;
}

export interface ProjectSkillInventory {
  diagnostics: readonly SkillDiagnostic[];
  observations: readonly ProjectSkillObservation[];
  projectPath: string;
}

export interface SkillMarkdownDocument {
  content: string;
  path: string;
  sha256: string;
  skillName: string;
}

export interface SkillMarkdownWriteInput {
  baseSha256: string;
  content: string;
  skillName: string;
}

export const defaultTokenThresholds: SkillTokenThresholds = {
  referenceFile: { warn: 5000, high: 12_000 },
  skillMd: { warn: 2000, high: 5000 },
  totalSkill: { warn: 8000, high: 20_000 },
};

export const maxSkillMarkdownBytes = 262_144;
