import { describe, expect, test } from 'bun:test';
import { CampaignMapValidationError } from '@ai-usage/report-core/campaign-map';
import { enrichSessionPresentationRow, sessionQueryFingerprint } from '@ai-usage/report-core/session-query';
import {
  campaignMapFixtureGeneratedAt,
  campaignMapFixtureRootKey,
  campaignMapFixtureRows,
} from '../../foundation/campaign-map-fixture';
import { dashboardSearchDefaultsFor } from '../../foundation/dashboard/dashboard-search';
import {
  bootstrapCampaignRevision,
  campaignMapFor,
  campaignRefreshFor,
  campaignTimelineContext,
  detailNavigationRowsFor,
  filteredSearchFrom,
  inheritedFiltersFor,
  MULTIPLE_HARNESSES,
  matchingRestorationFor,
  mergeRowsById,
  optionalSessionLookupRequest,
  recordedAt,
  refreshAnchorsFor,
  sessionCount,
  syntheticCampaignRevision,
  timelineCampaignAnchorFor,
} from './campaigns-page-model';
import { campaignsRequest } from './campaigns-query';

const search = dashboardSearchDefaultsFor('date');
const row = (rowId: string, label = rowId) => ({ rowId, label });
const form = (entries: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) {
    data.set(name, value);
  }
  return data;
};
const forecast = campaignMapFixtureRows
  .filter((entry) => entry.source?.rootSourceSessionId === 'forecast-root')
  .map(enrichSessionPresentationRow);

describe('inheritedFiltersFor', () => {
  test('names every filter the page controls do not edit, in a stable order', () => {
    expect(
      inheritedFiltersFor({
        filters: { model: 'gpt-5' },
        machine: ['MacBook'],
        origin: ['human'],
        timeCell: 'Mon 09',
      }),
    ).toEqual(['model: gpt-5', 'machine: MacBook', 'origin: human', 'local time: Mon 09']);
  });

  test('is empty for the default search', () => {
    expect(inheritedFiltersFor(search)).toEqual([]);
  });
});

describe('campaign revisions', () => {
  test('the synthetic revision is fixed but a fresh value per call', () => {
    const first = syntheticCampaignRevision();
    expect(first).toEqual({ revision: 'synthetic-campaign-map-v1', generatedAt: campaignMapFixtureGeneratedAt });
    expect(syntheticCampaignRevision()).not.toBe(first);
  });

  test('a bootstrap announces its manifest revision and support date; none before acquisition', () => {
    expect(
      bootstrapCampaignRevision({
        bootstrap: { support: { generatedAt: '2026-11-01T00:00:00.000Z' } },
        manifest: { revision: 'rev-7' },
      }),
    ).toEqual({ revision: 'rev-7', generatedAt: '2026-11-01T00:00:00.000Z' });
    expect(bootstrapCampaignRevision(null)).toBeNull();
  });
});

describe('campaignTimelineContext', () => {
  test('binds the answered request fingerprint and period; empty without an answer', () => {
    const request = campaignsRequest(search, campaignMapFixtureGeneratedAt, 'rev-1');
    const timelineRange = { from: '2026-06-01T00:00:00.000Z', to: null };
    expect(campaignTimelineContext({ request, timelineRange })).toBe(
      JSON.stringify([sessionQueryFingerprint(request), timelineRange]),
    );
    expect(campaignTimelineContext(undefined)).toBe('');
  });
});

describe('campaignMapFor', () => {
  test('maps the root and every loaded member page, counting the root in the total', () => {
    const [root, ...children] = forecast;
    if (!root) {
      throw new Error('The Campaigns fixture must contain the forecast root');
    }
    const map = campaignMapFor(campaignMapFixtureRootKey, root, [
      { itemCount: 4, items: children.slice(0, 2) },
      { itemCount: 4, items: children.slice(2) },
    ]);
    expect(map).toMatchObject({ campaignKey: campaignMapFixtureRootKey, loadedCount: 5, totalCount: 5 });
  });

  test('keeps the map validation of a total that omits loaded members', () => {
    const [root, ...children] = forecast;
    if (!root) {
      throw new Error('The Campaigns fixture must contain the forecast root');
    }
    expect(() => campaignMapFor(campaignMapFixtureRootKey, root, [{ itemCount: 1, items: children }])).toThrow(
      CampaignMapValidationError,
    );
  });
});

