import { expect, test } from 'bun:test';
import type { DatavizPrototypeSnapshot, PrototypeRow } from '@ai-usage/web-contract/dataviz-prototype';
import {
  alluvial,
  campaignArcs,
  campaignPartition,
  filterRows,
  ridgeline,
  temporal,
  weeklySeries,
} from './dataviz-model';

const row = (id: string, extra: Partial<PrototypeRow> = {}): PrototypeRow => ({
  id,
  sourceId: id,
  parentId: null,
  campaign: 'campaign',
  campaignLabel: 'Campaign',
  root: false,
  label: id,
  harness: 'Codex',
  project: 'p',
  projectLabel: 'Project',
  day: '2026-09-09',
  tokens: 100,
  partial: false,
  segments: [
    { model: 'a', tokens: 70 },
    { model: 'b', tokens: 30 },
  ],
  ...extra,
});
const snapshot = (rows: PrototypeRow[]): DatavizPrototypeSnapshot => ({
  version: 1,
  revision: 'r',
  capturedAt: '2026-09-09T12:00:00Z',
  generatedAt: '2026-09-09T12:00:00Z',
  rows,
  details: [],
});
test('alluvial and weekly series preserve contributions of multiple models including grouped tails', () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    row(String(i), { project: String(i), projectLabel: String(i), segments: [{ model: String(i), tokens: 100 }] }),
  );
  expect(alluvial(rows, '').rows.reduce((n, r) => n + Number(r[3]), 0)).toBe(900);
  expect(
    weeklySeries(rows)
      .values.flat()
      .reduce((a, b) => a + b, 0),
  ).toBe(900);
  const mixed = weeklySeries([row('mixed')]);
  expect(mixed.values.map((v) => v[0])).toEqual([70, 30, 0]);
});
test('periods are inclusive UTC dates, anchored to capture, with project identity preserved', () => {
  const data = snapshot([
    row('last'),
    row('boundary', { day: '2026-08-27' }),
    row('before', { day: '2026-08-26' }),
    row('undated', { day: null }),
    row('other', { project: 'other' }),
  ]);
  expect(filterRows(data, 14, 'p').map((r) => r.id)).toEqual(['last', 'boundary']);
  expect(filterRows(data, 0, 'p')).toHaveLength(4);
});
test('campaign partition counts parent own tokens once and includes descendants on zoom', () => {
  const rows = [
    row('root', { root: true }),
    row('child', { parentId: 'root' }),
    row('grandchild', { parentId: 'child' }),
  ];
  expect(campaignPartition(rows, 'campaign', '').rows.map((r) => r[2])).toEqual(['300', '200', '100']);
  expect(campaignPartition(rows, 'campaign', 'child').marks).toContainEqual(
    expect.objectContaining({ kind: 'text', text: expect.stringContaining('200 tokens') }),
  );
});
test('arcs distinguish permanent parentage from round-attributed messages', () => {
  const data = snapshot([row('root', { root: true }), row('child', { parentId: 'root' })]);
  data.details = [
    {
      rowId: 'root',
      status: 'available',
      note: '',
      rounds: [],
      interactions: [
        { kind: 'message', to: 'child', round: 2 },
        { kind: 'spawn', to: null, round: null },
      ],
    },
  ];
  expect(campaignArcs(data, 'campaign', 1).marks.filter((m) => m.kind === 'path')).toHaveLength(1);
  expect(campaignArcs(data, 'campaign', 2).marks.filter((m) => m.kind === 'path')).toHaveLength(2);
  expect(campaignArcs(data, 'campaign', 2).note).toContain('1 interaction(s) non situable(s)');
});
test('missing model weeks break rank lines and distributions retain zero-token sessions', () => {
  const rows = [row('first', { day: '2026-08-31' }), row('later', { day: '2026-09-14' })];
  expect(weeklySeries(rows).values[0]).toEqual([70, 0, 70]);
  expect(temporal(rows, 'bump', '').marks.filter((m) => m.kind === 'path')).toHaveLength(0);
  expect(ridgeline([row('zero', { tokens: 0 })]).rows[0]?.slice(1, 3)).toEqual(['1', '1']);
});

test('one observed week still has a visible stream band', () => {
  expect(temporal([row('one')], 'stream', '').marks).toContainEqual(
    expect.objectContaining({ kind: 'path', d: expect.stringContaining('H865') }),
  );
});
