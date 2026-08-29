import type { SkillManagementSnapshot } from '@ai-usage/skills';
import type {
  ProjectSkillMarkdownDocument,
  SkillMarkdownDocument,
  SkillObservations,
} from '@ai-usage/web-contract/skills';
import type { SkillsShellViewModel } from './model';
import type { SkillsDraftGuardPort } from './snapshot-controller';

export type SkillsHealthSlotPlacement = 'detail' | 'inspector';

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
  /**
   * The skill-observation dataset, on its own query identity and its own collection cadence.
   * `undefined` means "not read yet", which is why it is not the same thing as an empty dataset.
   */
  readonly observations: SkillObservations | undefined;
  /** Set when the observation read failed. Reported per metric, never as a page-level banner. */
  readonly observationsError: string | undefined;
  readonly snapshot: SkillManagementSnapshot;
  readonly snapshotUpdates: SkillsSnapshotUpdatePort;
  readonly view: SkillsShellViewModel;
}