describe('mergeRowsById', () => {
  test('lets an extra row replace a primary row in place and appends new ones', () => {
    const merged = mergeRowsById([row('a'), row('b')], [row('b', 'matched'), row('c')]);
    expect(merged).toEqual([row('a'), row('b', 'matched'), row('c')]);
  });

  test('returns a fresh array even when nothing is merged', () => {
    const primary = [row('a')];
    expect(mergeRowsById(primary, [])).not.toBe(primary);
    expect(mergeRowsById([], [])).toEqual([]);
  });
});

describe('detailNavigationRowsFor', () => {
  test('keeps the compatible rows when they contain the selection or nothing is selected', () => {
    const compatible = [row('a'), row('b')];
    expect(detailNavigationRowsFor({ row: row('b') }, compatible)).toBe(compatible);
    expect(detailNavigationRowsFor(null, compatible)).toBe(compatible);
  });

  test('isolates a looked-up selection that has no acquired neighbors', () => {
    expect(detailNavigationRowsFor({ row: row('z') }, [row('a')])).toEqual([row('z')]);
  });
});

describe('optionalSessionLookupRequest', () => {
  test('parses a valid link', () => {
    expect(optionalSessionLookupRequest('rev-1', 'row-1')).toEqual({ revision: 'rev-1', rowId: 'row-1' });
  });

  test('answers nothing for an invalid row id', () => {
    expect(optionalSessionLookupRequest('rev-1', ' padded ')).toBeUndefined();
    expect(optionalSessionLookupRequest('rev-1', '')).toBeUndefined();
  });
});

describe('matchingRestorationFor', () => {
  test('keeps only candidate positions that are still matched', () => {
    expect(matchingRestorationFor('campaign-a', 2, ['a', undefined, '', 'gone', 'b'], [row('a'), row('b')])).toEqual({
      campaignKey: 'campaign-a',
      depth: 2,
      rowIds: ['a', 'b'],
    });
  });
});

describe('timelineCampaignAnchorFor', () => {
  const items = [
    { campaignKey: 'campaign-a', row: { projectKey: 'project-a' } },
    { campaignKey: 'campaign-b', row: { projectKey: 'project-b' } },
  ];
  const rows = [row('member-1')];

  test('reads campaign and continuation anchors directly', () => {
    expect(timelineCampaignAnchorFor('campaign:campaign-x', items, rows, 'selected')).toBe('campaign-x');
    expect(timelineCampaignAnchorFor('project-continuation:campaign-y', items, rows, 'selected')).toBe('campaign-y');
  });

  test('resolves a project anchor through the loaded list', () => {
    expect(timelineCampaignAnchorFor('project:project-b', items, rows, 'selected')).toBe('campaign-b');
    expect(timelineCampaignAnchorFor('project:unknown', items, rows, 'selected')).toBeUndefined();
  });

  test('attributes a loaded member row to the selected campaign, anything else to none', () => {
    expect(timelineCampaignAnchorFor('member-1', items, rows, 'selected')).toBe('selected');
    expect(timelineCampaignAnchorFor('member-2', items, rows, 'selected')).toBeUndefined();
    expect(timelineCampaignAnchorFor(undefined, items, rows, 'selected')).toBeUndefined();
  });
});

describe('refreshAnchorsFor', () => {
  const items = [{ campaignKey: 'campaign-a', row: { projectKey: 'project-a' } }];

  test('deduplicates the list and timeline campaigns and keeps a loaded member anchor', () => {
    expect(
      refreshAnchorsFor({
        campaignAnchor: 'campaign-a',
        items,
        memberAnchor: 'member-1',
        rows: [row('member-1')],
        selectedKey: 'campaign-a',
        timelineAnchor: 'project:project-a',
      }),
    ).toEqual({ campaignKeys: ['campaign-a'], memberRowIds: { 'campaign-a': ['member-1'] } });
  });

  test('drops an unloaded member anchor and every member anchor without a selection', () => {
    const input = {
      campaignAnchor: undefined,
      items,
      memberAnchor: 'member-9',
      rows: [row('member-1')],
      timelineAnchor: undefined,
    };
    expect(refreshAnchorsFor({ ...input, selectedKey: 'campaign-a' })).toEqual({
      campaignKeys: [],
      memberRowIds: { 'campaign-a': [] },
    });
    expect(refreshAnchorsFor({ ...input, selectedKey: '' })).toEqual({ campaignKeys: [], memberRowIds: {} });
  });
});

