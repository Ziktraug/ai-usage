import { expect, test } from 'bun:test';
import { MAX_CONSTELLATION_SESSIONS, parseConstellation } from './constellation';
import { buildConstellation } from './constellation-projection';
import type { SessionPresentationRow } from './session-query';

// Only published presentation fields consumed by this projection are needed here.
const row = (id: string, tokens: number, machine = 'a', parent?: string): SessionPresentationRow =>
  ({
    rowId: id,
    tokenTotal: tokens,
    projectKey: 'project',
    projectLabel: 'Project',
    harness: 'Codex',
    name: id,
    sessionLabel: id,
    source: {
      sourceSessionId: id,
      machineId: machine,
      harnessKey: 'codex',
      ...(parent ? { parentSourceSessionId: parent } : {}),
    },
  }) as SessionPresentationRow;

test('links only declared, qualified parents and never treats project proximity as lineage', () => {
  const map = buildConstellation(
    [row('root', 10), row('child', 5, 'a', 'root'), row('other-machine', 3, 'b', 'root'), row('standalone', 1)],
    4,
  );
  expect(map.nodes.find((node) => node.id === 'child')?.parentId).toBe('root');
  expect(map.nodes.find((node) => node.id === 'other-machine')?.parentId).toBeNull();
  expect(map.nodes.find((node) => node.id === 'standalone')?.parentId).toBeNull();
  expect(map.unresolvedParents).toBe(1);
});

test('takes the largest 900 deterministically without changing the full matching count', () => {
  const rows = Array.from({ length: 1001 }, (_, i) => row(String(i), i));
  const map = buildConstellation(rows, rows.length);
  expect(map.nodes).toHaveLength(MAX_CONSTELLATION_SESSIONS);
  expect(map.nodes[0]?.tokens).toBe(1000);
  expect(map.totalSessions).toBe(1001);
  expect(buildConstellation(rows.toReversed(), rows.length)).toEqual(map);
  expect(parseConstellation(map)).toEqual(map);
});

test('missing, duplicated, cyclic and self parents remain unresolved', () => {
  const first = row('one', 10, 'a', 'two');
  const second = row('two', 10, 'a', 'one');
  const map = buildConstellation([first, second, row('self', 5, 'a', 'self')], 3);
  expect(map.nodes.every((node) => node.parentId === null)).toBe(true);
  expect(map.unresolvedParents).toBe(3);
  const duplicate = { ...row('duplicate', 3), source: { ...first.source!, sourceSessionId: 'one' } };
  const ambiguous = buildConstellation([first, duplicate, row('child', 2, 'a', 'one')], 3);
  expect(ambiguous.nodes.find((node) => node.id === 'child')?.parentId).toBeNull();
});

test('rejects malformed bounded transport values before they reach the diagram', () => {
  const map = buildConstellation([row('one', 10), row('two', 5)], 2);
  expect(() => parseConstellation({ ...map, totalSessions: 1 })).toThrow();
  expect(() => parseConstellation({ ...map, unresolvedParents: 3 })).toThrow();
  expect(() => parseConstellation({ ...map, extra: true })).toThrow();
  expect(() => parseConstellation({ ...map, nodes: [map.nodes[0], map.nodes[0]] })).toThrow();
  expect(() => parseConstellation({ ...map, nodes: [{ ...map.nodes[0], tokens: -1 }] })).toThrow();
  expect(() => parseConstellation({ ...map, nodes: [{ ...map.nodes[0], parentId: 'absent' }] })).toThrow();
});
