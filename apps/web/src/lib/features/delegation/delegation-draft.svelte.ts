import { untrack } from 'svelte';
import type { DelegationPageClient, DelegationSaveOutcome, DelegationSaveSettingsInput } from './delegation-contract';
import { type DraftResolution, type EntryIdentity, keyIdentity, rebaseDraft, sameWritten } from './delegation-rebase';

/**
 * A plain deep copy of a draft (arrays, plain objects, primitives: settings JSON), read through
 * Svelte's state proxies. `$state.snapshot` does the same but imports the runtime's clone
 * warnings, which Rollup places in the shared runtime chunk every page downloads, the report's
 * first load included.
 */
const plainCopy = <Value>(value: Value): Value => {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => plainCopy(entry)) as Value;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainCopy(entry)])) as Value;
  }
  return value;
};

export interface DraftSyncOptions<Draft> {
  /** The draft the current settings would produce. */
  readonly from: () => Draft;
  /**
   * The key the settings give an entry of the draft's keyed lists once saved and re-read; by
   * default its own key. A form whose operator adds entries under counter keys names the identity
   * they are keyed by once saved, so an edit made to such an entry meets its saved view.
   */
  readonly identity?: EntryIdentity;
  /** The settings revision; a new one re-reads the draft unless the operator has edits. */
  readonly revision: () => string;
}

/** A save that was written: what it carried is now the configuration at `revision`. */
export interface WrittenSave<Saved> {
  /** The revision the save was built on, what it sent as `expectedRevision`. */
  readonly expectedRevision: string;
  readonly revision: string;
  readonly saved: Saved;
}

/**
 * One form's draft beside the settings it came from, bound to the revision it was read from (its
 * base): a save carries `baseRevision`, so a newer revision never silently authorises writing an
 * older draft. The draft follows the settings until the operator edits it. From then on a refetch
 * keeps it: when the new revision changed nothing this form writes, the draft is rebound to it
 * silently (nothing it would write moved; what the settings own — keys, dates — is taken from
 * them); otherwise it goes stale — no save is possible until the operator discards the edits or
 * re-applies them onto the latest. A save carries a `snapshot()`; once written, `settle` rebinds
 * the draft to what was saved and reconciles it with whatever the settings say by then, so an edit
 * made while the save was pending stays an edit. Call from a component's script so the effect
 * belongs to it.
 */
export const createDraftSync = <Draft>(options: DraftSyncOptions<Draft>) => {
  const identity = options.identity ?? keyIdentity;
  let draft = $state<Draft>(untrack(options.from));
  /** What the settings said at `baseRevision`, keyed as the draft is: the merge base of a re-apply. Nothing renders it. */
  let base: Draft = untrack(options.from);
  let baseRevision = $state(untrack(options.revision));
  /** The settings revision the draft was last bound beside; a stale draft keeps the one it was read at. */
  let loadedRevision = untrack(options.revision);
  let dirty = $state(false);
  let stale = $state(false);
  let resolution = $state<DraftResolution | null>(null);

  const adopt = (revision: string): void => {
    base = untrack(options.from);
    draft = untrack(options.from);
    baseRevision = revision;
    loadedRevision = revision;
    stale = false;
  };

  /**
   * The settings at `revision` changed nothing this form writes: the draft keeps its edits and
   * takes what the settings own (an entry the operator added keeps its key, so the form keeps
   * rendering it). Nothing is decided: with equal bases there is nothing to conflict on. The base
   * is the latest keyed as the draft is, so the next merge matches the operator's entries by key.
   */
  const rebind = (latest: Draft, revision: string): void => {
    const rebased = rebaseDraft(base, plainCopy(draft), latest, identity);
    if (rebased.conflicts.length > 0) {
      stale = true;
      return;
    }
    draft = rebased.draft;
    base = rebased.base;
    baseRevision = revision;
    loadedRevision = revision;
    stale = false;
    dirty = !sameWritten(rebased.draft, latest);
  };

  /** The settings are at `revision` now: adopted when the draft is clean, kept (rebound or stale) when dirty. */
  const reconcile = (revision: string): void => {
    if (!dirty) {
      adopt(revision);
      return;
    }
    const latest = untrack(options.from);
    if (sameWritten(latest, base)) {
      rebind(latest, revision);
    } else {
      stale = true;
    }
  };

  $effect(() => {
    const revision = options.revision();
    if (revision !== loadedRevision) {
      reconcile(revision);
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
     * draft to their revision. Fields both sides changed keep the latest value and are named. The
     * base is the latest keyed as the draft is, so the next merge matches the operator's entries
     * by key.
     */
    reapply(): DraftResolution {
      const revision = untrack(options.revision);
      const latest = untrack(options.from);
      const rebased = rebaseDraft(base, plainCopy(draft), latest, identity);
      base = rebased.base;
      draft = rebased.draft;
      baseRevision = revision;
      loadedRevision = revision;
      stale = false;
      dirty = !sameWritten(rebased.draft, base);
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
     * A save was written: the draft is rebound to what it carried, at the revision it produced. An
     * edit made while the save was pending keeps the form dirty, relative to what was saved. The
     * draft is then reconciled with the settings loaded by now, as a refetch would: the one the
     * save followed re-reads what was saved (keyed and dated by the settings); one that landed
     * while the save was pending — its own revision seen early, or a later one — is adopted when
     * the draft is clean and keeps the draft, rebound or stale, when it is dirty. A draft a refetch
     * already adopted or rebound while the save was pending is left as it is: what it holds is
     * relative to settings that include the save.
     */
    settle({ expectedRevision, revision, saved }: WrittenSave<Draft>): void {
      resolution = null;
      if (baseRevision !== expectedRevision) {
        return;
      }
      base = saved;
      baseRevision = revision;
      stale = false;
      dirty = !sameWritten(plainCopy(draft), saved);
      const loaded = untrack(options.revision);
      if (loaded !== loadedRevision) {
        reconcile(loaded);
      }
    },
    /** The draft as a plain copy: what a save carries, and what `settle` compares the live draft to. */
    snapshot(): Draft {
      return plainCopy(draft);
    },
  };
};

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
          await options.onWritten({ expectedRevision: input.expectedRevision, revision: result.revision, saved });
        }
        return result;
      } finally {
        pending = false;
      }
    },
  };
};
