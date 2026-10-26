/**
 * Re-applying a form's edits onto newer settings. A draft is bound to the revision it was read
 * from (its base); when the settings move on while it is dirty, the operator chooses: drop the
 * edits, or re-apply them onto the latest. Re-applying is a three-way merge over the form's own
 * draft shape (strings, booleans, string lists, nested records and lists of entries keyed by
 * `key`): a value only the operator changed is kept, a value only changed elsewhere is taken, and
 * a value both changed is a named conflict that keeps the latest value — the operator re-enters
 * theirs deliberately or accepts what is there; nothing is decided silently.
 *
 * An entry the operator added carries a counter key until the settings key it by its identity
 * (its id, its route, its checkout path) once saved and re-read: entries are matched across the
 * three sides by that identity, and the merged entry keeps the operator's key, so the form keeps
 * rendering the same entry.
 *
 * Two invariants hold after every merge, by construction: every key in the merged draft is unique
 * (a settings entry whose key an operator entry still holds — one renamed, say — is given a key
 * of its own), and the latest is returned keyed as the merged draft is (`base`), so that the next
 * merge, based on it, matches the operator's entries by key again.
 */

export interface DraftConflict {
  /** The operator's value, worded for the notice. */
  readonly mine: string;
  /** Where in the form: segments joined by ' › ', an entry named by its identity. */
  readonly path: string;
  /** The value now in the settings, worded for the notice; it is the one the draft keeps. */
  readonly theirs: string;
}

export interface DraftRebase<Draft> {
  /** The latest, keyed as `draft` is: what the next merge is based on, so it matches by key. */
  readonly base: Draft;
  readonly conflicts: readonly DraftConflict[];
  readonly draft: Draft;
}

/** What a re-apply produced, for the notice: the revision the draft is now bound to and its conflicts. */
export interface DraftResolution {
  readonly conflicts: readonly DraftConflict[];
  readonly revision: string;
}

/** An entry of a keyed list in a draft; `key` is what the form renders it by. */
export interface DraftEntry {
  readonly key: string;
}

/**
 * The key the settings give an entry once it is saved and re-read, derived from the fields that
 * identify it; the entry's own key while those are blank. Entries are matched by it across the
 * sides of a merge, so an entry the operator added meets its saved view.
 */
export type EntryIdentity = (entry: DraftEntry) => string;

export const keyIdentity: EntryIdentity = (entry) => entry.key;

export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** Structural equality of two drafts (or parts of them); key order and `undefined` fields do not count. */
export const sameDraft = (left: unknown, right: unknown): boolean => stableJson(left) === stableJson(right);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Entry = Record<string, unknown> & DraftEntry;

const isEntryList = (value: unknown): value is readonly Entry[] =>
  Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.key === 'string');

/** Fields the settings own, never the operator: an entry's key and the view it was read from. */
const SETTINGS_OWNED_FIELDS: ReadonlySet<string> = new Set(['declared', 'key', 'original']);

/** `value` without the fields the settings own, at every level: what a form writes. */
const written = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(written);
  }
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [field, entry] of Object.entries(value)) {
      if (!SETTINGS_OWNED_FIELDS.has(field)) {
        copy[field] = written(entry);
      }
    }
    return copy;
  }
  return value;
};

/**
 * Equality of what two drafts write: the fields the settings own (an entry's key, the view it was
 * read from) do not count, so a draft re-read after its own save compares equal to what was saved.
 */
export const sameWritten = (left: unknown, right: unknown): boolean =>
  stableJson(written(left)) === stableJson(written(right));

const describe = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.length === 0 ? '(empty)' : `"${value}"`;
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.length === 0 ? '(none)' : value.join(', ');
  }
  return stableJson(value);
};

const join = (path: string, segment: string): string => (path === '' ? segment : `${path} › ${segment}`);

interface Merge {
  readonly conflicts: DraftConflict[];
  readonly identity: EntryIdentity;
}

/** What a merge produces at one level: the merged draft and the latest keyed as the draft is. */
interface Merged {
  readonly base: unknown;
  readonly draft: unknown;
}

const mergeRecord = (
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
  merge: Merge,
): Merged => {
  const draft: Record<string, unknown> = {};
  const aligned: Record<string, unknown> = { ...theirs };
  for (const field of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    if (SETTINGS_OWNED_FIELDS.has(field)) {
      draft[field] = theirs[field];
    } else {
      const merged = mergeValue(base[field], mine[field], theirs[field], join(path, field), merge);
      draft[field] = merged.draft;
      if (field in theirs) {
        aligned[field] = merged.base;
      }
    }
  }
  return { base: aligned, draft };
};

/** The merged entry under the operator's key, so the form keeps rendering the entry it has. */
const keyedAs = (entry: unknown, key: string): unknown => (isRecord(entry) ? { ...entry, key } : entry);

const byKey = (entries: readonly Entry[]): ReadonlyMap<string, Entry> =>
  new Map(entries.map((entry) => [entry.key, entry]));

const byIdentity = (entries: readonly Entry[], identity: EntryIdentity): ReadonlyMap<string, Entry> =>
  new Map(entries.map((entry) => [identity(entry), entry]));

/**
 * One row of a merge of keyed lists: the entry the draft keeps (none when the operator removed
 * it), the latest entry it is the merge of (none for an operator addition), and the key both
 * render by — the operator's when the operator's form already renders the row.
 */
interface Row {
  readonly draft: Entry | undefined;
  readonly key: string;
  readonly latest: Entry | undefined;
  readonly retained: boolean;
}

