import { afterEach, describe, expect, test } from 'bun:test';
import { dashboardSearchDefaultsFor } from '../../foundation/dashboard/dashboard-search';
import type { CampaignNavigationActionsOptions } from './campaigns-navigation-actions.svelte';
import { MULTIPLE_HARNESSES } from './campaigns-page-model';
import { compileCampaignRuneModulesForClient } from './campaigns-rune-modules.fixture';

compileCampaignRuneModulesForClient();

const { createCampaignNavigationActions } = await import('./campaigns-navigation-actions.svelte');
const { createCampaignExplorationState } = await import('./campaigns-exploration-state.svelte');
const { observe } = await import('./campaigns-reactivity.fixture.svelte');

interface Goto {
  readonly options: unknown;
  readonly url: string;
}

const ORIGIN = 'http://127.0.0.1';
const latestRevision = { revision: 'rev-2', generatedAt: '2026-11-02T00:00:00.000Z' };

const setup = (overrides: { href?: string; pageState?: App.PageState; selectedSessionId?: string } = {}) => {
  const environment = {
    href: overrides.href ?? `${ORIGIN}/campaigns?selectedCampaign=c-1`,
    pageState: overrides.pageState ?? {},
    revisions: { 'row-1': 'rev-1' } as Record<string, string>,
    selectedKey: 'c-1',
    selectedSessionId: overrides.selectedSessionId ?? '',
    selectionRowId: undefined as string | undefined,
    gotoFailure: null as unknown,
  };
  const gotos: Goto[] = [];
  const focus = { detailOpenerId: '', pendingFocus: '' };
  const exploration = createCampaignExplorationState({ focus, scope: () => 'scope' });
  const options: CampaignNavigationActionsOptions = {
    exploration,
    focus,
    goto: (url, gotoOptions) => {
      gotos.push({ options: gotoOptions, url: String(url) });
      return environment.gotoFailure === null ? Promise.resolve() : Promise.reject(environment.gotoFailure);
    },
    href: () => environment.href,
    latest: () => latestRevision,
    pageState: () => environment.pageState,
    pageUrl: () => new URL(environment.href),
    rowRevisionFor: (rowId) => environment.revisions[rowId],
    search: () => dashboardSearchDefaultsFor('date'),
    selectedKey: () => environment.selectedKey,
    selectedSessionId: () => environment.selectedSessionId,
    selectionRowId: () => environment.selectionRowId,
  };
  const actions = createCampaignNavigationActions(options);
  return { actions, environment, exploration, focus, gotos };
};

/** The URL a goto went to, relative to the page origin. */
const path = (goto: Goto | undefined): string => (goto ? goto.url.slice(ORIGIN.length) : '');
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const globals = globalThis as { HTMLFormElement?: unknown; window?: unknown };
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'HTMLFormElement');
  Reflect.deleteProperty(globalThis, 'window');
});

