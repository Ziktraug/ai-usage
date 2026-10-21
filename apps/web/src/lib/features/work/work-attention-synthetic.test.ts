import { describe, expect, test } from 'bun:test';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { projectSessionLookup } from '@ai-usage/report-core/session-query';
import { WORK_ATTENTION_BOUNDS } from '@ai-usage/report-core/work-attention';
import { demoReportPayload } from '../../../report-data';
import { parseWorkAttentionDataset } from '../../rpc/work-attention-client';
import { createSyntheticWorkAttentionClient, syntheticWorkAttentionDataset } from './work-attention-synthetic';
import { WORK_DEMO_REVISION, WORK_DEMO_TIME } from './work-synthetic';

const dataset = syntheticWorkAttentionDataset();
const DAY_MS = 86_400_000;

describe('Synthetic Work attention dataset', () => {
  test('is in bounds, parses through the shared narrowing and names its own truncation', () => {
    expect(parseWorkAttentionDataset(JSON.parse(JSON.stringify(dataset)))).toEqual(dataset);
    expect(dataset.roots.length).toBeGreaterThanOrEqual(20);
    expect(dataset.roots.length).toBeLessThanOrEqual(WORK_ATTENTION_BOUNDS.maxRoots);
    expect(dataset.truncated).toBe(true);
    expect(dataset.totalRoots).toBeGreaterThan(dataset.roots.length);
    expect<string>(dataset.generatedAt).toBe(WORK_DEMO_TIME);
    expect(new Set(dataset.roots.map((root) => JSON.stringify(root.key))).size).toBe(dataset.roots.length);
  });
  test('covers the three attention kinds, two harnesses, partial coverage and generic titles', () => {
    const kinds = new Set(dataset.roots.map((root) => root.attention));
    expect([...kinds].sort()).toEqual(['external-wait', 'human-request', 'none', 'optional-lead']);
    const harnesses = new Set(dataset.roots.map((root) => root.key.harness));
    expect([...harnesses].sort()).toEqual(['claude', 'codex']);
    expect(dataset.roots.filter((root) => root.key.harness === 'codex').every((root) => root.declared === null)).toBe(
      true,
    );
    expect(dataset.roots.filter((root) => root.title === 'Enquête')).toHaveLength(2);
    expect(dataset.roots.filter((root) => root.titleSource === 'auto').length).toBeGreaterThanOrEqual(2);
    expect(dataset.roots.some((root) => root.archived)).toBe(true);
    expect(dataset.roots.some((root) => root.facts.some((fact) => fact.provenance.coverage === 'partial'))).toBe(true);
    expect(dataset.roots.flatMap((root) => root.interpretations.map((entry) => entry.kind))).toEqual(
      expect.arrayContaining(['coverage-gap', 'request-satisfied-elsewhere', 'proposal-open', 'pull-request-merged']),
    );
    expect(dataset.coverage.desktopSessions.unsupported).toBeGreaterThan(0);
  });
  test('ages span one hour to forty days relative to the demo instant', () => {
    const ages = dataset.roots
      .map((root) => root.age.declaredAt ?? root.age.lastActivityAt)
      .filter((instant): instant is CanonicalInstant => instant !== null)
      .map((instant) => Date.parse(WORK_DEMO_TIME) - Date.parse(instant));
    expect(Math.min(...ages)).toBe(3_600_000);
    expect(Math.max(...ages)).toBe(40 * DAY_MS);
  });
  test('declares pull requests in both OPEN and MERGED states and proposals both open and resolved', () => {
    const facts = dataset.roots.flatMap((root) => root.facts);
    const declaredStates = new Set(
      facts.flatMap((fact) => (fact.kind === 'declared-pull-request' ? [fact.state] : [])),
    );
    expect([...declaredStates].sort()).toEqual(['MERGED', 'OPEN']);
    const resolutions = new Set(facts.flatMap((fact) => (fact.kind === 'proposal' ? [fact.resolution] : [])));
    expect(resolutions.has('open')).toBe(true);
    expect(resolutions.has('dismissed')).toBe(true);
  });
  test('joins only to served demo Session rows that really exist, with their campaign key', () => {
    const joined = dataset.roots.filter((root) => root.session !== null);
    expect(joined.length).toBeGreaterThanOrEqual(2);
    for (const root of joined) {
      const lookup = projectSessionLookup(demoReportPayload.rows, {
        revision: WORK_DEMO_REVISION,
        rowId: root.session!.rowId,
      });
      expect(lookup.found).toBe(true);
      expect(lookup.row?.source?.sourceSessionId).toBe(root.key.sourceSessionId);
    }
    expect(joined.find((root) => root.title === 'Build report UI')?.session?.campaignKey).toBe(
      'fixture-machine:codex:campaign-root',
    );
    expect(dataset.roots.filter((root) => root.session === null).length).toBeGreaterThan(0);
  });
  test('the synthetic client answers without any transport', async () => {
    const result = await createSyntheticWorkAttentionClient().attention({ limit: 10 });
    expect(result.ok).toBe(true);
  });
});
