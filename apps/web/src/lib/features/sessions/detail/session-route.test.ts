import { describe, expect, test } from 'bun:test';
import {
  isReportPathname,
  panelOpenedFromReport,
  sameSessionRoute,
  sessionListUrl,
  sessionPanelHistoryState,
  sessionRouteFor,
  sessionRoutePathname,
  sessionRouteUrl,
} from './session-route';

describe('session detail routes', () => {
  test('parses session and campaign detail paths and rejects malformed ones', () => {
    expect(sessionRouteFor('/sessions/row%2F1')).toEqual({ kind: 'session', rowId: 'row/1' });
    expect(sessionRouteFor('/campaigns/campaign%3Aa')).toEqual({ campaignKey: 'campaign:a', kind: 'campaign' });
    expect(sessionRouteFor('/')).toBeNull();
    expect(sessionRouteFor('/sessions/')).toBeNull();
    expect(sessionRouteFor('/sessions/a/b')).toBeNull();
    expect(sessionRouteFor('/sessions/%E0%A4%A')).toBeNull();
    expect(sessionRouteFor('/skills/global/alpha')).toBeNull();
  });

  test('treats the report index and both detail routes as one mounted report', () => {
    expect(isReportPathname('/')).toBe(true);
    expect(isReportPathname('/sessions/row-1')).toBe(true);
    expect(isReportPathname('/campaigns/campaign-1')).toBe(true);
    expect(isReportPathname('/projects')).toBe(false);
  });

  test('builds detail and list URLs that keep the dashboard search and drop the hash', () => {
    const current = new URL('http://localhost/?tab=sessions&range=%7B%22mode%22%3A%22all%22%7D#top');
    const detail = sessionRouteUrl(current, { kind: 'session', rowId: 'row 1' });
    expect(detail.pathname).toBe('/sessions/row%201');
    expect(detail.search).toBe(current.search);
    expect(detail.hash).toBe('');
    expect(sessionRouteFor(detail.pathname)).toEqual({ kind: 'session', rowId: 'row 1' });
    expect(sessionRoutePathname({ campaignKey: 'c/1', kind: 'campaign' })).toBe('/campaigns/c%2F1');
    const list = sessionListUrl(detail);
    expect(list.pathname).toBe('/');
    expect(list.search).toBe(current.search);
  });

  test('compares routes by kind and identity', () => {
    expect(sameSessionRoute(null, null)).toBe(true);
    expect(sameSessionRoute({ kind: 'session', rowId: 'a' }, { kind: 'session', rowId: 'a' })).toBe(true);
    expect(sameSessionRoute({ kind: 'session', rowId: 'a' }, { kind: 'session', rowId: 'b' })).toBe(false);
    expect(sameSessionRoute({ kind: 'session', rowId: 'a' }, { campaignKey: 'a', kind: 'campaign' })).toBe(false);
    expect(sameSessionRoute({ kind: 'session', rowId: 'a' }, null)).toBe(false);
  });

  test('marks history entries the panel opened from the report', () => {
    const state = sessionPanelHistoryState({ aiUsageNavigationKey: 'web-1' });
    expect(state).toEqual({ aiUsageNavigationKey: 'web-1', aiUsageSessionPanel: { openedFromReport: true } });
    expect(panelOpenedFromReport(state)).toBe(true);
    expect(panelOpenedFromReport({})).toBe(false);
    expect(panelOpenedFromReport(undefined)).toBe(false);
  });
});
