import { untrack } from 'svelte';
import type { DelegationPageClient, DelegationSaveOutcome, DelegationSaveSettingsInput } from './delegation-contract';
import { type DraftResolution, rebaseDraft, sameDraft } from './delegation-rebase';

export interface DraftSyncOptions<Draft> {
  /** The draft the current settings would produce. */
  readonly from: () => Draft;
  /** The settings revision; a new one re-reads the draft unless the operator has edits. */
  readonly revision: () => string;
}

/**
 * One form's draft beside the settings it came from, bound to the revision it was read from (its
 * base): a save carries `baseRevision`, so a newer revision never silently authorises writing an
 * older draft. The draft follows the settings until the operator edits it. From then on a refetch
 * keeps it: when the new revision changed nothing this form writes, the draft is rebound to it
 * silently (nothing it would write moved); otherwise it goes stale — no save is possible until the
 * operator discards the edits or re-applies them onto the latest. A save carries a `snapshot()`;
 * once written, `settle` rebinds the draft to what was saved, so an edit made while the save was
 * pending stays an edit. Call from a component's script so the effect belongs to it.
 */
export const createDraftSync = <Draft>(options: DraftSyncOptions<Draft>) => {
  let draft = $state<Draft>(untrack(options.from));
  /** What the settings said at `baseRevision`: the merge base of a re-apply. Nothing renders it. */
  let base: Draft = untrack(options.from);
  let baseRevision = $state(untrack(options.revision));
  let seenRevision = untrack(options.revision);
  let dirty = $state(false);
  let stale = $state(false);
  let resolution = $state<DraftResolution | null>(null);

  const adopt = (revision: string): void => {
    base = untrack(options.from);
    draft = untrack(options.from);
    baseRevision = revision;
    seenRevision = revision;
    stale = false;
  };

  $effect(() => {
    const revision = options.revision();
    if (revision === seenRevision) {
      return;
    }
    seenRevision = revision;
    if (!dirty) {
      adopt(revision);
      return;
    }
    if (sameDraft(untrack(options.from), base)) {
      baseRevision = revision;
      stale = false;
    } else {
      stale = true;
    }
  });

  return {
    /** The revision the draft was read from; what a save sends as `expectedRevision`. */
    get baseRevision(): string {
      return baseRevision;
    },
    get dirty(): boolean {
      return dirty;
    },
    get draft(): Draft {
      return draft;
    },
    set draft(value: Draft) {
      draft = value;
    },
    /** The last re-apply, until the edits are saved or discarded. */
    get resolution(): DraftResolution | null {
      return resolution;
    },
    /** The settings moved on in what this form writes while the draft was dirty: it cannot be saved as is. */
    get stale(): boolean {
      return stale;
    },
    /** The operator typed or changed something: the draft now outlives refetches. */
    markDirty(): void {
      dirty = true;
    },
    /**
     * Re-applies the operator's edits (relative to the base) onto the latest settings and binds the
     * draft to their revision. Fields both sides changed keep the latest value and are named.
     */
    reapply(): DraftResolution {
      const revision = untrack(options.revision);
      const rebased = rebaseDraft(base, $state.snapshot(draft) as Draft, untrack(options.from));
      base = untrack(options.from);
      draft = rebased.draft;
      baseRevision = revision;
      seenRevision = revision;
      stale = false;
      dirty = !sameDraft(rebased.draft, base);
      resolution = { conflicts: rebased.conflicts, revision };
      return resolution;
    },
    /** Back to what the settings say. */
    reset(): void {
      dirty = false;
      resolution = null;
      adopt(untrack(options.revision));
    },
    /**
     * A save of `saved` was written and produced `revision`: the draft is rebound to it (the refetch
     * that follows re-reads it, parsed and dated). An edit made while the save was pending keeps the
     * form dirty, relative to what was saved: the refetch keeps it, or names the draft stale when
     * the settings moved in what this form writes — it is never replaced silently.
     */
    settle(saved: Draft, revision: string): void {
      base = saved;
      baseRevision = revision;
      stale = false;
      resolution = null;
      dirty = !sameDraft($state.snapshot(draft), saved);
    },
    /** The draft as a plain copy: what a save carries, and what `settle` compares the live draft to. */
    snapshot(): Draft {
      return $state.snapshot(draft) as Draft;
    },
  };
};

/** A save that was written: what it carried is now the configuration at `revision`. */
export interface WrittenSave<Saved> {
  readonly revision: string;
  readonly saved: Saved;
}

/**
 * One save at a time per form, with the outcome the notice renders. A written save asks the page
 * to refetch, so every form sees the new revision; the draft that was saved settles on it.
 */
export const createSaveEpisode = <Saved>(options: {
  readonly client: () => DelegationPageClient | null;
  readonly onWritten: (written: WrittenSave<Saved>) => Promise<void>;
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
    /** Saves `input`, built from `saved` (the draft's snapshot at this moment). */
    async run(input: DelegationSaveSettingsInput, saved: Saved): Promise<DelegationSaveOutcome> {
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
          await options.onWritten({ revision: result.revision, saved });
        }
        return result;
      } finally {
        pending = false;
      }
    },
  };
};