describe('campaign navigation actions', () => {
  test('selecting another campaign resets its member exploration and reveals the map', () => {
    const { actions, exploration, gotos } = setup({
      href: `${ORIGIN}/campaigns?selectedCampaign=c-1&selectedSession=r`,
    });
    exploration.matchingRestoration = { campaignKey: 'c-1', depth: 1, rowIds: [] };
    exploration.searchNavigation = { focusKey: 'r' };
    exploration.mapNavigation = { focusKey: 'm' };
    exploration.collapsedNodes = new Set(['n']);
    actions.selectCampaign('c-2');
    expect(path(gotos[0])).toBe('/campaigns?selectedCampaign=c-2');
    expect(gotos[0]?.options).toEqual({ reset: false });
    expect(exploration.matchingRestoration).toBeNull();
    expect(exploration.collapsedNodes.size).toBe(0);
    expect(exploration.capture()).toMatchObject({ mobileMap: true });
  });

  test('selecting the same campaign keeps its exploration and the open session', () => {
    const { actions, exploration, gotos } = setup({
      href: `${ORIGIN}/campaigns?selectedCampaign=c-1&selectedSession=r`,
    });
    exploration.collapsedNodes = new Set(['n']);
    actions.selectCampaign('c-1');
    expect(path(gotos[0])).toBe('/campaigns?selectedCampaign=c-1&selectedSession=r');
    expect(exploration.collapsedNodes).toEqual(new Set(['n']));
    expect(exploration.mobileMap).toBe(true);
  });

  test('selects a view through the URL', () => {
    const { actions, gotos } = setup();
    actions.selectView('timeline');
    actions.selectView('list');
    expect(gotos.map(path)).toEqual([
      '/campaigns?selectedCampaign=c-1&campaignView=timeline',
      '/campaigns?selectedCampaign=c-1',
    ]);
  });

  test('clearing the selection forgets the automatic campaign and the open session', () => {
    const { actions, exploration, gotos } = setup({
      href: `${ORIGIN}/campaigns?selectedCampaign=c-1&selectedSession=r&q=x`,
    });
    exploration.automaticCampaign = 'c-1';
    actions.clearSelection();
    expect(exploration.automaticCampaign).toBe('');
    expect(path(gotos[0])).toBe('/campaigns?q=x');
  });

  test('clearing the filters returns to the default search without a selection', () => {
    const { actions, gotos } = setup({ href: `${ORIGIN}/campaigns?selectedCampaign=c-1&selectedSession=r&q=x` });
    actions.clearFilters();
    const url = new URL(gotos[0]?.url ?? '');
    expect(url.pathname).toBe('/campaigns');
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.has('selectedCampaign')).toBe(false);
    expect(url.searchParams.has('selectedSession')).toBe(false);
  });

  test('applying the filter form submits its search without a selection', () => {
    class FakeForm {}
    globals.HTMLFormElement = FakeForm;
    const { actions, gotos } = setup();
    let prevented = false;
    const submit = (currentTarget: unknown) =>
      ({
        currentTarget,
        preventDefault: () => {
          prevented = true;
        },
      }) as unknown as SubmitEvent;
    actions.applyFilters(submit({}));
    expect(prevented).toBe(true);
    expect(gotos).toEqual([]);
    const OriginalFormData = globalThis.FormData;
    const entries = new OriginalFormData();
    entries.set('q', 'forecast');
    entries.set('harness', MULTIPLE_HARNESSES);
    entries.set('range', '7d');
    globalThis.FormData = class extends OriginalFormData {
      constructor() {
        super();
        for (const [name, value] of entries) {
          this.set(name, value);
        }
      }
    } as typeof FormData;
    try {
      actions.applyFilters(submit(new FakeForm()));
    } finally {
      globalThis.FormData = OriginalFormData;
    }
    const url = new URL(gotos[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe('forecast');
    expect(url.searchParams.has('selectedCampaign')).toBe(false);
  });

  test('opening a session from the list records its row as the panel opener', () => {
    const { actions, exploration, focus, gotos } = setup();
    actions.openSession({ rowId: 'row-1' });
    expect(focus.detailOpenerId).toBe('row-1');
    expect(exploration.mobileMap).toBe(true);
    expect(path(gotos[0])).toBe('/campaigns?selectedCampaign=c-1&selectedSession=row-1');
    expect(gotos[0]?.options).toEqual({
      reset: false,
      replace: false,
      state: { aiUsageSessionPanel: { openedFromReport: true } },
    });
  });

  test('moving between sessions replaces the entry and keeps the original opener', () => {
    const panel = { aiUsageSessionPanel: { openedFromReport: true } } as const;
    const { actions, focus, gotos } = setup({ pageState: panel, selectedSessionId: 'row-0' });
    focus.detailOpenerId = 'row-0';
    actions.openSession({ rowId: 'row-1' });
    expect(focus.detailOpenerId).toBe('row-0');
    expect(gotos[0]?.options).toEqual({ reset: false, replace: true, state: panel });
  });

  test('moving on from a directly loaded session replaces the entry and keeps its page state', () => {
    const { actions, gotos } = setup({ pageState: { aiUsageNavigationKey: 'k' }, selectedSessionId: 'row-0' });
    actions.changeSelection({ row: { rowId: 'row-1' } });
    expect(gotos[0]?.options).toEqual({ reset: false, replace: true, state: { aiUsageNavigationKey: 'k' } });
  });

  test('a row the page has not acquired opens nothing', () => {
    const { actions, exploration, gotos } = setup();
    actions.openSession({ rowId: 'unknown' });
    expect(gotos).toEqual([]);
    expect(exploration.mobileMap).toBe(false);
  });

  test('closing a panel opened from the report travels back and focuses its row', () => {
    let backs = 0;
    globals.window = {
      history: {
        back: () => {
          backs += 1;
        },
      },
    };
    const { actions, environment, focus, gotos } = setup({
      pageState: { aiUsageSessionPanel: { openedFromReport: true } },
      selectedSessionId: 'row-1',
    });
    environment.selectionRowId = 'canonical-row';
    actions.changeSelection(null);
    expect(backs).toBe(1);
    expect(focus.pendingFocus).toBe('canonical-row');
    expect(gotos).toEqual([]);
  });

  test('closing a directly loaded panel replaces the entry without the session', () => {
    const { actions, focus, gotos } = setup({
      href: `${ORIGIN}/campaigns?selectedCampaign=c-1&selectedSession=row-1`,
      selectedSessionId: 'row-1',
    });
    actions.changeSelection(null);
    expect(focus.pendingFocus).toBe('row-1');
    expect(path(gotos[0])).toBe('/campaigns?selectedCampaign=c-1');
    expect(gotos[0]?.options).toEqual({ reset: false, replace: true });
  });

  test('a restart returns to the latest results and closes the session panel', () => {
    const { actions, exploration, gotos } = setup({
      href: `${ORIGIN}/campaigns?selectedCampaign=c-1&selectedSession=r`,
    });
    exploration.topDepth = 3;
    actions.restart();
    expect(exploration.topDepth).toBe(1);
    expect(exploration.inspected).toEqual(latestRevision);
    expect(path(gotos[0])).toBe('/campaigns?selectedCampaign=c-1');
  });

  test('a failed navigation or focus restoration is reported reactively; the next navigation clears it', async () => {
    const { actions, environment } = setup();
    const observed = observe(() => actions.navigationError);
    environment.gotoFailure = new Error('Navigation was cancelled.');
    actions.selectView('timeline');
    await settled();
    observed.flush();
    environment.gotoFailure = 'not an error';
    actions.selectView('list');
    await settled();
    observed.flush();
    environment.gotoFailure = null;
    actions.selectView('list');
    await settled();
    observed.flush();
    actions.focusFailed(new Error('Focus target vanished.'));
    observed.flush();
    actions.focusFailed('not an error');
    observed.flush();
    observed.dispose();
    expect(observed.seen).toEqual([
      null,
      'Navigation was cancelled.',
      null,
      'Campaign navigation failed.',
      null,
      'Focus target vanished.',
      'Session focus could not be restored.',
    ]);
  });
});
