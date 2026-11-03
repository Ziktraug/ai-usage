import { expect, test } from 'bun:test';
import { parseTokenFlow, type TokenFlowContribution } from './observatory';
import { buildTokenFlow } from './token-flow-projection';

const contribution = (project: string, model: string, tokens: number): TokenFlowContribution => ({
  projectKey: project,
  projectLabel: project,
  model,
  input: tokens,
  cacheRead: tokens * 2,
  cacheWrite: 0,
  output: tokens,
});

test('retains joint project/model attribution and conserves four disjoint token categories', () => {
  const flow = buildTokenFlow([contribution('A', 'one', 10), contribution('B', 'two', 20)], 2, 0);
  expect(flow.total).toBe(120);
  expect(flow.links).toHaveLength(2);
  expect(flow.links.find((link) => link.projectKey === 'A')).toMatchObject({ model: 'one', input: 10, output: 10 });
  expect(parseTokenFlow(flow)).toEqual(flow);
});

test('bounds groups without dropping overflow tokens or conflating a real Other label', () => {
  const contributions = Array.from({ length: 100 }, (_, i) => contribution(String(i), String(i), i + 1));
  contributions.push(contribution('Other projects', 'Other models', 1000));
  const flow = buildTokenFlow(contributions, contributions.length, 2);
  expect(new Set(flow.links.map((link) => link.projectKey)).size).toBeLessThanOrEqual(9);
  expect(new Set(flow.links.map((link) => link.model)).size).toBeLessThanOrEqual(13);
  expect(flow.total).toBe(contributions.reduce((sum, entry) => sum + entry.input * 4, 0));
  expect(flow.partialSessions).toBe(2);
  expect(parseTokenFlow(flow)).toEqual(flow);
});

test('rejects broken conservation, negative tokens and oversized payloads', () => {
  const flow = buildTokenFlow([contribution('A', 'one', 10)], 1, 0);
  expect(() => parseTokenFlow({ ...flow, total: 41 })).toThrow();
  expect(() => parseTokenFlow({ ...flow, partialSessions: 2 })).toThrow();
  expect(() => buildTokenFlow([{ ...contribution('A', 'one', 1), input: -1 }], 1, 0)).toThrow();
  expect(() => parseTokenFlow({ ...flow, links: Array.from({ length: 118 }, () => flow.links[0]) })).toThrow();
});
