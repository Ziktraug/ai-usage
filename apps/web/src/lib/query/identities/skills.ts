import type { ProjectSkillMarkdownInput } from '@ai-usage/web-contract/skills';
import type { SkillsClientResult } from '../../rpc/skills-client';
import { type CollectionSwrQueryKey, collectionSwrKey, type FiniteSwrQueryKey, finiteSwrKey } from '../keys';

export class SkillsQueryError extends Error {
  readonly tag: string;

  constructor(error: { readonly message: string; readonly tag: string }) {
    super(error.message);
    this.name = 'SkillsQueryError';
    this.tag = error.tag;
  }
}

export const unwrapSkillsQueryResult = <Value>(result: SkillsClientResult<Value>): Value => {
  if (!result.ok) {
    throw new SkillsQueryError(result.error);
  }
  return result.data;
};

export const skillsSnapshotKey = (): FiniteSwrQueryKey => finiteSwrKey('skills', 'snapshot');

export const skillsKnownProjectPathsKey = (): FiniteSwrQueryKey => finiteSwrKey('skills', 'known-project-paths');

export const skillsProjectInventoriesKey = (): FiniteSwrQueryKey => finiteSwrKey('skills', 'project-inventories');

/**
 * A separate identity from the skills snapshot, on a separate cadence prefix. Observations are
 * produced by the engine's collection cycle; the snapshot is produced by scanning the filesystem
 * on request. Sharing one key would make either invalidation lie about the other.
 */
export const skillObservationsKey = (): CollectionSwrQueryKey => collectionSwrKey('skill-observations', 'all');

export const managedSkillMarkdownKey = (skillName: string): FiniteSwrQueryKey =>
  finiteSwrKey('skills', 'markdown', 'scope', 'managed', 'skill', skillName);

export const projectSkillMarkdownKey = ({
  projectPath,
  runtimeDirId,
  skillName,
}: ProjectSkillMarkdownInput): FiniteSwrQueryKey =>
  finiteSwrKey(
    'skills',
    'markdown',
    'scope',
    'project',
    'project-path',
    projectPath,
    'runtime-dir',
    runtimeDirId,
    'skill',
    skillName,
  );
