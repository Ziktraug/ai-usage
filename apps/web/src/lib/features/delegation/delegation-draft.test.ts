import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';
import type { DelegationPageClient, DelegationSaveOutcome } from './delegation-contract';
import type { WrittenSave } from './delegation-draft.svelte';
import type { EntryIdentity } from './delegation-rebase';

/** Only the two rune modules this file tests; nothing else in the test process is compiled or redirected. */
const RUNE_MODULES = /\/delegation-draft(?:\.fixture)?\.svelte\.ts$/u;
const SVELTE_IMPORT = /from\s*(['"])svelte\1/gu;
const SERVER_ENTRY = /index-server\.js$/u;

/** Bun resolves `svelte` to its server entry; the client one owns `flushSync` and `untrack` as a browser sees them. */
const svelteServerEntry = fileURLToPath(import.meta.resolve('svelte'));
if (!SERVER_ENTRY.test(svelteServerEntry)) {
  throw new Error(`Expected the svelte server entry, got ${svelteServerEntry}.`);
}
const svelteClientEntry = svelteServerEntry.replace(SERVER_ENTRY, 'index-client.js');

// The two rune modules are compiled for the client, so `$state` and `$effect` behave as they do
// in the browser: a refetch is a state change the effect answers after `flushSync`. Their own
// `svelte` import is pointed at the client entry; the process-wide `svelte` entry stays the
// server one, so the other test files of the same `bun test` run are unaffected.
plugin({
  name: 'delegation draft rune modules (client)',
  setup(build) {
    build.onLoad({ filter: RUNE_MODULES }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const stripped = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
      const { js } = compileModule(stripped, { filename: path, generate: 'client' });
      return {
        contents: js.code.replace(SVELTE_IMPORT, `from ${JSON.stringify(svelteClientEntry)}`),
        loader: 'js',
      };
    });
  },
});

const { createSaveEpisode } = await import('./delegation-draft.svelte');
const { mountDraftSync } = await import('./delegation-draft.fixture.svelte');

interface Draft {
  label: string;
  note: string;
}

const initial = (): Draft => ({ label: 'as read', note: '' });

/** A save of `saved`, built on `expectedRevision`, that the settings wrote as `revision`. */
const written = <Saved>(expectedRevision: string, revision: string, saved: Saved): WrittenSave<Saved> => ({
  expectedRevision,
  revision,
  saved,
});

/** An entry as the keyed forms draft it: a counter key and no view until saved; the settings' key and view once read back. */
interface Entry {
  id: string;
  key: string;
  note: string;
  original: { declaredAt: string } | null;
}

const entryIdentity: EntryIdentity = (entry) =>
  'id' in entry && typeof entry.id === 'string' && entry.id.length > 0 ? `entry/${entry.id}` : entry.key;
const DECLARED_AT = '2026-10-25T12:00:00.000Z';
const added = (): Entry => ({ id: 'o3', key: 'new-1', note: '', original: null });
/** The added entry as the settings read it back after its save: keyed by its id and dated. */
const reread = (note = '', declaredAt = DECLARED_AT): Entry => ({
  id: 'o3',
  key: 'entry/o3',
  note,
  original: { declaredAt },
});

describe('createDraftSync around a save', () => {
  test('an edit made while the save is pending survives the settle and the refetch that follows', () => {
    const mounted = mountDraftSync<Draft>({ draft: initial(), revision: 'r1' });
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.label = 'saved label';
    const saved = sync.snapshot();
    // The save is in flight: the operator keeps editing.
    sync.draft.note = 'typed while pending';

    sync.settle(written('r1', 'r2', saved));
    expect(sync.dirty).toBe(true);
    expect(sync.stale).toBe(false);
    expect(sync.baseRevision).toBe('r2');

    // The refetch lands with what was saved: the later edit is kept, relative to it.
    mounted.publish({ draft: { label: 'saved label', note: '' }, revision: 'r2' });
    expect(sync.draft).toEqual({ label: 'saved label', note: 'typed while pending' });
    expect(sync.dirty).toBe(true);
    expect(sync.stale).toBe(false);
    expect(sync.baseRevision).toBe('r2');
    mounted.dispose();
  });

  test('a save nothing followed settles clean: the refetch adopts the settings as written', () => {
    const mounted = mountDraftSync<Draft>({ draft: initial(), revision: 'r1' });
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.label = 'saved label';
    sync.settle(written('r1', 'r2', sync.snapshot()));
    expect(sync.dirty).toBe(false);

    mounted.publish({ draft: { label: 'saved label (as the server dates it)', note: '' }, revision: 'r2' });
    expect(sync.draft).toEqual({ label: 'saved label (as the server dates it)', note: '' });
    expect(sync.dirty).toBe(false);
    expect(sync.baseRevision).toBe('r2');
    mounted.dispose();
  });

  test('a later edit stays relative to what was saved: a normalised refetch goes stale, and re-applying keeps it', () => {
    const mounted = mountDraftSync<Draft>({ draft: initial(), revision: 'r1' });
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.label = 'saved label';
    const saved = sync.snapshot();
    sync.draft.note = 'typed while pending';
    sync.settle(written('r1', 'r2', saved));

    // The server normalised the saved field: the settings moved in what this form writes.
    mounted.publish({ draft: { label: 'Saved label', note: '' }, revision: 'r2' });
    expect(sync.stale).toBe(true);
    expect(sync.draft).toEqual({ label: 'saved label', note: 'typed while pending' });

    const resolution = sync.reapply();
    expect(resolution).toEqual({ conflicts: [], revision: 'r2' });
    expect(sync.draft).toEqual({ label: 'Saved label', note: 'typed while pending' });
    expect(sync.dirty).toBe(true);
    expect(sync.stale).toBe(false);
    mounted.dispose();
  });

  test('a later edit is kept under a newer revision that changed nothing this form writes', () => {
    const mounted = mountDraftSync<Draft>({ draft: initial(), revision: 'r1' });
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.label = 'saved label';
    const saved = sync.snapshot();
    sync.draft.note = 'typed while pending';
    sync.settle(written('r1', 'r2', saved));

    // Another client saved a section this form does not write before the refetch.
    mounted.publish({ draft: { label: 'saved label', note: '' }, revision: 'r3' });
    expect(sync.draft).toEqual({ label: 'saved label', note: 'typed while pending' });
    expect(sync.stale).toBe(false);
    expect(sync.dirty).toBe(true);
    expect(sync.baseRevision).toBe('r3');
    mounted.dispose();
  });

  test('a snapshot is a plain copy that later edits do not reach', () => {
    const mounted = mountDraftSync<Draft>({ draft: initial(), revision: 'r1' });
    const { sync } = mounted;
    const saved = sync.snapshot();
    sync.markDirty();
    sync.draft.label = 'changed after';
    expect(saved).toEqual(initial());
    expect(sync.draft.label).toBe('changed after');
    mounted.dispose();
  });
});

describe('createDraftSync around the save of an entry the operator added', () => {
  test('an edit typed while the save was pending survives its own re-read, keyed and dated by the settings', () => {
    const mounted = mountDraftSync<Entry[]>({ draft: [], revision: 'r1' }, entryIdentity);
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.push(added());
    const saved = sync.snapshot();
    sync.draft[0]!.note = 'typed while pending';
    sync.settle(written('r1', 'r2', saved));
    expect(sync.dirty).toBe(true);

    // The refetch reads the entry back under the settings' key, with the date they stamped on it.
    mounted.publish({ draft: [reread()], revision: 'r2' });
    expect(sync.stale).toBe(false);
    expect(sync.dirty).toBe(true);
    expect(sync.baseRevision).toBe('r2');
    // The form keeps rendering the entry it added (its key), with its note and the settings' date.
    expect(sync.draft).toEqual([
      { id: 'o3', key: 'new-1', note: 'typed while pending', original: { declaredAt: DECLARED_AT } },
    ]);
    mounted.dispose();
  });

  test('a change made elsewhere to that entry during the save is named on re-apply, never overwritten', () => {
    const mounted = mountDraftSync<Entry[]>({ draft: [], revision: 'r1' }, entryIdentity);
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.push(added());
    const saved = sync.snapshot();
    sync.draft[0]!.note = 'typed while pending';
    sync.settle(written('r1', 'r2', saved));

    mounted.publish({ draft: [reread('their note', '2026-10-25T12:30:00.000Z')], revision: 'r3' });
    expect(sync.stale).toBe(true);
    expect(sync.draft[0]?.note).toBe('typed while pending');

    const resolution = sync.reapply();
    expect(resolution).toEqual({
      conflicts: [{ mine: '"typed while pending"', path: 'entry/o3 › note', theirs: '"their note"' }],
      revision: 'r3',
    });
    expect(sync.draft).toEqual([
      { id: 'o3', key: 'new-1', note: 'their note', original: { declaredAt: '2026-10-25T12:30:00.000Z' } },
    ]);
    mounted.dispose();
  });

  test('its own revision seen before the save settles rebinds the dirty draft to the view the settings read back', () => {
    const mounted = mountDraftSync<Entry[]>({ draft: [], revision: 'r1' }, entryIdentity);
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.push(added());
    const saved = sync.snapshot();
    sync.draft[0]!.note = 'typed while pending';
    // A refetch read the written settings before the save answered.
    mounted.publish({ draft: [reread()], revision: 'r2' });
    expect(sync.stale).toBe(true);

    sync.settle(written('r1', 'r2', saved));
    expect(sync.stale).toBe(false);
    expect(sync.dirty).toBe(true);
    expect(sync.baseRevision).toBe('r2');
    expect(sync.draft).toEqual([
      { id: 'o3', key: 'new-1', note: 'typed while pending', original: { declaredAt: DECLARED_AT } },
    ]);

    // The refetch the save asks for reads the same revision: nothing moves.
    mounted.publish({ draft: [reread()], revision: 'r2' });
    expect(sync.draft).toEqual([
      { id: 'o3', key: 'new-1', note: 'typed while pending', original: { declaredAt: DECLARED_AT } },
    ]);
    expect(sync.stale).toBe(false);
    mounted.dispose();
  });
});

describe('createDraftSync keeps every key unique and the merge base keyed like the draft', () => {
  /** An entry as the settings read it: keyed by its id and dated. */
  const read = (id: string, note = ''): Entry => ({
    id,
    key: `entry/${id}`,
    note,
    original: { declaredAt: DECLARED_AT },
  });
  const keysOf = (entries: readonly Entry[]): string[] => entries.map((entry) => entry.key);

  test('an entry added elsewhere under the id of an entry the operator renamed renders under a key of its own', () => {
    const mounted = mountDraftSync<Entry[]>({ draft: [read('o3')], revision: 'r1' }, entryIdentity);
    const { sync } = mounted;
    sync.markDirty();
    sync.draft[0]!.id = 'o3-mini';
    const saved = sync.snapshot();
    sync.draft[0]!.note = 'typed while pending';
    sync.settle(written('r1', 'r2', saved));
    // The own re-read keys the renamed entry by its new id; the form keeps rendering it under its key.
    mounted.publish({ draft: [read('o3-mini')], revision: 'r2' });
    expect(sync.stale).toBe(false);
    expect(sync.draft.map((entry) => [entry.key, entry.id])).toEqual([['entry/o3', 'o3-mini']]);

    // Another client adds a new entry under the id the operator's entry had.
    mounted.publish({ draft: [read('o3-mini'), read('o3')], revision: 'r3' });
    expect(sync.stale).toBe(true);
    expect(sync.reapply().conflicts).toEqual([]);
    expect(new Set(keysOf(sync.draft)).size).toBe(sync.draft.length);
    expect(sync.draft.map((entry) => [entry.key, entry.id, entry.note])).toEqual([
      ['entry/o3', 'o3-mini', 'typed while pending'],
      ['entry/o3#2', 'o3', ''],
    ]);
    mounted.dispose();
  });

  test('an entry renamed while its own save was pending, then edited elsewhere, stays one entry with both changes', () => {
    const mounted = mountDraftSync<Entry[]>({ draft: [], revision: 'r1' }, entryIdentity);
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.push(added());
    const saved = sync.snapshot();
    sync.draft[0]!.id = 'o3-mini';
    sync.settle(written('r1', 'r2', saved));
    mounted.publish({ draft: [read('o3')], revision: 'r2' });
    expect(sync.stale).toBe(false);
    expect(sync.draft.map((entry) => [entry.key, entry.id])).toEqual([['new-1', 'o3-mini']]);

    mounted.publish({ draft: [read('o3', 'their note')], revision: 'r3' });
    expect(sync.stale).toBe(true);
    expect(sync.reapply().conflicts).toEqual([]);
    expect(sync.draft).toEqual([
      { id: 'o3-mini', key: 'new-1', note: 'their note', original: { declaredAt: DECLARED_AT } },
    ]);
    expect(sync.dirty).toBe(true);
    mounted.dispose();
  });

  test('the same rename made on both sides, then the operator renames again while the note changes elsewhere', () => {
    const mounted = mountDraftSync<Entry[]>({ draft: [read('o3')], revision: 'r1' }, entryIdentity);
    const { sync } = mounted;
    sync.markDirty();
    sync.draft[0]!.id = 'o3-mini';
    mounted.publish({ draft: [read('o3-mini')], revision: 'r2' });
    expect(sync.stale).toBe(true);
    // Both sides added `o3-mini` as far as the base knows: merged field by field, nothing differs.
    expect(sync.reapply().conflicts).toEqual([]);
    expect(sync.draft.map((entry) => [entry.key, entry.id])).toEqual([['entry/o3', 'o3-mini']]);
    expect(sync.dirty).toBe(false);

    sync.markDirty();
    sync.draft[0]!.id = 'o3-max';
    mounted.publish({ draft: [read('o3-mini', 'their note')], revision: 'r3' });
    expect(sync.stale).toBe(true);
    expect(sync.reapply().conflicts).toEqual([]);
    expect(sync.draft).toEqual([
      { id: 'o3-max', key: 'entry/o3', note: 'their note', original: { declaredAt: DECLARED_AT } },
    ]);
    mounted.dispose();
  });
});

describe('createDraftSync when a refetch lands before the save settles', () => {
  test('a later revision read while the save was pending is adopted by a draft with no edits since', () => {
    const mounted = mountDraftSync<Draft>({ draft: initial(), revision: 'r1' });
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.label = 'saved label';
    const saved = sync.snapshot();
    // Another client wrote on top of this save, and a refetch read that before the save answered.
    mounted.publish({ draft: { label: 'saved label', note: 'written elsewhere' }, revision: 'r3' });
    expect(sync.stale).toBe(true);

    sync.settle(written('r1', 'r2', saved));
    expect(sync.draft).toEqual({ label: 'saved label', note: 'written elsewhere' });
    expect(sync.dirty).toBe(false);
    expect(sync.stale).toBe(false);
    expect(sync.baseRevision).toBe('r3');

    // The refetch the save asks for reads the same revision: nothing moves.
    mounted.publish({ draft: { label: 'saved label', note: 'written elsewhere' }, revision: 'r3' });
    expect(sync.draft).toEqual({ label: 'saved label', note: 'written elsewhere' });
    expect(sync.dirty).toBe(false);
    expect(sync.baseRevision).toBe('r3');
    mounted.dispose();
  });

  test('a later revision that moved what this form writes leaves a dirty draft stale, never clean over it', () => {
    const mounted = mountDraftSync<Draft>({ draft: initial(), revision: 'r1' });
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.label = 'saved label';
    const saved = sync.snapshot();
    sync.draft.note = 'typed while pending';
    mounted.publish({ draft: { label: 'saved label', note: 'written elsewhere' }, revision: 'r3' });

    sync.settle(written('r1', 'r2', saved));
    expect(sync.dirty).toBe(true);
    expect(sync.stale).toBe(true);
    expect(sync.draft).toEqual({ label: 'saved label', note: 'typed while pending' });
    mounted.publish({ draft: { label: 'saved label', note: 'written elsewhere' }, revision: 'r3' });
    expect(sync.stale).toBe(true);

    const resolution = sync.reapply();
    expect(resolution).toEqual({
      conflicts: [{ mine: '"typed while pending"', path: 'note', theirs: '"written elsewhere"' }],
      revision: 'r3',
    });
    expect(sync.draft).toEqual({ label: 'saved label', note: 'written elsewhere' });
    expect(sync.baseRevision).toBe('r3');
    mounted.dispose();
  });

  test('a clean draft a refetch already adopted while the save was pending is left as it is', () => {
    const mounted = mountDraftSync<Draft>({ draft: initial(), revision: 'r1' });
    const { sync } = mounted;
    const saved = sync.snapshot();
    mounted.publish({ draft: { label: 'as read', note: 'written elsewhere' }, revision: 'r3' });
    expect(sync.draft).toEqual({ label: 'as read', note: 'written elsewhere' });

    sync.settle(written('r1', 'r2', saved));
    expect(sync.draft).toEqual({ label: 'as read', note: 'written elsewhere' });
    expect(sync.dirty).toBe(false);
    expect(sync.stale).toBe(false);
    expect(sync.baseRevision).toBe('r3');
    mounted.dispose();
  });
});

describe('createSaveEpisode', () => {
  const writtenOutcome: DelegationSaveOutcome = { kind: 'written', revision: 'r2' };
  const client = (outcome: DelegationSaveOutcome): DelegationPageClient => ({
    saveSettings: () => Promise.resolve(outcome),
    simulate: () => Promise.reject(new Error('not simulated here')),
  });

  test('hands the saved draft, the revision it was built on and the written one to onWritten, and only then ends the episode', async () => {
    const seen: { expectedRevision: string; pendingMeanwhile: boolean; revision: string; saved: Draft }[] = [];
    const episode = createSaveEpisode<Draft>({
      client: () => client(writtenOutcome),
      onWritten: (event) => {
        seen.push({ ...event, pendingMeanwhile: episode.pending });
        return Promise.resolve();
      },
    });
    const saved: Draft = { label: 'saved label', note: '' };

    const outcome = await episode.run({ expectedRevision: 'r1' }, saved);
    expect(outcome).toEqual(writtenOutcome);
    expect(seen).toEqual([{ expectedRevision: 'r1', pendingMeanwhile: true, revision: 'r2', saved }]);
    expect(episode.pending).toBe(false);
    expect(episode.outcome).toEqual(writtenOutcome);
  });

  test('a refused save does not settle anything', async () => {
    const conflict: DelegationSaveOutcome = { kind: 'conflict', message: 'changed elsewhere', revision: 'r9' };
    let writtenCalls = 0;
    const episode = createSaveEpisode<Draft>({
      client: () => client(conflict),
      onWritten: () => {
        writtenCalls += 1;
        return Promise.resolve();
      },
    });
    expect(await episode.run({ expectedRevision: 'r1' }, { label: 'x', note: '' })).toEqual(conflict);
    expect(writtenCalls).toBe(0);
    expect(episode.outcome).toEqual(conflict);
  });
});
