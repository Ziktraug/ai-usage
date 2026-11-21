import { describe, expect, test } from 'bun:test';
import type { CampaignExplorationSnapshot } from './campaigns-exploration-state.svelte';
import { compileCampaignRuneModulesForClient } from './campaigns-rune-modules.fixture';

compileCampaignRuneModulesForClient();

const { createCampaignExplorationState } = await import('./campaigns-exploration-state.svelte');
const { observe } = await import('./campaigns-reactivity.fixture.svelte');

const setup = (scope = 'scope-a') => {
  const environment = { scope };
  const focus = { detailOpenerId: '' };
  const state = createCampaignExplorationState({ focus, scope: () => environment.scope });
  return { environment, focus, state };
};

/** A snapshot as SvelteKit serialises it: plain values, not the state proxies `toMatchObject` does not see through. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const revision = { revision: 'rev-1', generatedAt: '2026-11-01T00:00:00.000Z' };
const anchor = (key: string) => ({ anchor: { key, offset: 0 } });

/** A position in every field, as a reader leaves it. */
const explored = (state: ReturnType<typeof setup>['state']): void => {
  state.anchors = { campaignKeys: ['c-1'] };
  state.automaticCampaign = 'c-1';
  state.collapsedNodes = new Set(['n-1']);
  state.collapsedProjects = new Set(['p-1']);
  state.expansion = { key: 'p-1', open: true };
  state.inspected = revision;
  state.listNavigation = anchor('c-1');
  state.mapNavigation = anchor('m-1');
  state.matchingRestoration = { campaignKey: 'c-1', depth: 2, rowIds: ['r-1'] };
  state.memberDepths = { 'c-1': 3 };
  state.mobileMap = true;
  state.searchExpanded = true;
  state.searchNavigation = anchor('r-1');
  state.timelineAxis = { context: 'ctx', axis: null };
  state.timelineNavigation = anchor('campaign:c-1');
  state.topDepth = 4;
};

