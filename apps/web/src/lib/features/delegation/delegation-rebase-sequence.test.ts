import { describe, expect, test } from 'bun:test';
import { type DraftConflict, type EntryIdentity, rebaseDraft, sameDraft, sameWritten } from './delegation-rebase';

/**
 * Random sequences of edits on both sides of a keyed list, merged as the draft sync merges them
 * (`base = rebased.base`, `draft = rebased.draft`; an own save makes the draft the base), checked
 * after every merge for what the forms rely on: unique keys, a base keyed like the draft, no
 * operator edit lost without a named conflict, and no conflict without an operator change behind
 * it. The harness throws with the sequence that broke an invariant; the test asserts nothing threw.
 */

/** An entry as the keyed forms draft it: two fields the operator writes, a key and the settings' view. */
interface Entry {
  alias: string;
  id: string;
  key: string;
  note: string;
  original: { declaredAt: string } | null;
}

type Field = 'alias' | 'id' | 'note';

/** What the settings hold for an entry: what the other client edits. */
interface Stored {
  alias: string;
  id: string;
  note: string;
}

const identity: EntryIdentity = (entry) =>
  'id' in entry && typeof entry.id === 'string' && entry.id.length > 0 ? `entry/${entry.id}` : entry.key;

const DECLARED_AT = '2026-10-25T12:00:00.000Z';
const read = (stored: Stored): Entry => ({
  ...stored,
  key: `entry/${stored.id}`,
  original: { declaredAt: DECLARED_AT },
});
/** Few ids, so renames and additions on both sides meet. */
const ID_POOL = ['a', 'b', 'c', 'd', 'e'];
const FIELDS: readonly Field[] = ['alias', 'note'];

/** Park–Miller's generator (exact in doubles), seeded so a failing sequence is reproducible from its seed. */
const random = (seed: number): (() => number) => {
  const modulus = 2_147_483_647;
  let state = seed % modulus;
  return () => {
    state = (state * 16_807) % modulus;
    return state / modulus;
  };
};

const keysOf = (entries: readonly Entry[]): string[] => entries.map((entry) => entry.key);
const byKey = (entries: readonly Entry[]): Map<string, Entry> => new Map(entries.map((entry) => [entry.key, entry]));
const baseEntryNamed = (base: ReadonlyMap<string, Entry>, path: string): Entry | undefined =>
  [...base.values()].find((entry) => identity(entry) === path);
const isField = (value: string): value is Field => value === 'alias' || value === 'id' || value === 'note';

interface Sides {
  readonly base: Map<string, Entry>;
  readonly draft: Map<string, Entry>;
}

/** One operator beside another client, with the merge state the draft sync would hold. */
class Session {
  private readonly next: () => number;
  private readonly log: string[] = [];
  private settings: Stored[];
  private base: Entry[];
  private draft: Entry[];
  /**
   * The operator's edits since the base, by the entry's key: what a merge must keep or name. A base
   * entry under a key the draft lacks is one the operator removed (or renamed away from, as far as
   * the base knows): a change elsewhere to it is a named conflict.
   */
  private readonly edits = new Map<string, Map<Field, string>>();
  private counter = 0;
  private tick = 0;
  merges = 0;

  constructor(seed: number, initial: readonly Stored[]) {
    this.next = random(seed);
    this.settings = initial.map((stored) => ({ ...stored }));
    this.base = initial.map(read);
    this.draft = initial.map(read);
  }

