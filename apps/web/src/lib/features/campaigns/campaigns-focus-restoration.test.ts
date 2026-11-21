import { afterEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';
import type {
  CampaignFocusRestorationOptions,
  CampaignFocusTarget,
  CampaignNavigationEnds,
} from './campaigns-focus-restoration.svelte';

/** Only the rune module this file tests; nothing else in the test process is compiled or redirected. */
const RUNE_MODULE = /\/campaigns-focus-restoration\.svelte\.ts$/u;
const SVELTE_IMPORT = /from\s*(['"])svelte\1/gu;
const SERVER_ENTRY = /index-server\.js$/u;

/** Bun resolves `svelte` to its server entry; the client one owns `tick` and `$state` as a browser sees them. */
const svelteServerEntry = fileURLToPath(import.meta.resolve('svelte'));
if (!SERVER_ENTRY.test(svelteServerEntry)) {
  throw new Error(`Expected the svelte server entry, got ${svelteServerEntry}.`);
}
const svelteClientEntry = svelteServerEntry.replace(SERVER_ENTRY, 'index-client.js');

// Compiled for the client, as the browser runs it; the process-wide `svelte` entry stays the server one.
plugin({
  name: 'campaigns focus restoration rune module (client)',
  setup(build) {
    build.onLoad({ filter: RUNE_MODULE }, async ({ path }) => {
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

const { createCampaignFocusRestoration } = await import('./campaigns-focus-restoration.svelte');

const campaigns = (query = ''): { url: URL } => ({ url: new URL(`http://127.0.0.1/campaigns${query}`) });
const closing = (from: string): CampaignNavigationEnds => ({
  from: campaigns(from),
  to: campaigns('?selectedCampaign=c'),
});

/** A virtual list that records the keys it was asked to focus and answers `restored`. */
const target = (restored: boolean) => {
  const keys: string[] = [];
  const list: CampaignFocusTarget = {
    focusKey: (key) => {
      keys.push(key);
      return Promise.resolve(restored);
    },
  };
  return { keys, list };
};

const setup = (
  overrides: Partial<{
    [Key in keyof CampaignFocusRestorationOptions]: ReturnType<CampaignFocusRestorationOptions[Key]>;
  }> = {},
) => {
  const environment = {
    campaignView: 'list' as 'list' | 'timeline',
    pathname: '/campaigns',
    searchExpanded: true,
    selectedSessionId: '',
    ...overrides,
  };
  const focus = createCampaignFocusRestoration({
    campaignView: () => environment.campaignView,
    pathname: () => environment.pathname,
    searchExpanded: () => environment.searchExpanded,
    selectedSessionId: () => environment.selectedSessionId,
  });
  return { environment, focus };
};

/** The test process has no DOM; the DOM tests install the few globals the restoration reads. */
const globals = globalThis as { CSS?: unknown; document?: unknown; getComputedStyle?: unknown };
if ('CSS' in globalThis || 'document' in globalThis || 'getComputedStyle' in globalThis) {
  throw new Error('Expected a test process without DOM globals.');
}
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'CSS');
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'getComputedStyle');
});

describe('campaign focus restoration', () => {
  test('does nothing without a pending row', async () => {
    const { focus } = setup();
    const search = target(true);
    focus.searchVirtualList = search.list;
    await focus.restoreFocus();
    expect(search.keys).toEqual([]);
  });

  test('closing a panel on the page marks the opener row, else the closed session', () => {
    const { focus } = setup();
    focus.beforeNavigate(closing('?selectedSession=closed'));
    expect(focus.pendingFocus).toBe('closed');
    focus.detailOpenerId = 'opener';
    focus.beforeNavigate(closing('?selectedSession=closed'));
    expect(focus.pendingFocus).toBe('opener');
  });

  test('opening a session or leaving the page marks nothing', () => {
    const { focus } = setup();
    focus.beforeNavigate({ from: campaigns('?selectedSession=a'), to: campaigns('?selectedSession=b') });
    focus.beforeNavigate({ from: campaigns('?selectedSession=a'), to: { url: new URL('http://127.0.0.1/sessions') } });
    focus.beforeNavigate({ from: null, to: campaigns() });
    expect(focus.pendingFocus).toBe('');
  });

  test('focuses the pending row in the expanded search list once and forgets the opener', async () => {
    const { focus } = setup();
    const search = target(true);
    focus.searchVirtualList = search.list;
    focus.detailOpenerId = 'row-1';
    focus.beforeNavigate(closing('?selectedSession=row-1'));
    await focus.restoreFocus();
    expect(search.keys).toEqual(['row-1']);
    expect(focus.detailOpenerId).toBe('');
    expect(focus.pendingFocus).toBe('');
    await focus.restoreFocus();
    expect(search.keys).toEqual(['row-1']);
  });

  test('a navigation or destruction while waiting for the DOM cancels the restoration', async () => {
    for (const interrupt of ['navigate', 'destroy'] as const) {
      const { focus } = setup();
      const search = target(true);
      focus.searchVirtualList = search.list;
      focus.pendingFocus = 'row-1';
      focus.detailOpenerId = 'row-1';
      const restoring = focus.restoreFocus();
      if (interrupt === 'navigate') {
        focus.beforeNavigate({ from: campaigns(), to: { url: new URL('http://127.0.0.1/sessions') } });
      } else {
        focus.destroy();
      }
      await restoring;
      expect(search.keys).toEqual([]);
      expect(focus.detailOpenerId).toBe('row-1');
    }
  });

  test('an open session or another page cancels the restoration', async () => {
    for (const overrides of [{ selectedSessionId: 'row-2' }, { pathname: '/sessions' }]) {
      const { focus } = setup(overrides);
      const search = target(true);
      focus.searchVirtualList = search.list;
      focus.pendingFocus = 'row-1';
      await focus.restoreFocus();
      expect(search.keys).toEqual([]);
      expect(focus.pendingFocus).toBe('');
    }
  });

  test('without a direct match, focuses through the list of the current view', async () => {
    let escaped = '';
    globals.CSS = {
      escape: (value: string) => {
        escaped = value;
        return value;
      },
    };
    globals.document = { querySelector: () => null };
    for (const view of ['list', 'timeline'] as const) {
      const { focus } = setup({ campaignView: view, searchExpanded: false });
      const map = target(true);
      const timeline = target(true);
      focus.mapVirtualList = map.list;
      focus.timelineVirtualList = timeline.list;
      focus.pendingFocus = 'row-1';
      await focus.restoreFocus();
      expect(escaped).toBe('row-1');
      expect(view === 'list' ? map.keys : timeline.keys).toEqual(['row-1']);
      expect(view === 'list' ? timeline.keys : map.keys).toEqual([]);
    }
  });

  test('when no list restores the row, focuses the first visible campaign viewport', async () => {
    const focused: string[] = [];
    const surface = (name: string, visible: boolean) => ({
      closest: () => null,
      focus: () => focused.push(name),
      getClientRects: () => (visible ? [{}] : []),
    });
    globals.CSS = { escape: (value: string) => value };
    globals.getComputedStyle = () => ({ visibility: 'visible' });
    globals.document = {
      activeElement: null,
      querySelector: () => null,
      querySelectorAll: () => [surface('hidden', false), surface('list', true), surface('map', true)],
    };
    const { focus } = setup({ searchExpanded: false });
    const map = target(false);
    focus.mapVirtualList = map.list;
    focus.pendingFocus = 'row-1';
    await focus.restoreFocus();
    expect(map.keys).toEqual(['row-1']);
    expect(focused).toEqual(['list']);
  });
});
