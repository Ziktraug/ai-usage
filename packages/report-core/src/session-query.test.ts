import { describe, expect, test } from 'bun:test';
import { MAX_SESSION_QUERY_RESULT_BYTES } from './report-budgets';
import type { SerializedRow } from './report-data';
import {
  compareSessionPresentationRows,
  enrichSessionPresentationRow,
  MAX_SESSION_QUERY_PAGE_SIZE,
  parseSessionCampaignChildrenRequest,
  parseSessionCampaignChildrenResult,
  parseSessionCampaignChildrenServerResult,
  parseSessionNeighborRequest,
  parseSessionNeighborResult,
  parseSessionNeighborServerResult,
  parseSessionPageResult,
  parseSessionPageServerResult,
  parseSessionQueryRequest,
  projectSessionCampaignChildren,
  projectSessionNeighbors,
  projectSessionPage,
  SessionQueryCursorError,
  type SessionQueryRequest,
  SessionQueryValidationError,
  sessionQueryFingerprint,
  sessionQueryNextCursor,
  sessionQueryPageOffset,
  sessionSortFields,
  sortValueForSessionColumn,
} from './session-query';

const baseRow: SerializedRow = {
  activeDate: '2026-06-10T12:00:00.000Z',
  calls: 1,
  costActual: 1,
  costApprox: 1,
  costKnown: true,
  date: '2026-06-10T11:00:00.000Z',
  durationMs: 60_000,
  endDate: '2026-06-10T12:00:00.000Z',
  freshTokens: 17,
  harness: 'Codex',
  lineDelta: 5,
  linesAdded: 4,
  linesDeleted: 1,
  model: 'openai/gpt-5.4-high',
  name: 'Base session',
  project: 'alpha',
  provider: 'Codex API',
  sessionLabel: 'Base session',
  tokCr: 3,
  tokCw: 2,
  tokIn: 10,
  tokOut: 5,
  tokenTotal: 20,
  tools: 3,
  turns: 2,
};

const row = (sessionLabel: string, overrides: Partial<SerializedRow> = {}): SerializedRow => ({
  ...baseRow,
  name: sessionLabel,
  sessionLabel,
  ...overrides,
});

const sourcedRow = (sourceSessionId: string, overrides: Partial<SerializedRow> = {}): SerializedRow =>
  row(sourceSessionId, {
    source: {
      harnessKey: 'codex',
      machineId: 'machine-a',
      machineLabel: 'Machine A',
      rootSourceSessionId: sourceSessionId,
      sourceSessionId,
      ...overrides.source,
    },
    ...overrides,
  });

const defaultRequest = (overrides: Partial<SessionQueryRequest> = {}): SessionQueryRequest => ({
  campaigns: true,
  cursor: null,
  filters: {
    fields: {},
    harness: [],
    machine: [],
    query: '',
  },
  pageSize: 2,
  range: { from: null, to: null },
  revision: 'revision-1',
  sort: [{ desc: true, id: 'date' }],
  ...overrides,
});

