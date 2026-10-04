import { describe, expect, test } from 'bun:test';
import { buildCampaignMap, campaignMapTitle } from './campaign-map';
import type { SerializedRow } from './report-data';
import {
  buildSessionCampaignViews,
  enrichSessionPresentationRow,
  parseSessionCampaignChildrenResult,
  parseSessionQueryRequest,
  projectSessionCampaignChildren,
  type SessionPresentationRow,
  sessionCampaignIdentityForRow,
} from './session-query';

const MINUTE = 60_000;
const START = Date.parse('2026-06-11T08:00:00.000Z');
const at = (minutes: number) => new Date(START + minutes * MINUTE).toISOString();

const row = (id: string, overrides: Partial<SerializedRow> = {}): SessionPresentationRow =>
  enrichSessionPresentationRow({
    activeDate: at(80),
    calls: 1,
    costActual: null,
    costApprox: 0,
    costKnown: true,
    date: at(0),
    durationMs: MINUTE,
    endDate: at(80),
    freshTokens: 30,
    harness: 'Codex',
    lineDelta: null,
    linesAdded: null,
    linesDeleted: null,
    model: 'gpt-6',
    name: id,
    origin: id === 'root' ? 'human' : 'subagent',
    project: 'world-state',
    provider: 'Codex API',
    sessionLabel: id,
    source: {
      harnessKey: 'codex',
      machineId: 'workstation',
      machineLabel: 'Workstation',
      parentSourceSessionId: id === 'root' ? null : 'root',
      rootSourceSessionId: 'root',
      sourceSessionId: id,
    },
    titleSource: 'id',
    tokCr: 10,
    tokCw: 0,
    tokIn: 20,
    tokOut: 10,
    tokenTotal: 40,
    tools: 2,
    turns: 1,
    ...overrides,
  });

const project = (
  root: SessionPresentationRow,
  children: SessionPresentationRow[] = [],
  totalCount = children.length + 1,
) => buildCampaignMap({ campaignKey: sessionCampaignIdentityForRow(root).campaignKey, children, root, totalCount });

const sourcedChild = (id: string, parent: string, overrides: Partial<SerializedRow> = {}) =>
  row(id, {
    source: {
      harnessKey: 'codex',
      machineId: 'workstation',
      machineLabel: 'Workstation',
      parentSourceSessionId: parent,
      rootSourceSessionId: 'root',
      sourceSessionId: id,
    },
    ...overrides,
  });

