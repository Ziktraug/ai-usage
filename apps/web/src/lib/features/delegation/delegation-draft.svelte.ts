import { untrack } from 'svelte';
import type { DelegationPageClient, DelegationSaveOutcome, DelegationSaveSettingsInput } from './delegation-contract';

export interface DraftSyncOptions<Draft> {
  /** The draft the current settings would produce. */
  readonly from: () => Draft;
  /** The settings revision; a new one re-reads the draft unless the operator has edits. */
  readonly revision: () => string;
}

/**
 * One form's draft beside the settings it came from. The draft follows the settings until the
 * operator edits it; from then on it is kept across refetches (a conflict says "your edits are kept
 * below"), until a save succeeds or the edits are discarded. Call from a component's script so the
 * effect belongs to it.
 */
export const createDraftSync = <Draft>(options: DraftSyncOptions<Draft>) => {
  let draft = $state<Draft>(untrack(options.from));
  let dirty = $state(false);
  let seenRevision = untrack(options.revision);

  $effect(() => {
    const revision = options.revision();
    if (revision === seenRevision) {
      return;
    }
    seenRevision = revision;
    if (!dirty) {
      draft = options.from();
    }
  });

  return {
    get dirty(): boolean {
      return dirty;
    },
    get draft(): Draft {
      return draft;
    },
    set draft(value: Draft) {
      draft = value;
    },
    /** The operator typed or changed something: the draft now outlives refetches. */
    markDirty(): void {
      dirty = true;
    },
    /** Back to what the settings say. */
    reset(): void {
      dirty = false;
      draft = options.from();
    },
    /** A save was written: the next refetched revision re-reads the draft (parsed, dated). */
    settle(): void {
      dirty = false;
    },
  };
};

/**
 * One save at a time per form, with the outcome the notice renders. A written save asks the page
 * to refetch, so every form sees the new revision; the draft that was saved settles on it.
 */
export const createSaveEpisode = (options: {
  readonly client: () => DelegationPageClient | null;
  readonly onWritten: () => Promise<void>;
}) => {
  let outcome = $state<DelegationSaveOutcome | null>(null);
  let pending = $state(false);

  return {
    clear(): void {
      outcome = null;
    },
    get outcome(): DelegationSaveOutcome | null {
      return outcome;
    },
    get pending(): boolean {
      return pending;
    },
    async run(input: DelegationSaveSettingsInput): Promise<DelegationSaveOutcome> {
      const client = options.client();
      if (pending) {
        return { kind: 'unavailable', message: 'A save is already in progress.', tag: 'Busy' };
      }
      if (client === null) {
        const unavailable: DelegationSaveOutcome = {
          kind: 'unavailable',
          message: 'Saving is unavailable in this runtime.',
          tag: 'Unavailable',
        };
        outcome = unavailable;
        return unavailable;
      }
      pending = true;
      outcome = null;
      try {
        const result = await client.saveSettings(input);
        outcome = result;
        if (result.kind === 'written') {
          await options.onWritten();
        }
        return result;
      } finally {
        pending = false;
      }
    },
  };
};