describe('session query contracts', () => {
  test('owns the complete 25-column sort allowlist', () => {
    expect(sessionSortFields).toEqual([
      'date',
      'session',
      'harness',
      'machine',
      'provider',
      'project',
      'model',
      'tokIn',
      'tokOut',
      'cache',
      'tokCw',
      'fresh',
      'total',
      'rtkSaved',
      'cost',
      'actual',
      'quota',
      'duration',
      'calls',
      'turns',
      'tools',
      'lines',
      'subagent',
      'partial',
      'ambiguous',
    ]);

    const presentation = enrichSessionPresentationRow(
      row('Sort fixture', {
        ambiguous: true,
        costActual: null,
        costKnown: false,
        costQuota: null,
        durationMs: null,
        partial: true,
        rtkInputTokens: 100,
        rtkSavedTokens: 25,
        subagent: true,
      }),
    );
    expect(sessionSortFields.map((field) => sortValueForSessionColumn(presentation, field))).toEqual([
      presentation.sortDate,
      'sort fixture',
      'codex',
      '',
      'codex api',
      'alpha',
      'gpt-5.4',
      10,
      5,
      3,
      2,
      17,
      20,
      25,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      0,
      1,
      2,
      3,
      5,
      1,
      1,
      1,
    ]);
  });

  test('builds stable JSON-safe presentation identity and search fields', () => {
    const input = sourcedRow('source-a', { models: ['gpt-5.4', 'gpt-5.4-mini'], rawProject: 'repo' });
    const first = enrichSessionPresentationRow(input);
    const second = enrichSessionPresentationRow({ ...input });

    expect(first).toEqual(second);
    expect(first.activeTime).toBe(Date.parse('2026-06-10T12:00:00.000Z'));
    expect(first.modelKey).toBe('gpt-5.4');
    expect(first.modelLabel).toBe('gpt-5.4 + gpt-5.4-mini');
    expect(first.providerDisplay).toBe('Codex API');
    expect(first.rowId).toContain('machine-a|source-a');
    expect(first.searchText).toContain('source-a alpha repo');
    expect(first.searchText).toContain('gpt-5.4 + gpt-5.4-mini');
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  test('strictly validates and canonically normalizes query inputs', () => {
    const parsed = parseSessionQueryRequest({
      campaigns: false,
      cursor: 'opaque-client-value',
      filters: {
        fields: { project: 'alpha' },
        harness: [' Codex ', 'Codex', 'Claude'],
        machine: ['Machine B', 'Machine A'],
        query: '  COST Review  ',
      },
      pageSize: MAX_SESSION_QUERY_PAGE_SIZE,
      range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z' },
      revision: 'revision-1',
      sort: [
        { desc: true, id: 'cost' },
        { desc: false, id: 'session' },
      ],
    });

    expect(parsed.filters).toEqual({
      fields: { project: 'alpha' },
      harness: ['Claude', 'Codex'],
      machine: ['Machine A', 'Machine B'],
      query: 'cost review',
    });
    expect(parsed.cursor).toBe('opaque-client-value');
  });

  test('rejects unknown keys, invalid ranges, duplicate sorts, and unbounded pages', () => {
    const valid = defaultRequest();
    const invalidInputs = [
      { ...valid, extra: true },
      { ...valid, pageSize: MAX_SESSION_QUERY_PAGE_SIZE + 1 },
      { ...valid, cursor: '' },
      { ...valid, revision: '' },
      {
        campaigns: valid.campaigns,
        cursor: valid.cursor,
        filters: valid.filters,
        pageSize: valid.pageSize,
        range: valid.range,
        sort: valid.sort,
      },
      { ...valid, sort: [{ desc: true, id: 'unknown' }] },
      {
        ...valid,
        sort: [
          { desc: true, id: 'date' },
          { desc: false, id: 'date' },
        ],
      },
      { ...valid, filters: { ...valid.filters, extra: true } },
      { ...valid, filters: { ...valid.filters, fields: { unknown: 'value' } } },
      { ...valid, range: { from: '2026-06-30T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' } },
      { ...valid, range: { from: '2026-06-01', to: null } },
    ];

    for (const input of invalidInputs) {
      expect(() => parseSessionQueryRequest(input)).toThrow(SessionQueryValidationError);
    }
  });

  test('fingerprints semantic query scope canonically and independently of its cursor', () => {
    const first = parseSessionQueryRequest(
      defaultRequest({
        filters: { fields: {}, harness: ['Codex', 'Claude'], machine: [], query: '' },
      }),
    );
    const reordered = parseSessionQueryRequest({
      ...first,
      cursor: 'next-page',
      filters: { ...first.filters, harness: ['Claude', 'Codex'] },
    });

    expect(sessionQueryFingerprint(first)).toBe(sessionQueryFingerprint(reordered));
    expect(sessionQueryFingerprint({ ...first, pageSize: 3 })).not.toBe(sessionQueryFingerprint(first));
    expect(sessionQueryFingerprint({ ...first, campaigns: false })).not.toBe(sessionQueryFingerprint(first));
  });

  test('uses stable presentation identity as the final sort tie-breaker', () => {
    const first = enrichSessionPresentationRow(sourcedRow('a'));
    const second = enrichSessionPresentationRow(sourcedRow('b'));
    const comparator = compareSessionPresentationRows([{ desc: true, id: 'cost' }]);

    expect(comparator(first, second)).toBeLessThan(0);
    expect(comparator(second, first)).toBeGreaterThan(0);
  });

  test('applies presentation, machine, harness, field, and inclusive range filters together', () => {
    const matching = sourcedRow('matching', { rawProject: 'needle' });
    const outsideRange = sourcedRow('outside-range', {
      activeDate: '2026-07-01T12:00:00.000Z',
      date: '2026-07-01T12:00:00.000Z',
      endDate: '2026-07-01T12:00:00.000Z',
      rawProject: 'needle',
    });
    const page = projectSessionPage(
      [matching, outsideRange],
      defaultRequest({
        campaigns: false,
        filters: {
          fields: { model: 'gpt-5.4', project: 'alpha', provider: 'Codex API' },
          harness: ['Codex'],
          machine: ['Machine A'],
          query: 'needle',
        },
        range: { from: '2026-06-10T12:00:00.000Z', to: '2026-06-10T12:00:00.000Z' },
      }),
    );

    expect(page.items.map((item) => item.row.sessionLabel)).toEqual(['matching']);
    expect(page.itemCount).toBe(1);
    expect(page.sessionCount).toBe(1);
  });

  test('projects bounded top-level pages with campaign and underlying session counts', () => {
    const parent = sourcedRow('campaign-root', { costApprox: 1 });
    const child = sourcedRow('campaign-child', {
      costApprox: 9,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        machineLabel: 'Machine A',
        parentSourceSessionId: 'campaign-root',
        rootSourceSessionId: 'campaign-root',
        sourceSessionId: 'campaign-child',
      },
    });
    const standaloneA = sourcedRow('standalone-a', { costApprox: 5 });
    const standaloneB = sourcedRow('standalone-b', { costApprox: 3 });
    const request = defaultRequest({ pageSize: 2, sort: [{ desc: true, id: 'cost' }] });

    const first = projectSessionPage([parent, child, standaloneA, standaloneB], request);
    expect(first.itemCount).toBe(3);
    expect(first.sessionCount).toBe(4);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).toMatchObject({ kind: 'campaign', row: { costApprox: 10 } });
    expect(first.items[0]?.row.children).toBeUndefined();
    expect(first.nextCursor).not.toBeNull();

    const second = projectSessionPage(
      [parent, child, standaloneA, standaloneB],
      parseSessionQueryRequest({ ...request, cursor: first.nextCursor }),
    );
    expect(second.items.map((item) => item.row.sessionLabel)).toEqual(['standalone-b']);
    expect(second.nextCursor).toBeNull();
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
  });

  test('rejects cursors issued for another validated query scope', () => {
    const firstRequest = defaultRequest({ pageSize: 1 });
    const first = projectSessionPage([row('one'), row('two')], firstRequest);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).toBe(sessionQueryNextCursor(firstRequest, first.requestFingerprint, 1));
    expect(sessionQueryPageOffset({ ...firstRequest, cursor: first.nextCursor }, first.requestFingerprint)).toBe(1);

    expect(() =>
      projectSessionPage([row('one'), row('two')], defaultRequest({ cursor: first.nextCursor, pageSize: 2 })),
    ).toThrow(SessionQueryCursorError);
    expect(() =>
      projectSessionPage(
        [row('one'), row('two')],
        defaultRequest({ cursor: first.nextCursor, pageSize: 1, revision: 'revision-2' }),
      ),
    ).toThrow(SessionQueryCursorError);
    expect(() =>
      sessionQueryPageOffset({ ...firstRequest, cursor: first.nextCursor }, 'session-query-v1:mismatch'),
    ).toThrow(SessionQueryCursorError);
    expect(() => sessionQueryNextCursor(firstRequest, first.requestFingerprint, -1)).toThrow(SessionQueryCursorError);
  });

  test('pages filtered campaign children independently of top-level results', () => {
    const parent = sourcedRow('root');
    const children = ['child-a', 'child-b', 'child-c'].map((sourceSessionId) =>
      sourcedRow(sourceSessionId, {
        source: {
          harnessKey: 'codex',
          machineId: 'machine-a',
          machineLabel: 'Machine A',
          parentSourceSessionId: 'root',
          rootSourceSessionId: 'root',
          sourceSessionId,
        },
      }),
    );
    const query = defaultRequest({ pageSize: 1, sort: [{ desc: false, id: 'session' }] });
    const campaignKey = 'machine-a:codex:root';
    const request = parseSessionCampaignChildrenRequest({ campaignKey, query });

    const first = projectSessionCampaignChildren([parent, ...children], request);
    expect(first.campaignKey).toBe(campaignKey);
    expect(first.itemCount).toBe(3);
    expect(first.sessionCount).toBe(3);
    expect(first.items.map((item) => item.sessionLabel)).toEqual(['child-a']);
    expect(first.nextCursor).not.toBeNull();
    expect(first.revision).toBe('revision-1');

    const second = projectSessionCampaignChildren(
      [parent, ...children],
      parseSessionCampaignChildrenRequest({
        campaignKey,
        query: { ...query, cursor: first.nextCursor },
      }),
    );
    expect(second.items.map((item) => item.sessionLabel)).toEqual(['child-b']);
  });

  test('queries neighbors over the full filtered sequence instead of a loaded page', () => {
    const rows = ['alpha', 'beta', 'charlie', 'delta'].map((label) => sourcedRow(label));
    const presentationRows = rows.map(enrichSessionPresentationRow);
    const target = presentationRows.find((candidate) => candidate.sessionLabel === 'charlie');
    expect(target).toBeDefined();

    const request = parseSessionNeighborRequest({
      query: defaultRequest({
        filters: { fields: {}, harness: [], machine: [], query: 'a' },
        pageSize: 1,
        sort: [{ desc: false, id: 'session' }],
      }),
      rowId: target?.rowId,
    });
    const result = projectSessionNeighbors(rows, request);

    expect(result.found).toBe(true);
    expect(result.revision).toBe('revision-1');
    expect(result.previous?.sessionLabel).toBe('beta');
    expect(result.next?.sessionLabel).toBe('delta');
  });

  test('strictly validates child and neighbor protocol envelopes', () => {
    expect(() =>
      parseSessionCampaignChildrenRequest({ campaignKey: 'campaign', extra: true, query: defaultRequest() }),
    ).toThrow(SessionQueryValidationError);
    expect(() => parseSessionNeighborRequest({ query: defaultRequest(), rowId: '' })).toThrow(
      SessionQueryValidationError,
    );
  });

  test('strictly parses every Session query result and server error envelope', () => {
    const rows = [sourcedRow('alpha'), sourcedRow('beta')];
    const pageRequest = defaultRequest({ campaigns: false });
    const page = projectSessionPage(rows, pageRequest);
    expect(parseSessionPageResult(page, pageRequest)).toEqual(page);
    expect(
      parseSessionPageServerResult(
        {
          data: page,
          ok: true,
          requestFingerprint: page.requestFingerprint,
          revision: page.revision,
        },
        pageRequest,
      ),
    ).toEqual({
      data: page,
      ok: true,
      requestFingerprint: page.requestFingerprint,
      revision: page.revision,
    });

    const childRequest = parseSessionCampaignChildrenRequest({
      campaignKey: 'machine-a:codex:alpha',
      query: pageRequest,
    });
    const children = projectSessionCampaignChildren(rows, childRequest);
    expect(parseSessionCampaignChildrenResult(children, childRequest)).toEqual(children);
    expect(
      parseSessionCampaignChildrenServerResult(
        {
          data: children,
          ok: true,
          requestFingerprint: children.requestFingerprint,
          revision: children.revision,
        },
        childRequest,
      ).ok,
    ).toBe(true);

    const neighborRequest = parseSessionNeighborRequest({ query: pageRequest, rowId: page.items[0]?.row.rowId });
    const neighbors = projectSessionNeighbors(rows, neighborRequest);
    expect(parseSessionNeighborResult(neighbors, neighborRequest)).toEqual(neighbors);
    expect(
      parseSessionNeighborServerResult(
        {
          error: { message: 'expired', revision: neighbors.revision, tag: 'RevisionExpired' },
          ok: false,
          requestFingerprint: neighbors.requestFingerprint,
          revision: neighbors.revision,
        },
        neighborRequest,
      ),
    ).toEqual({
      error: { message: 'expired', revision: neighbors.revision, tag: 'RevisionExpired' },
      ok: false,
      requestFingerprint: neighbors.requestFingerprint,
      revision: neighbors.revision,
    });
  });

  test('rejects malformed Session rows, counts, cursors, identities, and error envelopes', () => {
    const request = defaultRequest({ campaigns: false });
    const page = projectSessionPage([sourcedRow('alpha')], request);
    const invalidResults = [
      { ...page, extra: true },
      { ...page, itemCount: -1 },
      { ...page, nextCursor: 'not-a-query-cursor' },
      { ...page, requestFingerprint: 'session-query-v1:wrong' },
      {
        ...page,
        items: [{ ...page.items[0], row: { ...page.items[0]?.row, tokenTotal: 'invalid' } }],
      },
    ];
    for (const result of invalidResults) {
      expect(() => parseSessionPageResult(result, request)).toThrow(SessionQueryValidationError);
    }
    expect(() =>
      parseSessionPageServerResult(
        {
          error: { message: 'failed', revision: request.revision, tag: 'QueryFailed' },
          ok: false,
          requestFingerprint: 'session-query-v1:wrong',
          revision: request.revision,
        },
        request,
      ),
    ).toThrow(SessionQueryValidationError);
  });

  test('keeps a maximum Session page within frozen row and byte budgets', () => {
    const request = defaultRequest({ campaigns: false, pageSize: MAX_SESSION_QUERY_PAGE_SIZE });
    const result = projectSessionPage(
      Array.from({ length: MAX_SESSION_QUERY_PAGE_SIZE + 1 }, (_, index) => sourcedRow(`budget-${index}`)),
      request,
    );
    const envelope = {
      data: result,
      ok: true,
      requestFingerprint: result.requestFingerprint,
      revision: result.revision,
    } as const;

    expect(result.items).toHaveLength(MAX_SESSION_QUERY_PAGE_SIZE);
    expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBeLessThanOrEqual(
      MAX_SESSION_QUERY_RESULT_BYTES,
    );
    expect(parseSessionPageServerResult(envelope, request)).toEqual(envelope);
  });

  test('rejects an otherwise valid Session result above the frozen byte budget', () => {
    const request = defaultRequest({ campaigns: false, pageSize: 1 });
    const result = projectSessionPage([sourcedRow('oversized')], request);
    const item = result.items[0];
    if (item?.kind !== 'session') {
      throw new Error('Expected a Session fixture');
    }
    const oversizedResult = {
      ...result,
      items: [{ ...item, row: { ...item.row, name: 'x'.repeat(MAX_SESSION_QUERY_RESULT_BYTES) } }],
    };

    expect(() => parseSessionPageResult(oversizedResult, request)).toThrow('byte limit');
  });
});