describe('campaignRefreshFor', () => {
  const latest = { revision: 'rev-2', generatedAt: '2026-11-02T00:00:00.000Z' };
  const input = {
    campaignView: 'list' as 'list' | 'timeline',
    items: [{ campaignKey: 'campaign-a', row: { projectKey: 'project-a' } }],
    latest,
    listPageCount: 2,
    matchedRows: [row('match-1')],
    matchingDepth: 3 as number | null,
    memberPageCount: 4,
    navigation: {
      listNavigation: { anchor: { key: 'campaign-a', offset: 0 } },
      mapNavigation: { anchor: { key: 'member-1', offset: 0 } },
      searchNavigation: { anchor: { key: 'match-1', offset: 0 } },
      timelineNavigation: { anchor: { key: 'member-2', offset: 0 } },
    },
    rows: [row('member-1'), row('member-2')],
    selectedKey: 'campaign-a',
    selectedSessionId: 'gone',
  };

  test('keeps the matched positions, the Agent Map member anchor and the acquired depths', () => {
    expect(campaignRefreshFor(input)).toEqual({
      matchingRestoration: { campaignKey: 'campaign-a', depth: 3, rowIds: ['match-1'] },
      anchors: { campaignKeys: ['campaign-a'], memberRowIds: { 'campaign-a': ['member-1'] } },
      listPageCount: 2,
      memberPageCount: 4,
      selectedKey: 'campaign-a',
      inspected: latest,
    });
  });

  test('in the Project timeline, anchors its member row; without an answered search, restores no matches', () => {
    expect(campaignRefreshFor({ ...input, campaignView: 'timeline', matchingDepth: null })).toMatchObject({
      matchingRestoration: null,
      anchors: { campaignKeys: ['campaign-a'], memberRowIds: { 'campaign-a': ['member-2'] } },
    });
  });
});

describe('filteredSearchFrom', () => {
  test('applies the query, one harness and a preset period over the current search', () => {
    const next = filteredSearchFrom(
      { ...search, origin: ['human'] },
      form({ harness: 'Codex', q: 'forecast', range: '7d' }),
    );
    expect(next).toEqual({ ...search, origin: ['human'], harness: ['Codex'], q: 'forecast', range: { mode: '7d' } });
  });

  test('keeps a multiple-harness URL selection and a custom period', () => {
    const current = {
      ...search,
      harness: ['Codex', 'Claude'],
      range: { mode: 'custom' as const, from: '2026-06-01' },
    };
    expect(filteredSearchFrom(current, form({ harness: MULTIPLE_HARNESSES, range: 'custom' }))).toEqual({
      ...current,
      q: '',
    });
  });

  test('falls back to all harnesses and thirty days for absent or unknown values', () => {
    expect(filteredSearchFrom({ ...search, harness: ['Codex'] }, form({ range: 'decade' }))).toEqual({
      ...search,
      harness: [],
      q: '',
      range: { mode: '30d' },
    });
  });
});

describe('recordedAt', () => {
  test('prefers the active date, then the end, then the start, formatted in UTC', () => {
    expect(recordedAt({ activeDate: '2026-06-11T09:05:00.000Z', date: null, endDate: null })).toBe(
      '11 Jun 2026, 09:05 UTC',
    );
    expect(
      recordedAt({ activeDate: null, date: '2026-01-02T23:59:00.000Z', endDate: '2026-12-31T00:01:00.000Z' }),
    ).toBe('31 Dec 2026, 00:01 UTC');
    expect(recordedAt({ activeDate: null, date: '2026-03-04T10:00:00.000Z', endDate: null })).toBe(
      '4 Mar 2026, 10:00 UTC',
    );
  });

  test('says so when no usable time is recorded', () => {
    expect(recordedAt({ activeDate: null, date: null, endDate: null })).toBe('Time not recorded');
    expect(recordedAt({ activeDate: null, date: 'not a date', endDate: null })).toBe('Time not recorded');
  });
});

describe('sessionCount', () => {
  test('counts one session by default and pluralises the rest', () => {
    expect(sessionCount({})).toBe('1 session');
    expect(sessionCount({ campaignTotalCount: 5 })).toBe('5 sessions');
    expect(sessionCount({ campaignTotalCount: 5, campaignVisibleCount: 5 })).toBe('5 sessions');
  });

  test('names the filtered share', () => {
    expect(sessionCount({ campaignTotalCount: 5, campaignVisibleCount: 2 })).toBe('2 of 5 sessions');
  });
});