describe('campaign temporal map', () => {
  test('preserves canonical grouping, emits root first and ordered nested children without changing source facts', () => {
    const root = row('root', { sessionLabel: 'Forecast v3', titleSource: 'first-prompt' });
    const model = row('model', { date: at(5), endDate: at(35) });
    const ingestion = row('ingestion', { date: at(10), endDate: at(60), model: 'gpt-6-mini' });
    const tests = sourcedChild('tests', 'ingestion', { date: at(20), endDate: at(45) });
    const review = row('review', { date: at(50), endDate: at(75), origin: 'classifier' });
    const rows = [tests, model, review, root, ingestion];
    const before = JSON.stringify(rows);
    const campaigns = buildSessionCampaignViews(rows, rows);
    expect(campaigns).toHaveLength(1);
    const campaign = campaigns[0]!;
    const map = buildCampaignMap({
      campaignKey: campaign.campaignKey,
      children: campaign.allChildren,
      root: campaign.root,
      totalCount: campaign.totalCount,
    });
    expect(map.nodes.map(({ row: member }) => member.source?.sourceSessionId)).toEqual([
      'root',
      'model',
      'ingestion',
      'tests',
      'review',
    ]);
    expect(map.nodes.map(({ depth }) => depth)).toEqual([0, 1, 1, 2, 1]);
    expect(map.nodes[3]?.parentRowId).toBe(ingestion.rowId);
    expect(map).toMatchObject({
      harnesses: ['Codex'],
      loadedCount: 5,
      maxConcurrency: 4,
      models: ['gpt-6', 'gpt-6-mini'],
      omittedCount: 0,
      timingComplete: true,
      title: 'Forecast v3',
      tokenTotal: 200,
      totalCount: 5,
      usageComplete: true,
      wallClockDurationMs: 80 * MINUTE,
    });
    expect(JSON.stringify(rows)).toBe(before);
    expect(project(root, [review, tests, ingestion, model])).toEqual(map);
  });

  test('bounds span all members, including a child earlier and later than its root, independently of active duration', () => {
    const map = project(row('root', { date: at(10), durationMs: 1, endDate: at(20) }), [
      row('early', { date: at(0), endDate: at(15) }),
      row('late', { date: at(18), endDate: at(80) }),
    ]);
    expect(map.startedAt).toBe(at(0));
    expect(map.endedAt).toBe(at(80));
    expect(map.wallClockDurationMs).toBe(80 * MINUTE);
    expect(map.maxConcurrency).toBe(2);
  });

  test('touching intervals and zero-duration points do not inflate overlap', () => {
    const map = project(row('root', { date: at(0), endDate: at(10) }), [
      row('next', { date: at(10), endDate: at(20) }),
      row('point', { date: at(10), endDate: at(10) }),
    ]);
    expect(map.maxConcurrency).toBe(1);
    expect(project(row('root', { date: at(0), endDate: at(0) })).maxConcurrency).toBe(0);
  });

  test('missing or reversed timestamps remain local limitations and never borrow durationMs', () => {
    const map = project(row('root'), [
      row('no-start', { date: null, durationMs: 42_000 }),
      row('no-end', { endDate: null }),
      row('no-time', { date: null, endDate: null }),
      row('reversed', { date: at(50), endDate: at(10) }),
      row('invalid', { date: 'invalid timestamp' }),
    ]);
    const statuses = Object.fromEntries(map.nodes.map((node) => [node.row.name, node.timingStatus]));
    expect(statuses).toEqual({
      invalid: 'invalid',
      'no-end': 'missing-end',
      'no-start': 'missing-start',
      'no-time': 'unavailable',
      reversed: 'invalid',
      root: 'recorded',
    });
    expect(map.timingComplete).toBe(false);
    expect(map.maxConcurrency).toBeNull();
    expect(map.observedMaxConcurrency).toBe(1);
    expect(project(row('root', { date: null, endDate: null }))).toMatchObject({
      endedAt: null,
      startedAt: null,
      wallClockDurationMs: null,
    });
  });

  test('off-page parents remain detached and omitted sessions keep metrics partial', () => {
    const root = row('root');
    const child = sourcedChild('nested', 'off-page');
    const map = project(root, [child], 20);
    expect(map.nodes[1]).toMatchObject({
      depth: 0,
      lineageIssue: 'parent-unavailable',
      parentRowId: null,
      relationship: 'unresolved',
    });
    expect(map).toMatchObject({
      loadedCount: 2,
      maxConcurrency: null,
      observedMaxConcurrency: 2,
      omittedCount: 18,
      timingComplete: false,
      tokenTotal: 80,
      totalCount: 20,
      usageComplete: false,
    });
    expect(map.wallClockDurationMs).toBeNull();
    expect(map.observedSpanMs).toBe(80 * MINUTE);
  });

  test('appends exact campaign pages and resolves a later parent without counting the repeated root twice', () => {
    const root = row('root', {
      activeDate: at(210),
      endDate: at(210),
      freshTokens: 300,
      tokCr: 100,
      tokenTotal: 400,
      tokIn: 200,
      tokOut: 100,
    });
    const nested = sourcedChild('nested', 'late-parent', {
      activeDate: at(30),
      date: at(20),
      endDate: at(30),
    });
    const parent = row('late-parent', { activeDate: at(200), endDate: at(200) });
    const siblings = Array.from({ length: 149 }, (_, index) =>
      row(`sibling-${index}`, { activeDate: at(index + 40), endDate: at(index + 40) }),
    );
    const rows = [root, nested, ...siblings, parent];
    const campaignKey = sessionCampaignIdentityForRow(root).campaignKey;
    const query = parseSessionQueryRequest({
      cursor: null,
      filters: { fields: {}, harness: [], machine: [], origin: [], query: '' },
      pageSize: 100,
      range: { from: null, to: null },
      revision: 'campaign-pagination-revision',
      sort: [{ desc: false, id: 'date' }],
    });
    const firstRequest = { campaignKey, query };
    const firstPage = parseSessionCampaignChildrenResult(
      projectSessionCampaignChildren(rows, firstRequest),
      firstRequest,
    );
    expect(firstPage.items).toHaveLength(100);
    expect(firstPage.itemCount).toBe(151);
    expect(firstPage.root?.rowId).toBe(root.rowId);
    expect(firstPage.nextCursor).not.toBeNull();
    const firstMap = project(firstPage.root!, firstPage.items, firstPage.itemCount + 1);
    expect(firstMap.nodes).toHaveLength(101);
    expect(firstMap.omittedCount).toBe(51);
    expect(firstMap.tokenTotal).toBe(400 + 100 * 40);
    expect(firstMap.nodes.find(({ row: member }) => member.rowId === nested.rowId)).toMatchObject({
      depth: 0,
      lineageIssue: 'parent-unavailable',
      parentRowId: null,
      relationship: 'unresolved',
    });

    const secondRequest = { campaignKey, query: { ...query, cursor: firstPage.nextCursor } };
    const secondPage = parseSessionCampaignChildrenResult(
      projectSessionCampaignChildren(rows, secondRequest),
      secondRequest,
    );
    expect(secondPage.items).toHaveLength(51);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.revision).toBe(firstPage.revision);
    expect(secondPage.requestFingerprint).toBe(firstPage.requestFingerprint);
    expect(secondPage.root?.rowId).toBe(firstPage.root?.rowId);
    const completeMap = project(firstPage.root!, [...firstPage.items, ...secondPage.items], firstPage.itemCount + 1);
    expect(completeMap.nodes).toHaveLength(152);
    expect(new Set(completeMap.nodes.map(({ row: member }) => member.rowId)).size).toBe(152);
    expect(completeMap.nodes.filter(({ relationship }) => relationship === 'root')).toHaveLength(1);
    expect(completeMap.omittedCount).toBe(0);
    expect(completeMap.tokenTotal).toBe(400 + 151 * 40);
    expect(completeMap.usageComplete).toBe(true);
    expect(completeMap.timingComplete).toBe(true);
    expect(completeMap.nodes.find(({ row: member }) => member.rowId === nested.rowId)).toMatchObject({
      depth: 2,
      lineageIssue: null,
      parentRowId: parent.rowId,
      relationship: 'child',
    });
    expect(() =>
      projectSessionCampaignChildren(rows, {
        ...secondRequest,
        query: { ...secondRequest.query, revision: 'another-revision' },
      }),
    ).toThrow('cursor does not match');
  });

  test('partial observed span includes end-only and start-only anchors without inventing a complete wall clock', () => {
    const map = project(row('root'), [
      row('earlier-end', { date: null, endDate: at(-20) }),
      row('later-start', { date: at(100), endDate: null }),
    ]);
    expect(map.wallClockDurationMs).toBeNull();
    expect(map.observedSpanMs).toBe(120 * MINUTE);
    expect(project(row('root', { date: null })).observedSpanMs).toBeNull();
    expect(project(row('root', { endDate: null })).observedSpanMs).toBeNull();
    expect(project(row('root', { date: null, endDate: null })).observedSpanMs).toBeNull();
  });

  test('cycles and self-parents are detached without dropping nodes or inventing a parent', () => {
    const first = sourcedChild('first', 'second');
    const second = sourcedChild('second', 'first');
    const self = sourcedChild('self', 'self');
    const descendant = sourcedChild('descendant', 'first');
    const map = project(row('root'), [first, second, self, descendant]);
    expect(map.nodes).toHaveLength(5);
    expect(new Set(map.nodes.map(({ row: member }) => member.rowId)).size).toBe(5);
    for (const id of ['first', 'second', 'self']) {
      expect(map.nodes.find(({ row: member }) => member.name === id)).toMatchObject({
        depth: 0,
        lineageIssue: 'cycle',
        parentRowId: null,
        relationship: 'unresolved',
      });
    }
    expect(map.nodes.find(({ row: member }) => member.name === 'descendant')).toMatchObject({
      depth: 1,
      parentRowId: first.rowId,
      relationship: 'child',
    });
  });

  test('ambiguous source identities cannot silently select the wrong parent', () => {
    const one = row('parent', { sessionLabel: 'First', titleSource: 'ai' });
    const two = row('parent', { sessionLabel: 'Second', titleSource: 'ai' });
    const map = project(row('root'), [one, two, sourcedChild('child', 'parent')]);
    expect(map.nodes.find(({ row: member }) => member.name === 'child')).toMatchObject({
      lineageIssue: 'ambiguous-parent',
      parentRowId: null,
      relationship: 'unresolved',
    });
  });

  test('root-only classifiers retain review association while ordinary root-only descendants disclose missing edges', () => {
    const source = { harnessKey: 'codex', machineId: 'workstation', rootSourceSessionId: 'root' };
    const map = project(row('root'), [
      row('review', { origin: 'classifier', source: { ...source, sourceSessionId: 'review' } }),
      row('unlinked', { source: { ...source, sourceSessionId: 'unlinked' } }),
    ]);
    expect(map.nodes.find(({ row: member }) => member.name === 'review')).toMatchObject({
      depth: 1,
      lineageIssue: null,
      relationship: 'review',
    });
    expect(map.nodes.find(({ row: member }) => member.name === 'unlinked')).toMatchObject({
      depth: 0,
      lineageIssue: 'parent-undeclared',
      relationship: 'unresolved',
    });
  });

  test('standalone, source-less, parentless review and weak Claude lineage each preserve canonical membership', () => {
    const { origin: _origin, source: _source, ...sourceLess } = row('plain');
    const review = row('review', { origin: 'classifier', source: { harnessKey: 'codex', sourceSessionId: 'review' } });
    const weakClaude = row('weak', {
      harness: 'Claude',
      source: {
        harnessKey: 'claude',
        parentSourceSessionId: 'missing',
        rootSourceSessionId: 'weak',
        sourceSessionId: 'weak',
      },
    });
    const rows = [sourceLess, review, weakClaude];
    const campaigns = buildSessionCampaignViews(rows, rows);
    expect(campaigns).toHaveLength(3);
    for (const campaign of campaigns) {
      const map = project(campaign.root, campaign.allChildren, campaign.totalCount);
      expect(map.nodes).toHaveLength(1);
      expect(map.nodes[0]?.relationship).toBe('root');
    }
    expect(project(weakClaude).nodes[0]?.lineageIssue).toBe('parent-unavailable');
    expect(project(sourceLess).nodes[0]?.lineageIssue).toBeNull();
  });

  test('rejects mismatched canonical campaigns, duplicate rows and impossible total counts', () => {
    const root = row('root');
    expect(() => project(root, [root])).toThrow('duplicate');
    expect(() => project(root, [], 0)).toThrow('totalCount');
    expect(() => project(root, [], 1.5)).toThrow('totalCount');
    const foreign = row('foreign', {
      source: { harnessKey: 'codex', machineId: 'other', rootSourceSessionId: 'root', sourceSessionId: 'foreign' },
    });
    expect(() => project(root, [foreign])).toThrow('different canonical campaign');
  });

  test('partial token measurement is local to usage and does not hide complete chronology', () => {
    const map = project(row('root'), [row('child', { usageUnavailable: true, tokenTotal: 0 })]);
    expect(map.tokenTotal).toBe(40);
    expect(map.usageComplete).toBe(false);
    expect(map.timingComplete).toBe(true);
  });

  test('deep parent chains remain iterative and deterministic', () => {
    const children = Array.from({ length: 12_000 }, (_, index) =>
      sourcedChild(`deep-${index}`, index === 0 ? 'root' : `deep-${index - 1}`),
    );
    const map = project(row('root'), children.toReversed());
    expect(map.nodes).toHaveLength(12_001);
    expect(map.nodes.at(-1)?.depth).toBe(12_000);
    expect(map.maxConcurrency).toBe(12_001);
  });
});

