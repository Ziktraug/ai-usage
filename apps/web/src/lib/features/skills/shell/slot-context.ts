import type { SkillManagementSnapshot } from '@ai-usage/skills';
import type { ProjectSkillMarkdownDocument, SkillMarkdownDocument } from '@ai-usage/web-contract/skills';
import type { SkillsManagementOperationEpisodePort } from '../management/operation-episode.svelte';
import type { SkillsPresentationProjection } from '../presentation';
import type { SkillsShellViewModel } from './model';
import type { SkillsDraftGuardPort } from './snapshot-controller';

export interface SkillsPendingSnapshotDecision {
  readonly discard: () => Promise<boolean>;
  readonly focus: () => void;
  readonly keep: () => void;
  readonly snapshot: SkillManagementSnapshot;
}

export interface SkillsSnapshotUpdatePort {
  readonly pendingDecision: SkillsPendingSnapshotDecision | undefined;
  readonly registerDraft: (guard: SkillsDraftGuardPort) => void;
  readonly unregisterDraft: (guard: SkillsDraftGuardPort) => void;
}

/**
 * Frozen P5 composition seam. P9 owns the draft guard and pending-decision UI;
 * P10 owns management actions that publish snapshots back through Query.
 */
export interface SkillsShellSlotContext {
  readonly document: ProjectSkillMarkdownDocument | SkillMarkdownDocument | undefined;
  /** One shell-lived Query mutation episode shared by every management presentation. */
  readonly management: SkillsManagementOperationEpisodePort;
  /** Joined immutable presentation facts derived once from the accepted Query results. */
  readonly presentation: SkillsPresentationProjection;
  readonly snapshot: SkillManagementSnapshot;
  readonly snapshotUpdates: SkillsSnapshotUpdatePort;
  readonly view: SkillsShellViewModel;
}