  private pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[Math.floor(this.next() * items.length)];
  }

  private freshId(taken: ReadonlySet<string>): string | undefined {
    return this.pick(ID_POOL.filter((id) => !taken.has(id)));
  }

  private draftIds(): Set<string> {
    return new Set(this.draft.map((entry) => entry.id));
  }

  private record(key: string, field: Field, value: string): void {
    const fields = this.edits.get(key) ?? new Map<Field, string>();
    fields.set(field, value);
    this.edits.set(key, fields);
  }

  private ensure(condition: boolean, what: string): void {
    if (!condition) {
      throw new Error(`${what}\n  ${this.log.join('\n  ')}`);
    }
  }

  operatorEdits(): void {
    const entry = this.pick(this.draft);
    const field = this.pick(FIELDS);
    if (entry === undefined || field === undefined) {
      return;
    }
    const value = `${field}-${++this.tick}`;
    entry[field] = value;
    this.record(entry.key, field, value);
    this.log.push(`operator sets ${entry.key}.${field} = ${value}`);
  }

  operatorRenames(): void {
    const entry = this.pick(this.draft);
    const id = this.freshId(this.draftIds());
    if (entry === undefined || id === undefined) {
      return;
    }
    this.log.push(`operator renames ${entry.key} (${entry.id}) to ${id}`);
    entry.id = id;
    this.record(entry.key, 'id', id);
  }

  operatorAdds(): void {
    const id = this.freshId(this.draftIds());
    if (id === undefined) {
      return;
    }
    const key = `new-${++this.counter}`;
    this.draft.push({ alias: '', id, key, note: '', original: null });
    // The id is what the operator typed; the blank fields are defaults, not values to keep.
    this.record(key, 'id', id);
    this.log.push(`operator adds ${key} as ${id}`);
  }

  operatorRemoves(): void {
    const entry = this.pick(this.draft);
    if (entry === undefined) {
      return;
    }
    this.draft = this.draft.filter((candidate) => candidate !== entry);
    this.edits.delete(entry.key);
    this.log.push(`operator removes ${entry.key} (${entry.id})`);
  }

  theirsEdits(): void {
    const stored = this.pick(this.settings);
    const field = this.pick(FIELDS);
    if (stored === undefined || field === undefined) {
      return;
    }
    stored[field] = `${field}-theirs-${++this.tick}`;
    this.log.push(`elsewhere ${stored.id}.${field} = ${stored[field]}`);
  }

  theirsRenames(): void {
    const stored = this.pick(this.settings);
    const id = this.freshId(new Set(this.settings.map((entry) => entry.id)));
    if (stored === undefined || id === undefined) {
      return;
    }
    this.log.push(`elsewhere ${stored.id} renamed to ${id}`);
    stored.id = id;
  }

  theirsAdds(): void {
    const id = this.freshId(new Set(this.settings.map((entry) => entry.id)));
    if (id === undefined) {
      return;
    }
    this.settings.push({ alias: '', id, note: '' });
    this.log.push(`elsewhere ${id} added`);
  }

  theirsRemoves(): void {
    const stored = this.pick(this.settings);
    if (stored === undefined) {
      return;
    }
    this.settings = this.settings.filter((candidate) => candidate !== stored);
    this.log.push(`elsewhere ${stored.id} removed`);
  }

  /** A re-apply (or a rebind) onto the latest settings. */
  reapply(): void {
    this.log.push('re-apply');
    this.merge();
  }

  /**
   * An own save, then the re-read that follows it. The draft sync adopts the re-read as the
   * settings key it when the draft is clean by then; a draft edited while the save was pending is
   * rebound to it: nothing to name, and the form keeps its keys.
   */
  save(): void {
    const ids = this.draft.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      return;
    }
    this.log.push('own save');
    this.settings = this.draft.map(({ alias, id, note }) => ({ alias, id, note }));
    this.base = structuredClone(this.draft);
    this.edits.clear();
    const pending = this.next();
    if (pending < 0.3) {
      this.operatorEdits();
    } else if (pending < 0.5) {
      this.operatorRenames();
    } else if (pending < 0.65) {
      this.operatorAdds();
    }
    if (sameWritten(this.draft, this.base)) {
      this.log.push('re-read adopted');
      this.base = this.settings.map(read);
      this.draft = this.settings.map(read);
      this.checkInvariants();
      return;
    }
    const keysBefore = keysOf(this.draft);
    const conflicts = this.merge();
    this.ensure(conflicts.length === 0, 'the own re-read named a conflict');
    this.ensure(sameDraft(keysOf(this.draft), keysBefore), 'the own re-read re-keyed an entry');
  }

  private merge(): readonly DraftConflict[] {
    this.merges += 1;
    const latest = this.settings.map(read);
    const before: Sides = { base: byKey(this.base), draft: byKey(this.draft) };
    const rebased = rebaseDraft(this.base, structuredClone(this.draft), latest, identity);
    this.base = rebased.base;
    // The sync holds the draft as `$state`, whose proxy never writes to the object it wraps: an
    // edit made in the form cannot reach the base, even where the merge returned the latest as both.
    this.draft = structuredClone(rebased.draft);
    this.checkEdits(rebased.conflicts, before);
    this.checkInvariants();
    this.checkIdempotent(latest);
    return rebased.conflicts;
  }

  /** Every operator edit is kept or named; every conflict has an operator change behind it. */
  private checkEdits(conflicts: readonly DraftConflict[], before: Sides): void {
    const draft = byKey(this.draft);
    const base = byKey(this.base);
    this.absorb(before.base);
    for (const [key, fields] of this.edits) {
      const was = before.draft.get(key);
      this.ensure(was !== undefined, `an edit is tracked for ${key}, which the draft did not hold`);
      const row = draft.get(key);
      if (row === undefined) {
        this.ensureVanishedIsNamed(key, was as Entry, conflicts, before);
        continue;
      }
      const baseRow = base.get(key);
      for (const [field, value] of fields) {
        if (row[field] === value) {
          continue;
        }
        this.ensure(baseRow !== undefined, `${key}.${field} changed in the draft with no base entry under that key`);
        const named = conflicts.some((conflict) => conflict.path === `${identity(baseRow as Entry)} › ${field}`);
        this.ensure(named, `the edit ${key}.${field} = ${value} was lost without a named conflict`);
        fields.delete(field);
      }
    }
    for (const conflict of conflicts) {
      this.ensure(
        this.justified(conflict, before),
        `a conflict with no operator change behind it: ${JSON.stringify(conflict)}`,
      );
    }
    this.absorb(base);
  }

  /** An edited entry only goes with a named removal elsewhere — or as the base entry it was written as. */
  private ensureVanishedIsNamed(key: string, was: Entry, conflicts: readonly DraftConflict[], before: Sides): void {
    const named = conflicts.some(
      (conflict) => conflict.path === identity(was) && conflict.mine === 'changed' && conflict.theirs === 'removed',
    );
    if (!named) {
      // An addition under the identity of a base entry and written as that entry is, to the
      // merge, that entry untouched: removed elsewhere, it goes without a word.
      const twin = baseEntryNamed(before.base, identity(was));
      this.ensure(
        twin !== undefined && sameWritten(twin, was),
        `the edited entry ${key} vanished without a named conflict`,
      );
    }
    this.edits.delete(key);
  }

  /**
   * Whether the operator changed what a conflict names, as the merge sees changes: against the
   * base entry an operator entry grew from (the base entry of the latest's identity, else — for a
   * removal elsewhere — the one under the operator's key or identity; an entry both sides added
   * grew from nothing). A removal the operator made is a base entry the draft lacked or renamed.
   */
  private justified(conflict: DraftConflict, before: Sides): boolean {
    if (conflict.mine === 'removed') {
      const was = baseEntryNamed(before.base, conflict.path);
      const held = was === undefined ? undefined : before.draft.get(was.key);
      return was !== undefined && (held === undefined || identity(held) !== identity(was));
    }
    if (conflict.theirs === 'removed') {
      const row = [...before.draft.values()].find((entry) => identity(entry) === conflict.path);
      const grewFrom =
        row === undefined ? undefined : (before.base.get(row.key) ?? baseEntryNamed(before.base, identity(row)));
      return row !== undefined && grewFrom !== undefined && !sameWritten(grewFrom, row);
    }
    const [entryPath, field] = conflict.path.split(' › ');
    const latest = entryPath === undefined ? undefined : this.base.find((entry) => identity(entry) === entryPath);
    const row = latest === undefined ? undefined : before.draft.get(latest.key);
    if (row === undefined || field === undefined || !isField(field)) {
      return false;
    }
    const grewFrom = baseEntryNamed(before.base, entryPath as string);
    return grewFrom === undefined || grewFrom[field] !== row[field];
  }

  /**
   * An edit the base carries (a change undone, the same change made elsewhere, an addition that
   * met its counterpart) is not pending: nothing is lost if it goes with the entry.
   */
  private absorb(base: Map<string, Entry>): void {
    for (const [key, fields] of this.edits) {
      const baseRow = base.get(key);
      for (const [field, value] of fields) {
        if (baseRow?.[field] === value) {
          fields.delete(field);
        }
      }
      if (fields.size === 0) {
        this.edits.delete(key);
      }
    }
  }

  /** Keys unique on both sides; the base keyed as the draft is wherever they hold the same entry. */
  private checkInvariants(): void {
    const draftKeys = keysOf(this.draft);
    const baseKeys = keysOf(this.base);
    this.ensure(new Set(draftKeys).size === draftKeys.length, `duplicate draft keys: ${draftKeys.join(', ')}`);
    this.ensure(new Set(baseKeys).size === baseKeys.length, `duplicate base keys: ${baseKeys.join(', ')}`);
    const draft = byKey(this.draft);
    const base = byKey(this.base);
    for (const [key, entry] of draft) {
      const baseEntry = base.get(key);
      if (baseEntry !== undefined && identity(baseEntry) !== identity(entry)) {
        this.ensure(
          this.edits.get(key)?.has('id') === true,
          `${key} is ${entry.id} in the draft and ${baseEntry.id} in the base`,
        );
      }
    }
    for (const baseEntry of this.base) {
      for (const entry of this.draft) {
        if (identity(entry) !== identity(baseEntry) || entry.key === baseEntry.key) {
          continue;
        }
        // One identity under two keys: the draft's row grew from the base row under its own key
        // (a rename, checked above) or is an addition beside the renamed row that holds the base's
        // key. Anything else is a base the next merge would not match by key.
        this.ensure(
          base.has(entry.key) || draft.has(baseEntry.key),
          `${identity(entry)} is keyed ${entry.key} in the draft and ${baseEntry.key} in the base`,
        );
      }
    }
  }

  /**
   * Merging a dirty draft onto the same latest again changes nothing and names nothing. (A clean
   * draft takes the latest as the settings key it, as the sync adopts it.)
   */
  private checkIdempotent(latest: readonly Entry[]): void {
    if (sameWritten(this.draft, this.base)) {
      return;
    }
    const again = rebaseDraft(this.base, structuredClone(this.draft), latest, identity);
    this.ensure(again.conflicts.length === 0, 'a second merge onto the same latest named a conflict');
    this.ensure(sameDraft(again.draft, this.draft), 'a second merge onto the same latest changed the draft');
    this.ensure(sameDraft(again.base, this.base), 'a second merge onto the same latest changed the base');
  }

  step(): void {
    const roll = this.next();
    if (roll < 0.12) {
      this.operatorEdits();
    } else if (roll < 0.22) {
      this.operatorRenames();
    } else if (roll < 0.3) {
      this.operatorAdds();
    } else if (roll < 0.36) {
      this.operatorRemoves();
    } else if (roll < 0.46) {
      this.theirsEdits();
    } else if (roll < 0.54) {
      this.theirsRenames();
    } else if (roll < 0.62) {
      this.theirsAdds();
    } else if (roll < 0.68) {
      this.theirsRemoves();
    } else if (roll < 0.88) {
      this.reapply();
    } else {
      this.save();
    }
  }
}

describe('rebaseDraft over random sequences of edits on both sides', () => {
  const initial: readonly Stored[] = [
    { alias: '', id: 'a', note: '' },
    { alias: 'bee', id: 'b', note: 'as read' },
  ];

  test('keeps keys unique, the base keyed like the draft, and every operator edit kept or named', () => {
    let merges = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const session = new Session(seed, initial);
      for (let step = 0; step < 14; step += 1) {
        session.step();
      }
      session.reapply();
      merges += session.merges;
    }
    expect(merges).toBeGreaterThan(1000);
  });
});
