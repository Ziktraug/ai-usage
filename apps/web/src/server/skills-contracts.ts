import type { ProjectionAction, SkillManagementSnapshot, SkillMarkdownDocument } from '@ai-usage/skills';
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
