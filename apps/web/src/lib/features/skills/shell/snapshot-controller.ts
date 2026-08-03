import type { SkillManagementSnapshot } from '@ai-usage/skills';

export interface SkillsDraftGuardPort {
  readonly dirty: boolean;
  readonly discard: () => Promise<void> | void;
  readonly focus: () => void;
  readonly skillName: string;
}

export interface SkillsSnapshotController {
  readonly apply: (snapshot: SkillManagementSnapshot) => 'applied' | 'deferred';
  readonly current: () => SkillManagementSnapshot;
  readonly discardPending: () => Promise<boolean>;
  readonly focusDraft: () => void;
  readonly pending: () => SkillManagementSnapshot | undefined;
  readonly registerDraft: (guard: SkillsDraftGuardPort) => void;
  readonly retainCurrent: () => void;
  readonly unregisterDraft: (guard: SkillsDraftGuardPort) => void;
}

export const createSkillsSnapshotController = (input: {
  readonly initial: SkillManagementSnapshot;
  readonly onCommit: (snapshot: SkillManagementSnapshot) => void;
}): SkillsSnapshotController => {
  let current = input.initial;
  let dirtyDraft: SkillsDraftGuardPort | undefined;
  let pending: SkillManagementSnapshot | undefined;
  const commit = (snapshot: SkillManagementSnapshot): void => {
    current = snapshot;
    pending = undefined;
    input.onCommit(snapshot);
  };
  return {
    apply: (snapshot) => {
      const removesDirtySkill =
        dirtyDraft?.dirty === true && !snapshot.skills.some((skill) => skill.name === dirtyDraft?.skillName);
      if (removesDirtySkill) {
        pending = snapshot;
        return 'deferred';
      }
      commit(snapshot);
      return 'applied';
    },
    current: () => current,
    discardPending: async () => {
      if (pending === undefined) {
        return false;
      }
      const next = pending;
      pending = undefined;
      const discardedDraft = dirtyDraft;
      await discardedDraft?.discard();
      if (dirtyDraft === discardedDraft) {
        dirtyDraft = undefined;
      }
      commit(next);
      return true;
    },
    focusDraft: () => {
      dirtyDraft?.focus();
    },
    pending: () => pending,
    registerDraft: (guard) => {
      dirtyDraft = guard;
    },
    retainCurrent: () => {
      pending = undefined;
    },
    unregisterDraft: (guard) => {
      if (dirtyDraft === guard) {
        dirtyDraft = undefined;
      }
    },
  };
};