/**
 * The rows' keys, unique: a key the operator's form renders is kept as it is (the draft's keys
 * are unique already) and never given to another row, not even once the merge dropped its entry;
 * a key the settings gave a row is kept unless an operator row holds it — an entry renamed keeps
 * the key of the entry it was, and the settings may key a new entry by that name — in which case
 * the settings row is given a key of its own.
 */
const uniqueKeys = (rows: readonly Row[], mine: readonly Entry[]): string[] => {
  const taken = new Set(mine.map((entry) => entry.key));
  return rows.map((row) => {
    if (row.retained) {
      return row.key;
    }
    let key = row.key;
    for (let suffix = 2; taken.has(key); suffix += 1) {
      key = `${row.key}#${suffix}`;
    }
    taken.add(key);
    return key;
  });
};

/**
 * Entries in the latest order with the operator's additions last, each under the operator's key
 * when the operator has it. The base is keyed as the operator's draft is (the draft grew from
 * it, or it was aligned to the draft by the merge before), so they are matched by key first; the
 * latest is matched by identity, which is also how an entry whose identity the operator changed
 * finds its base. An entry only one side removed goes if the other side left it untouched;
 * otherwise the removal is a conflict and the latest wins (the entry stays, or stays removed).
 */
const mergeEntries = (
  base: readonly Entry[],
  mine: readonly Entry[],
  theirs: readonly Entry[],
  path: string,
  merge: Merge,
): Merged => {
  const { conflicts, identity } = merge;
  const baseByKey = byKey(base);
  const baseById = byIdentity(base, identity);
  const mineByKey = byKey(mine);
  const mineById = byIdentity(mine, identity);
  /** Base entries the latest accounted for; an operator entry whose base is among them is an addition. */
  const accounted = new Set<Entry>();
  const placed = new Set<Entry>();
  const unplaced = (entry: Entry | undefined): Entry | undefined =>
    entry === undefined || placed.has(entry) ? undefined : entry;
  const rows: Row[] = [];
  for (const entry of theirs) {
    const id = identity(entry);
    const entryPath = join(path, id);
    const before = baseById.get(id);
    const edited =
      before === undefined
        ? unplaced(mineById.get(id))
        : (unplaced(mineByKey.get(before.key)) ?? unplaced(mineById.get(id)));
    if (before !== undefined) {
      accounted.add(before);
    }
    if (edited !== undefined) {
      placed.add(edited);
      // The three sides are compared under one key, the operator's: a key alone never tells them apart.
      const merged = mergeValue(keyedAs(before, edited.key), edited, keyedAs(entry, edited.key), entryPath, merge);
      rows.push({ draft: merged.draft as Entry, key: edited.key, latest: merged.base as Entry, retained: true });
    } else if (before === undefined) {
      rows.push({ draft: entry, key: entry.key, latest: entry, retained: false });
    } else if (sameWritten(before, entry)) {
      rows.push({ draft: undefined, key: before.key, latest: entry, retained: false });
    } else {
      conflicts.push({ mine: 'removed', path: entryPath, theirs: 'changed' });
      rows.push({ draft: entry, key: entry.key, latest: entry, retained: false });
    }
  }
  for (const entry of mine) {
    if (placed.has(entry)) {
      continue;
    }
    const before = baseByKey.get(entry.key) ?? baseById.get(identity(entry));
    if (before === undefined || accounted.has(before)) {
      rows.push({ draft: entry, key: entry.key, latest: undefined, retained: true });
    } else if (!sameWritten(before, entry)) {
      conflicts.push({ mine: 'changed', path: join(path, identity(entry)), theirs: 'removed' });
    }
  }
  const keys = uniqueKeys(rows, mine);
  return {
    base: rows.flatMap((row, index) => (row.latest === undefined ? [] : [keyedAs(row.latest, keys[index]!)])),
    draft: rows.flatMap((row, index) => (row.draft === undefined ? [] : [keyedAs(row.draft, keys[index]!)])),
  };
};

/**
 * Records and keyed lists are always walked (so the base comes out keyed as the draft is, and what
 * the settings own is theirs); a value only the operator changed is decided at the leaves. `base`
 * is absent where both sides added the value (an entry under the same identity): records and
 * keyed lists are then merged against nothing, field by field, so only what differs is named.
 */
const mergeValue = (base: unknown, mine: unknown, theirs: unknown, path: string, merge: Merge): Merged => {
  if (sameDraft(mine, theirs) || sameDraft(mine, base)) {
    return { base: theirs, draft: theirs };
  }
  if (isEntryList(mine) && isEntryList(theirs) && (base === undefined || isEntryList(base))) {
    return mergeEntries(base ?? [], mine, theirs, path, merge);
  }
  if (isRecord(mine) && isRecord(theirs) && (base === undefined || isRecord(base))) {
    return mergeRecord(base ?? {}, mine, theirs, path, merge);
  }
  if (sameDraft(theirs, base)) {
    return { base: theirs, draft: mine };
  }
  merge.conflicts.push({ mine: describe(mine), path, theirs: describe(theirs) });
  return { base: theirs, draft: theirs };
};

/**
 * The operator's edits (`mine` relative to `base`) re-applied onto `theirs`, the draft the latest
 * settings produce; entries are matched by `identity`. The result is bound to the latest; its
 * conflicts name every field both sides changed differently, where the latest value was kept.
 * `base` is the latest keyed as the merged draft is: the base of the next merge.
 */
export const rebaseDraft = <Draft>(
  base: Draft,
  mine: Draft,
  theirs: Draft,
  identity: EntryIdentity = keyIdentity,
): DraftRebase<Draft> => {
  const conflicts: DraftConflict[] = [];
  const merged = mergeValue(base, mine, theirs, '', { conflicts, identity });
  return { base: merged.base as Draft, conflicts, draft: merged.draft as Draft };
};
