import { describe, expect, test } from 'bun:test';
import { MAX_SESSION_QUERY_RESULT_BYTES } from './report-budgets';
import type { SerializedRow } from './report-data';
import { parseSessionDetailRequest } from './session-detail';
import {
  campaignBadgeLabelForSessionRow,
  classifierRollupLabelForSessionRow,
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
  sessionOriginLabels,
  sessionQueryFingerprint,
  sessionQueryNextCursor,
  sessionQueryPageOffset,
  sessionRowIdentity,
  sessionSortFields,
  sortValueForSessionColumn,
  UNDECLARED_ORIGIN_DESCRIPTION,
} from './session-query';

const MINUTE_MS = 60_000;
const SESSION_ROW_ID_PATTERN = /^session-row-v1:[a-f0-9]{16}$/;
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
  cursor: null,
  filters: {
    fields: {},
    harness: [],
    machine: [],
    origin: [],
    query: '',
  },
  pageSize: 2,
  range: { from: null, to: null },
  revision: 'revision-1',
  sort: [{ desc: true, id: 'date' }],
  ...overrides,
});

describe('session query contracts', () => {
  test('keeps project identity stable when its display label changes', () => {
    const original = enrichSessionPresentationRow(
      row('Original project label', {
        project: 'Acme App',
        projectGroupId: 'group:acme-app',
        projectSourceId: 'machine-a|/work/acme-app',
        rawProject: 'acme/app',
      }),
    );
    const renamed = enrichSessionPresentationRow(
      row('Renamed project label', {
        project: 'Customer Portal',
        projectGroupId: 'group:acme-app',
        projectSourceId: 'machine-a|/work/acme-app',
        rawProject: 'acme/app',
      }),
    );

    expect(original.projectKey).toBe('group:acme-app');
    expect(renamed.projectKey).toBe(original.projectKey);
    expect(original.projectLabel).toBe('Acme App');
    expect(renamed.projectLabel).toBe('Customer Portal');
  });

  test('falls back from project source identity to a normalized legacy identity', () => {
    const sourced = enrichSessionPresentationRow(
      row('Source identity', {
        project: 'Acme App — Build Host',
        projectSourceId: 'machine-a|/work/acme-app',
        rawProject: 'acme/app',
      }),
    );
    const legacy = enrichSessionPresentationRow(
      row('Legacy identity', { project: '  Acme / APP  ', rawProject: '  Acme / APP  ' }),
    );

    expect(sourced.projectKey).toBe('machine-a|/work/acme-app');
    expect(sourced.projectLabel).toBe('Acme App — Build Host');
    expect(legacy.projectKey).toBe('acme app');
    expect(legacy.projectLabel).toBe('  Acme / APP  ');
  });

  test('keeps session identity stable when only VCS context changes', () => {
    const withoutVcs = sourcedRow('stable-vcs');
    const withVcs = sourcedRow('stable-vcs', {
      source: {
        ...withoutVcs.source!,
        vcs: { branches: [], headCommit: null, partial: false, pullRequests: [], repository: null },
      },
    });

    expect(sessionRowIdentity(withVcs)).toBe(sessionRowIdentity(withoutVcs));
  });

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
    expect(presentation.origin).toBeUndefined();
    expect(enrichSessionPresentationRow({ ...baseRow, origin: 'classifier' }).origin).toBe('classifier');
    expect(sessionOriginLabels).toEqual({
      classifier: 'Automated review',
      human: 'Human',
      subagent: 'Delegated',
    });
    expect(UNDECLARED_ORIGIN_DESCRIPTION).toBe('Undeclared — this harness did not state how the session was started.');
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
      1,
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
    expect(
      sortValueForSessionColumn(
        enrichSessionPresentationRow(row('Unknown price', { costApprox: 0, costKnown: false })),
        'cost',
      ),
    ).toBe(Number.NEGATIVE_INFINITY);
  });

  test('builds stable JSON-safe presentation identity and search fields', () => {
    const input = sourcedRow('source-a', { models: ['gpt-5.4', 'gpt-5.4-mini'], rawProject: 'repo' });
    const first = enrichSessionPresentationRow(input);
    const second = enrichSessionPresentationRow({ ...input });

    expect(first).toEqual(second);
    expect(first.activeTime).toBe(Date.parse('2026-06-10T12:00:00.000Z'));
    expect(first.modelKey).toBe('gpt-5.4');
    expect(first.modelLabel).toBe('gpt-5.4 → gpt-5.4-mini');
    expect(first.sortModel).toBe('gpt-5.4');
    expect(first.providerDisplay).toBe('Codex API');
    expect(first.rowId).toMatch(SESSION_ROW_ID_PATTERN);
    expect(first.searchText).toContain('source-a alpha repo');
    expect(first.searchText).toContain('gpt-5.4 → gpt-5.4-mini');
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  test('builds bounded unambiguous row identities accepted by session detail', () => {
    const longProject = 'project/'.repeat(100);
    const longLabel = 'session '.repeat(100);
    const identity = sessionRowIdentity(
      sourcedRow('source-a', {
        name: longLabel,
        project: longProject,
        sessionLabel: longLabel,
      }),
    );
    const delimiterVariant = sessionRowIdentity(
      sourcedRow('source|a', {
        project: 'alpha',
        provider: 'Codex API',
      }),
    );
    const shiftedDelimiterVariant = sessionRowIdentity(
      sourcedRow('source', {
        project: 'alpha',
        provider: 'a|Codex API',
      }),
    );

    expect(identity).toMatch(SESSION_ROW_ID_PATTERN);
    expect(parseSessionDetailRequest({ revision: 'revision-1', rowId: identity })).toEqual({
      revision: 'revision-1',
      rowId: identity,
    });
    expect(delimiterVariant).not.toBe(shiftedDelimiterVariant);

    const firstSource = sessionRowIdentity(
      row('source-less', { projectSourceId: 'source:first', rawProject: 'shared-project' }),
    );
    const secondSource = sessionRowIdentity(
      row('source-less', { projectSourceId: 'source:second', rawProject: 'shared-project' }),
    );
    expect(firstSource).not.toBe(secondSource);
  });

  test('strictly validates and canonically normalizes query inputs', () => {
    const parsed = parseSessionQueryRequest({
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
      origin: [],
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
      { ...valid, campaigns: false },
      {
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
    expect(
      sessionQueryFingerprint({
        ...first,
        filters: { ...first.filters, origin: ['human', 'subagent'] },
      }),
    ).not.toBe(sessionQueryFingerprint(first));
  });

  test('uses stable presentation identity as the final sort tie-breaker', () => {
    const first = enrichSessionPresentationRow(sourcedRow('a'));
    const second = enrichSessionPresentationRow(sourcedRow('b'));
    const comparator = compareSessionPresentationRows([{ desc: true, id: 'cost' }]);
    const forward = comparator(first, second);

    expect(forward).not.toBe(0);
    expect(comparator(second, first)).toBe(-forward);
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
        filters: {
          fields: { model: 'gpt-5.4', project: 'needle', provider: 'Codex API' },
          harness: ['Codex'],
          machine: ['machine-a'],
          query: 'needle',
        },
        range: { from: '2026-06-10T12:00:00.000Z', to: '2026-06-10T12:00:00.000Z' },
      }),
    );

    expect(page.items.map((item) => item.row.sessionLabel)).toEqual(['matching']);
    expect(page.itemCount).toBe(1);
    expect(page.sessionCount).toBe(1);
  });

  test('matches a model filter against secondary segmented and legacy observations', () => {
    const mixed = sourcedRow('mixed-model', {
      costApprox: 3,
      freshTokens: 30,
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'claude-sonnet-4-6'],
      modelSegments: [
        {
          costApprox: 2,
          costKnown: true,
          model: 'gpt-5.4',
          tokCr: 0,
          tokCw: 0,
          tokIn: 10,
          tokOut: 0,
        },
        {
          costApprox: 1,
          costKnown: true,
          model: 'claude-sonnet-4-6',
          tokCr: 0,
          tokCw: 0,
          tokIn: 0,
          tokOut: 20,
        },
      ],
      tokCr: 0,
      tokCw: 0,
      tokIn: 10,
      tokOut: 20,
      tokenTotal: 30,
    });

    const page = projectSessionPage(
      [mixed],
      defaultRequest({
        filters: { fields: { model: 'claude-sonnet-4-6' }, harness: [], machine: [], query: '' },
      }),
    );
    const legacy = sourcedRow('legacy-mixed-model', {
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'claude-sonnet-4-6'],
    });
    const legacyPage = projectSessionPage(
      [legacy],
      defaultRequest({
        filters: { fields: { model: 'claude-sonnet-4-6' }, harness: [], machine: [], query: '' },
      }),
    );

    expect(page.items.map((item) => item.row.sessionLabel)).toEqual(['mixed-model']);
    expect(legacyPage.items.map((item) => item.row.sessionLabel)).toEqual(['legacy-mixed-model']);
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

  test('keeps singleton campaigns visible and rolls classifier usage into the filtered parent campaign', () => {
    const root = sourcedRow('campaign-root', { freshTokens: 20, origin: 'human', subagent: false });
    const delegated = sourcedRow('campaign-child', {
      freshTokens: 7,
      origin: 'subagent',
      subagent: true,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        machineLabel: 'Machine A',
        parentSourceSessionId: 'campaign-root',
        rootSourceSessionId: 'campaign-root',
        sourceSessionId: 'campaign-child',
      },
    });
    const classifier = sourcedRow('classifier-review', {
      freshTokens: 3,
      origin: 'classifier',
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        machineLabel: 'Machine A',
        parentSourceSessionId: 'campaign-root',
        rootSourceSessionId: 'campaign-root',
        sourceSessionId: 'classifier-review',
      },
    });
    const rows = [root, delegated, classifier];
    const request = defaultRequest({
      filters: {
        fields: {},
        harness: [],
        machine: [],
        origin: ['human', 'subagent'],
        query: '',
      },
      pageSize: 10,
    });

    const page = projectSessionPage(rows, request);
    const item = page.items[0];
    if (item?.kind !== 'campaign') {
      throw new Error('Expected a campaign fixture');
    }
    expect(page.itemCount).toBe(1);
    expect(page.sessionCount).toBe(2);
    expect(item.row).toMatchObject({
      campaignClassifierCount: 1,
      campaignClassifierFreshTokens: 3,
      campaignTotalCount: 3,
      campaignVisibleCount: 2,
      freshTokens: 30,
      sessionLabel: 'campaign-root',
      subagent: false,
    });
    expect(campaignBadgeLabelForSessionRow(item.row)).toBe('Campaign · 2 sessions');
    expect(classifierRollupLabelForSessionRow(item.row)).toBe('+ 1 automated review');

    const children = projectSessionCampaignChildren(rows, {
      campaignKey: item.campaignKey,
      query: request,
    });
    expect(children.itemCount).toBe(2);
    expect(children.sessionCount).toBe(1);
    expect(children.items.map(({ origin }) => origin).sort()).toEqual(['classifier', 'subagent']);
    expect(children.items.find(({ origin }) => origin === 'subagent')?.subagent).toBe(true);

    const classifierOnly = projectSessionPage(
      rows,
      defaultRequest({
        filters: { fields: {}, harness: [], machine: [], origin: ['classifier'], query: '' },
        pageSize: 10,
      }),
    );
    expect(classifierOnly).toMatchObject({
      itemCount: 1,
      items: [{ kind: 'campaign', row: { campaignVisibleCount: 1, sessionLabel: 'campaign-root' } }],
      sessionCount: 1,
    });
  });

  test('represents every singleton as a one-session campaign', () => {
    const page = projectSessionPage(
      [sourcedRow('singleton', { origin: 'human', subagent: false })],
      defaultRequest({
        filters: { fields: {}, harness: [], machine: [], origin: ['human', 'subagent'], query: '' },
        pageSize: 10,
      }),
    );
    const item = page.items[0];
    if (item?.kind !== 'campaign') {
      throw new Error('Expected a singleton campaign fixture');
    }
    expect(item.row).toMatchObject({ campaignTotalCount: 1, campaignVisibleCount: 1, subagent: false });
    expect(campaignBadgeLabelForSessionRow(item.row)).toBe('Campaign · 1 session');
  });

  test('rejects classifier sessions without a resolvable declared parent campaign', () => {
    expect(() =>
      projectSessionPage([sourcedRow('classifier-root', { origin: 'classifier' })], defaultRequest()),
    ).toThrow('has no declared parent campaign');
    expect(() =>
      projectSessionPage(
        [
          sourcedRow('classifier-review', {
            origin: 'classifier',
            source: {
              harnessKey: 'codex',
              machineId: 'machine-a',
              machineLabel: 'Machine A',
              parentSourceSessionId: 'missing-root',
              rootSourceSessionId: 'missing-root',
              sourceSessionId: 'classifier-review',
            },
          }),
        ],
        defaultRequest(),
      ),
    ).toThrow('has no resolvable parent session');
  });

  test('uses root duration and model identity for campaigns with overlapping child rollouts', () => {
    const rootDurationMinutes = 517;
    const childDurationsMinutes = [300, 126];
    const root = sourcedRow('campaign-root', {
      activeDate: '2026-06-10T12:00:00.000Z',
      durationMs: rootDurationMinutes * MINUTE_MS,
      model: 'gpt-5.6-sol',
      modelSegments: [
        {
          costApprox: 0.8,
          costKnown: true,
          model: 'gpt-5.6-sol',
          tokCr: 0,
          tokCw: 0,
          tokIn: 10,
          tokOut: 5,
        },
        {
          costApprox: 0.2,
          costKnown: true,
          model: 'gpt-5.6-terra',
          tokCr: 3,
          tokCw: 2,
          tokIn: 0,
          tokOut: 0,
        },
      ],
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    });
    const children = childDurationsMinutes.map((durationMinutes, index) =>
      sourcedRow(`campaign-child-${index}`, {
        activeDate: `2026-06-10T1${index + 3}:00:00.000Z`,
        durationMs: durationMinutes * MINUTE_MS,
        model: 'gpt-5.6-terra',
        models: ['gpt-5.6-terra'],
        source: {
          harnessKey: 'codex',
          machineId: 'machine-a',
          machineLabel: 'Machine A',
          parentSourceSessionId: 'campaign-root',
          rootSourceSessionId: 'campaign-root',
          sourceSessionId: `campaign-child-${index}`,
        },
      }),
    );
    const page = projectSessionPage(
      [root, ...children],
      defaultRequest({ pageSize: 1, sort: [{ desc: false, id: 'model' }] }),
    );
    const item = page.items[0];
    if (item?.kind !== 'campaign') {
      throw new Error('Expected a campaign fixture');
    }
    const cumulativeRolloutDurationMs = [root, ...children].reduce(
      (total, campaignRow) => total + (campaignRow.durationMs ?? 0),
      0,
    );

    expect(cumulativeRolloutDurationMs).toBe(943 * MINUTE_MS);
    expect(item.row.durationMs).toBe(rootDurationMinutes * MINUTE_MS);
    expect(item.row.durationMs).not.toBe(cumulativeRolloutDurationMs);
    expect(item.row.model).toBe('gpt-5.6-sol');
    expect(item.row.modelSegments).toBeUndefined();
    expect(item.row.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(item.row.modelLabel).toBe('gpt-5.6-sol → gpt-5.6-terra');
    expect(item.row.modelKey).toBe('gpt-5.6-sol');
    expect(item.row.sortModel).toBe('gpt-5.6-sol');
    expect(sortValueForSessionColumn(item.row, 'model')).toBe('gpt-5.6-sol');
  });

  test('keeps the known API-value subtotal when one campaign rollout has incomplete pricing', () => {
    const root = sourcedRow('campaign-root', { costApprox: 68.09 });
    const partiallyPricedChild = sourcedRow('campaign-child', {
      costApprox: 1.21,
      costKnown: false,
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        machineLabel: 'Machine A',
        parentSourceSessionId: 'campaign-root',
        rootSourceSessionId: 'campaign-root',
        sourceSessionId: 'campaign-child',
      },
    });
    const page = projectSessionPage(
      [root, partiallyPricedChild],
      defaultRequest({ pageSize: 1, sort: [{ desc: true, id: 'cost' }] }),
    );
    const item = page.items[0];
    if (item?.kind !== 'campaign') {
      throw new Error('Expected a campaign fixture');
    }

    expect(item.row.costKnown).toBe(false);
    expect(item.row.costApprox).toBeCloseTo(69.3);
    expect(item.row.priceMeasurement).toEqual({
      knownCost: 69.3,
      state: 'partially measured',
      unpricedFreshTokens: 17,
    });
  });

  test('preserves partial measurement provenance for a wholly unpriced singleton campaign', () => {
    const unpriced = sourcedRow('unknown-price-root', { costApprox: 0, costKnown: false });
    const page = projectSessionPage([unpriced], defaultRequest({ pageSize: 1 }));
    const item = page.items[0];
    if (item?.kind !== 'campaign') {
      throw new Error('Expected an unpriced campaign fixture');
    }

    expect(item.row.priceMeasurement).toEqual({
      knownCost: 0,
      state: 'partially measured',
      unpricedFreshTokens: 17,
    });
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
      projectSessionPage(
        [row('one'), row('two')],
        defaultRequest({
          cursor: first.nextCursor,
          filters: { ...firstRequest.filters, origin: ['classifier'] },
          pageSize: 1,
        }),
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
    const pageRequest = defaultRequest();
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
    const request = defaultRequest();
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
      {
        ...page,
        items: [
          {
            ...page.items[0],
            row: {
              ...page.items[0]?.row,
              priceMeasurement: { knownCost: 2, state: 'measured', unpricedFreshTokens: 0 },
            },
          },
        ],
      },
    ];
    for (const result of invalidResults) {
      expect(() => parseSessionPageResult(result, request)).toThrow(SessionQueryValidationError);
    }
    const segmentedRoot = sourcedRow('segmented-root');
    const segmentedChild = sourcedRow('segmented-child', {
      modelSegments: [
        {
          costApprox: 1,
          costKnown: true,
          model: 'openai/gpt-5.4-high',
          tokCr: 3,
          tokCw: 2,
          tokIn: 10,
          tokOut: 5,
        },
      ],
      source: {
        harnessKey: 'codex',
        machineId: 'machine-a',
        machineLabel: 'Machine A',
        parentSourceSessionId: 'segmented-root',
        rootSourceSessionId: 'segmented-root',
        sourceSessionId: 'segmented-child',
      },
    });
    const segmentedRequest = parseSessionCampaignChildrenRequest({
      campaignKey: 'machine-a:codex:segmented-root',
      query: request,
    });
    const segmentedChildren = projectSessionCampaignChildren([segmentedRoot, segmentedChild], segmentedRequest);
    const segmentedItem = segmentedChildren.items[0];
    if (!segmentedItem?.modelSegments?.[0]) {
      throw new Error('Expected a segmented campaign child fixture');
    }
    const segment = segmentedItem.modelSegments[0];
    expect(() =>
      parseSessionCampaignChildrenResult(
        {
          ...segmentedChildren,
          items: [
            {
              ...segmentedItem,
              modelSegments: [{ ...segment, tokIn: segment.tokIn + 1 }],
            },
          ],
        },
        segmentedRequest,
      ),
    ).toThrow(SessionQueryValidationError);
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
    const request = defaultRequest({ pageSize: MAX_SESSION_QUERY_PAGE_SIZE });
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
    const request = defaultRequest({ pageSize: 1 });
    const result = projectSessionPage([sourcedRow('oversized')], request);
    const item = result.items[0];
    if (item?.kind !== 'campaign') {
      throw new Error('Expected a campaign fixture');
    }
    const oversizedResult = {
      ...result,
      items: [{ ...item, row: { ...item.row, name: 'x'.repeat(MAX_SESSION_QUERY_RESULT_BYTES) } }],
    };

    expect(() => parseSessionPageResult(oversizedResult, request)).toThrow('byte limit');
  });
});
