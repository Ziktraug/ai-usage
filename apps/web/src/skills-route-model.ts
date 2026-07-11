import type { SkillManagementSnapshot } from '@ai-usage/skills';
import type { SkillMarkdownDraftGuard } from './skills-workspace';

export const snapshotRemovesDirtySkill = (
  nextSnapshot: SkillManagementSnapshot,
  dirtyDraft: Pick<SkillMarkdownDraftGuard, 'dirty' | 'skillName'> | undefined,
): boolean => dirtyDraft?.dirty === true && !nextSnapshot.skills.some((skill) => skill.name === dirtyDraft.skillName);