describe('campaign display intent', () => {
  test('retains existing strong titles and bounded prompt-derived labels', () => {
    expect(campaignMapTitle(row('root', { sessionLabel: '  Forecast\n model   v3 ', titleSource: 'ai' }))).toBe(
      'Forecast model v3',
    );
    expect(
      campaignMapTitle(row('root', { sessionLabel: 'Fix the ingestion pipeline', titleSource: 'first-prompt' })),
    ).toBe('Fix the ingestion pipeline');
    const compact = campaignMapTitle(
      row('root', { sessionLabel: 'Long intent '.repeat(30), titleSource: 'first-prompt' }),
    );
    expect(compact.length).toBeLessThanOrEqual(120);
    expect(compact.endsWith('…')).toBe(true);
  });

  test('uses deterministic project and harness fallbacks without accessing prompts', () => {
    expect(campaignMapTitle(row('root'))).toBe('world-state · Codex session');
    expect(campaignMapTitle(row('root', { project: '', harness: 'Claude' }))).toBe('Claude session');
    expect(campaignMapTitle(row('root', { origin: 'classifier' }))).toBe('world-state · Codex review');
  });

  test('adds nearest useful parent context to generic children while preserving independent child intent', () => {
    const root = row('root', { sessionLabel: 'Forecast v3', titleSource: 'ai' });
    const parent = row('ingestion', { sessionLabel: 'Normalize market observations', titleSource: 'first-prompt' });
    const generic = sourcedChild('nested', 'ingestion', { sessionLabel: 'Astra', titleSource: 'agent-role' });
    const map = project(root, [generic, parent, row('generic')]);
    expect(map.nodes.find(({ row: member }) => member.name === 'ingestion')?.title).toBe(
      'Normalize market observations',
    );
    expect(map.nodes.find(({ row: member }) => member.name === 'nested')).toMatchObject({
      title: 'Astra · Normalize market observations',
      titleInherited: true,
    });
    expect(map.nodes.find(({ row: member }) => member.name === 'generic')?.title).toBe(
      'Delegated session · Forecast v3',
    );
  });
});
