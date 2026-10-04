import { describe, expect, test } from 'bun:test';
import { createDashboardSearchNavigation } from '../../../foundation/navigation/svelte/dashboard-url';
import { createSvelteNavigationPort } from '../../../foundation/navigation/svelte/navigation';
import {
  panelOpenedFromReport,
  sessionListUrl,
  sessionPanelHistoryState,
  sessionRouteUrl,
} from '../../sessions/detail/session-route';
import { dashboardSearchCodec } from '../../shell/navigation';
import { createReportNavigation } from './report-navigation';

const fixture = (direct = false) => {
  const entries: { url: URL; state: App.PageState }[] = [
    { url: new URL('http://local/projects'), state: {} },
    {
      url: new URL(direct ? 'http://local/sessions/a?tab=sessions' : 'http://local/?tab=sessions'),
      state: { aiUsageNavigationKey: 'reader-entry' },
    },
  ];
  let index = 1;
  const current = () => entries[index]!;
  const traverse = (delta: number) => {
    index = Math.min(entries.length - 1, Math.max(0, index + delta));
  };
  const goto = createReportNavigation({
    currentState: () => current().state,
    currentUrl: () => current().url,
    goto: (url, options) => {
      const entry = { url: new URL(url, current().url), state: options?.state ?? {} };
      if (options?.replaceState) {
        entries[index] = entry;
      } else {
        entries.splice(index + 1, entries.length, entry);
        index += 1;
      }
      return Promise.resolve();
    },
  });
  const port = createSvelteNavigationPort({ getCurrentUrl: () => current().url, goto, history: { go: traverse } });
  return {
    current,
    entries,
    goto,
    traverse,
    navigate: createDashboardSearchNavigation(port, dashboardSearchCodec, ({ cause }) => {
      throw cause;
    }),
    close: async () => {
      if (panelOpenedFromReport(current().state)) {
        traverse(-1);
      } else {
        await goto(sessionListUrl(current().url), { keepFocus: true, noScroll: true });
      }
    },
  };
};

describe('report detail history', () => {
  test('filters replace the one panel entry and preserve its close marker through Back and Forward', async () => {
    const history = fixture();
    const listUrl = history.current().url.href;
    await history.goto(sessionRouteUrl(history.current().url, { kind: 'session', rowId: 'a' }), {
      state: sessionPanelHistoryState(history.current().state),
    });
    history.navigate((search) => ({ ...search, filters: { ...search.filters, project: 'forecast' } }));
    history.navigate((search) => ({ ...search, filters: { ...search.filters, model: 'gpt-5.4' } }));
    expect(history.entries).toHaveLength(3);
    expect(panelOpenedFromReport(history.current().state)).toBe(true);
    const filteredDetailUrl = history.current().url.href;
    expect(history.current().url.pathname).toBe('/sessions/a');
    expect(history.current().url.searchParams.get('filters')).toContain('forecast');
    await history.close();
    expect(history.current().url.href).toBe(listUrl);
    history.traverse(-1);
    expect(history.current().url.pathname).toBe('/projects');
    history.traverse(1);
    expect(history.current().url.href).toBe(listUrl);
    history.traverse(1);
    expect(history.current().url.href).toBe(filteredDetailUrl);
    expect(panelOpenedFromReport(history.current().state)).toBe(true);
  });

  test('closing a filtered direct detail replaces it without inventing an opener or reopening on Back', async () => {
    const history = fixture(true);
    history.navigate((search) => ({ ...search, filters: { model: 'gpt-5.4' } }));
    expect(panelOpenedFromReport(history.current().state)).toBe(false);
    await history.close();
    expect(history.entries).toHaveLength(2);
    expect(history.current().url.pathname).toBe('/');
    expect(history.current().url.searchParams.get('filters')).toContain('gpt-5.4');
    history.traverse(-1);
    expect(history.current().url.pathname).toBe('/projects');
    history.traverse(1);
    expect(history.current().url.pathname).toBe('/');
  });

  test('ordinary report filtering keeps its push history', () => {
    const history = fixture();
    history.navigate((search) => ({ ...search, filters: { project: 'forecast' } }));
    expect(history.entries).toHaveLength(3);
    history.traverse(-1);
    expect(history.current().url.searchParams.has('filters')).toBe(false);
  });
});
