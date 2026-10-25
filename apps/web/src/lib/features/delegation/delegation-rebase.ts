/**
 * Re-applying a form's edits onto newer settings. A draft is bound to the revision it was read
 * from (its base); when the settings move on while it is dirty, the operator chooses: drop the
 * edits, or re-apply them onto the latest. Re-applying is a three-way merge over the form's own
 * draft shape (strings, booleans, string lists, nested records and lists of entries keyed by
 * `key`): a value only the operator changed is kept, a value only changed elsewhere is taken, and
 * a value both changed is a named conflict that keeps the latest value — the operator re-enters
 * theirs deliberately or accepts what is there; nothing is decided silently.
 */

export interface DraftConflict {
  /** The operator's value, worded for the notice. */
  readonly mine: string;
  /** Where in the form: segments joined by ' › ', an entry named by its key. */
  readonly path: string;
  /** The value now in the settings, worded for the notice; it is the one the draft keeps. */
  readonly theirs: string;
}

export interface DraftRebase<Draft> {
  readonly conflicts: readonly DraftConflict[];
  readonly draft: Draft;
}

/** What a re-apply produced, for the notice: the revision the draft is now bound to and its conflicts. */
export interface DraftResolution {
  readonly conflicts: readonly DraftConflict[];
  readonly revision: string;
}

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

type Entry = Record<string, unknown> & { readonly key: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEntryList = (value: unknown): value is readonly Entry[] =>
  Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.key === 'string');

/** Fields the settings own, never the operator: an entry's identity and the view it was read from. */
const SETTINGS_OWNED_FIELDS: ReadonlySet<string> = new Set(['declared', 'key', 'original']);

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

const mergeRecord = (
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
  conflicts: DraftConflict[],
): Record<string, unknown> => {
  const merged: Record<string, unknown> = {};
  for (const field of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    merged[field] = SETTINGS_OWNED_FIELDS.has(field)
      ? theirs[field]
      : mergeValue(base[field], mine[field], theirs[field], join(path, field), conflicts);
  }
  return merged;
};

const byKey = (entries: readonly Entry[]): ReadonlyMap<string, Entry> =>
  new Map(entries.map((entry) => [entry.key, entry]));

/**
 * Entries by key, in the latest order with the operator's additions last. An entry only one side
 * removed goes if the other side left it untouched; otherwise the removal is a conflict and the
 * latest wins (the entry stays, or stays removed).
 */
const mergeEntries = (
  base: readonly Entry[],
  mine: readonly Entry[],
  theirs: readonly Entry[],
  path: string,
  conflicts: DraftConflict[],
): unknown[] => {
  const baseBy = byKey(base);
  const mineBy = byKey(mine);
  const theirsBy = byKey(theirs);
  const merged: unknown[] = [];
  for (const entry of theirs) {
    const entryPath = join(path, entry.key);
    const before = baseBy.get(entry.key);
    const edited = mineBy.get(entry.key);
    if (edited !== undefined) {
      merged.push(mergeValue(before, edited, entry, entryPath, conflicts));
    } else if (before === undefined) {
      merged.push(entry);
    } else if (!sameDraft(before, entry)) {
      conflicts.push({ mine: 'removed', path: entryPath, theirs: 'changed' });
      merged.push(entry);
    }
  }
  for (const entry of mine) {
    if (theirsBy.has(entry.key)) {
      continue;
    }
    const before = baseBy.get(entry.key);
    if (before === undefined) {
      merged.push(entry);
    } else if (!sameDraft(before, entry)) {
      conflicts.push({ mine: 'changed', path: join(path, entry.key), theirs: 'removed' });
    }
  }
  return merged;
};

const mergeValue = (
  base: unknown,
  mine: unknown,
  theirs: unknown,
  path: string,
  conflicts: DraftConflict[],
): unknown => {
  if (sameDraft(mine, theirs) || sameDraft(mine, base)) {
    return theirs;
  }
  if (sameDraft(theirs, base)) {
    return mine;
  }
  if (isEntryList(base) && isEntryList(mine) && isEntryList(theirs)) {
    return mergeEntries(base, mine, theirs, path, conflicts);
  }
  if (isRecord(base) && isRecord(mine) && isRecord(theirs)) {
    return mergeRecord(base, mine, theirs, path, conflicts);
  }
  conflicts.push({ mine: describe(mine), path, theirs: describe(theirs) });
  return theirs;
};

/**
 * The operator's edits (`mine` relative to `base`) re-applied onto `theirs`, the draft the latest
 * settings produce. The result is bound to the latest; its conflicts name every field both sides
 * changed differently, where the latest value was kept.
 */
export const rebaseDraft = <Draft>(base: Draft, mine: Draft, theirs: Draft): DraftRebase<Draft> => {
  const conflicts: DraftConflict[] = [];
  const draft = mergeValue(base, mine, theirs, '', conflicts) as Draft;
  return { conflicts, draft };
};