describe('campaign exploration state', () => {
  test('starts at the top of an unexplored list', () => {
    const { state } = setup();
    expect(state.capture()).toEqual({
      scope: 'scope-a',
      anchors: {},
      matchingRestoration: null,
      inspected: null,
      automaticCampaign: '',
      topDepth: 1,
      memberDepths: {},
      listNavigation: {},
      mapNavigation: {},
      timelineNavigation: {},
      timelineAxis: null,
      collapsedNodes: [],
      collapsedProjects: [],
      expansion: null,
      mobileMap: false,
      searchExpanded: false,
      searchNavigation: {},
      detailOpenerId: '',
    });
  });

  test('captures every field, the scope and the panel opener in the serialised order', () => {
    const { focus, state } = setup();
    explored(state);
    focus.detailOpenerId = 'r-1';
    const saved = state.capture();
    expect(Object.keys(saved)).toEqual([
      'scope',
      'anchors',
      'matchingRestoration',
      'inspected',
      'automaticCampaign',
      'topDepth',
      'memberDepths',
      'listNavigation',
      'mapNavigation',
      'timelineNavigation',
      'timelineAxis',
      'collapsedNodes',
      'collapsedProjects',
      'expansion',
      'mobileMap',
      'searchExpanded',
      'searchNavigation',
      'detailOpenerId',
    ]);
    expect(plain(saved)).toMatchObject({ collapsedNodes: ['n-1'], collapsedProjects: ['p-1'], detailOpenerId: 'r-1' });
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
  });

  test('restores a captured exploration into a fresh page, sets included', () => {
    const first = setup();
    explored(first.state);
    first.focus.detailOpenerId = 'r-1';
    const saved: CampaignExplorationSnapshot = JSON.parse(JSON.stringify(first.state.capture()));
    const second = setup();
    second.state.restore(saved);
    expect(second.state.collapsedNodes).toEqual(new Set(['n-1']));
    expect(second.state.collapsedProjects).toEqual(new Set(['p-1']));
    expect(second.focus.detailOpenerId).toBe('r-1');
    expect(second.state.capture()).toEqual(saved);
  });

  test('a restored scope is the one the next scope change is compared with', () => {
    const first = setup('scope-b');
    explored(first.state);
    const saved = first.state.capture();
    const second = setup();
    second.state.restore(saved);
    second.state.followScope('scope-b');
    expect(second.state.topDepth).toBe(4);
    second.state.followScope('scope-c');
    expect(second.state.topDepth).toBe(1);
  });

  test('the first scope is only recorded; a new scope starts the exploration over', () => {
    const { state } = setup();
    explored(state);
    state.followScope('scope-a');
    state.followScope('scope-a');
    expect(plain(state.capture())).toMatchObject({ topDepth: 4, searchExpanded: true });
    state.followScope('scope-b');
    expect(plain(state.capture())).toMatchObject({
      anchors: {},
      automaticCampaign: '',
      collapsedNodes: [],
      collapsedProjects: [],
      listNavigation: {},
      mapNavigation: {},
      matchingRestoration: null,
      memberDepths: {},
      searchExpanded: false,
      searchNavigation: {},
      timelineNavigation: {},
      topDepth: 1,
      // A scope change keeps what it never reset.
      expansion: { key: 'p-1', open: true },
      inspected: revision,
      mobileMap: true,
      timelineAxis: { context: 'ctx', axis: null },
    });
  });

  test('a refresh keeps the deepest acquired depths and moves onto the latest revision', () => {
    const { state } = setup();
    explored(state);
    const latest = { revision: 'rev-2', generatedAt: '2026-11-02T00:00:00.000Z' };
    state.refresh({
      anchors: { campaignKeys: ['c-2'] },
      inspected: latest,
      listPageCount: 2,
      matchingRestoration: null,
      memberPageCount: 5,
      selectedKey: 'c-1',
    });
    expect(plain(state.capture())).toMatchObject({
      anchors: { campaignKeys: ['c-2'] },
      inspected: latest,
      matchingRestoration: null,
      memberDepths: { 'c-1': 5 },
      topDepth: 4,
    });
    state.refresh({
      anchors: {},
      inspected: latest,
      listPageCount: 6,
      matchingRestoration: { campaignKey: 'c-2', depth: 1, rowIds: [] },
      memberPageCount: 0,
      selectedKey: 'c-2',
    });
    expect(plain(state.capture())).toMatchObject({ memberDepths: { 'c-1': 5, 'c-2': 1 }, topDepth: 6 });
  });

  test('a restart forgets anchors, depths, positions and the fitted axis, but not the view', () => {
    const { state } = setup();
    explored(state);
    state.restart(null);
    expect(plain(state.capture())).toMatchObject({
      anchors: {},
      inspected: null,
      listNavigation: {},
      mapNavigation: {},
      matchingRestoration: null,
      memberDepths: {},
      timelineAxis: null,
      timelineNavigation: {},
      topDepth: 1,
      automaticCampaign: 'c-1',
      collapsedNodes: ['n-1'],
      mobileMap: true,
      searchExpanded: true,
      searchNavigation: anchor('r-1'),
    });
  });

  test('every field is reactive state read through its getter', () => {
    const { state } = setup();
    const observed = observe(() => [
      state.topDepth,
      state.memberDepths['c-1'],
      state.mapNavigation.anchor?.key,
      state.mobileMap,
      state.inspected?.revision,
    ]);
    state.topDepth = 2;
    observed.flush();
    state.memberDepths = { 'c-1': 2 };
    observed.flush();
    state.mapNavigation = anchor('m-2');
    observed.flush();
    state.followScope('scope-a');
    state.mobileMap = true;
    observed.flush();
    state.restart(revision);
    observed.flush();
    observed.dispose();
    expect(observed.seen).toEqual([
      [1, undefined, undefined, false, undefined],
      [2, undefined, undefined, false, undefined],
      [2, 2, undefined, false, undefined],
      [2, 2, 'm-2', false, undefined],
      [2, 2, 'm-2', true, undefined],
      [1, undefined, undefined, true, 'rev-1'],
    ]);
  });

  test('a bound list writes its position through the setter, and the proxy stays reactive', () => {
    const { state } = setup();
    const observed = observe(() => state.listNavigation.anchor?.key);
    state.listNavigation = {};
    observed.flush();
    state.listNavigation.anchor = { key: 'c-9', offset: 12 };
    observed.flush();
    observed.dispose();
    expect(observed.seen).toEqual([undefined, undefined, 'c-9']);
  });
});
