import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';
import type { DelegationPageClient, DelegationSaveOutcome } from './delegation-contract';

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

describe('createDraftSync around a save', () => {
  test('an edit made while the save is pending survives the settle and the refetch that follows', () => {
    const mounted = mountDraftSync<Draft>({ draft: initial(), revision: 'r1' });
    const { sync } = mounted;
    sync.markDirty();
    sync.draft.label = 'saved label';
    const saved = sync.snapshot();
    // The save is in flight: the operator keeps editing.
    sync.draft.note = 'typed while pending';

    sync.settle(saved, 'r2');
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
    sync.settle(sync.snapshot(), 'r2');
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
    sync.settle(saved, 'r2');

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
    sync.settle(saved, 'r2');

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

describe('createSaveEpisode', () => {
  const written: DelegationSaveOutcome = { kind: 'written', revision: 'r2' };
  const client = (outcome: DelegationSaveOutcome): DelegationPageClient => ({
    saveSettings: () => Promise.resolve(outcome),
    simulate: () => Promise.reject(new Error('not simulated here')),
  });

  test('hands the saved draft and the written revision to onWritten, and only then ends the episode', async () => {
    const seen: { pendingMeanwhile: boolean; revision: string; saved: Draft }[] = [];
    const episode = createSaveEpisode<Draft>({
      client: () => client(written),
      onWritten: (event) => {
        seen.push({ ...event, pendingMeanwhile: episode.pending });
        return Promise.resolve();
      },
    });
    const saved: Draft = { label: 'saved label', note: '' };

    const outcome = await episode.run({ expectedRevision: 'r1' }, saved);
    expect(outcome).toEqual(written);
    expect(seen).toEqual([{ pendingMeanwhile: true, revision: 'r2', saved }]);
    expect(episode.pending).toBe(false);
    expect(episode.outcome).toEqual(written);
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
