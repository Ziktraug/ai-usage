import type {
  ProjectionAction,
  ProjectSkillInventory,
  SkillManagementConfig,
  SkillManagementSnapshot,
  SkillMarkdownDocument,
  SkillMarkdownWriteInput,
  SkillTargetDirectoryInput,
  SkillToggleInput,
} from '@ai-usage/skills';
import type { ProjectRuntimeDirId } from '../project-skill-directories';

export type SkillsServerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        message: string;
        tag: string;
      };
    };

export interface SkillReconcileServerResult {
  actions: readonly ProjectionAction[];
  snapshot: SkillManagementSnapshot;
}

export interface ProjectSkillMarkdownInput {
  projectPath: string;
  runtimeDirId: ProjectRuntimeDirId;
  skillName: string;
}

export interface ProjectSkillMarkdownDocument {
  content: string;
  path: string;
  skillName: string;
  truncated: boolean;
}

export interface KnownSkillProjectPath {
  groupId?: string;
  groupLabel?: string;
  label: string;
  machineLabel?: string;
  path: string;
  project: string;
  sessions: number;
}

export interface SkillMarkdownSaveResult {
  document?: SkillMarkdownDocument;
  reason?: 'conflict' | 'not-found' | 'too-large';
  snapshot?: SkillManagementSnapshot;
}

export type SkillsServerAdapterResult<T> = Promise<SkillsServerResult<T>> | SkillsServerResult<T>;

export interface SkillsServerAdapter {
  createTargetDirectory: (input: SkillTargetDirectoryInput) => SkillsServerAdapterResult<SkillManagementSnapshot>;
  previewReconcileAll: () => SkillsServerAdapterResult<SkillReconcileServerResult>;
  readKnownProjectPaths: () => SkillsServerAdapterResult<readonly KnownSkillProjectPath[]>;
  readMarkdown: (skillName: string) => SkillsServerAdapterResult<SkillMarkdownDocument>;
  readProjectInventories: () => SkillsServerAdapterResult<readonly ProjectSkillInventory[]>;
  readProjectMarkdown: (input: ProjectSkillMarkdownInput) => SkillsServerAdapterResult<ProjectSkillMarkdownDocument>;
  readSnapshot: () => SkillsServerAdapterResult<SkillManagementSnapshot>;
  reconcileAll: () => SkillsServerAdapterResult<SkillReconcileServerResult>;
  reconcileSkill: (skillName: string) => SkillsServerAdapterResult<SkillReconcileServerResult>;
  refreshSnapshot: () => SkillsServerAdapterResult<SkillManagementSnapshot>;
  saveConfig: (config: SkillManagementConfig) => SkillsServerAdapterResult<SkillManagementSnapshot>;
  saveMarkdown: (input: SkillMarkdownWriteInput) => SkillsServerAdapterResult<SkillMarkdownSaveResult>;
  toggleSkill: (input: SkillToggleInput) => SkillsServerAdapterResult<SkillReconcileServerResult>;
}
