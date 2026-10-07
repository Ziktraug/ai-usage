import { expect, test } from 'bun:test';
import type { SessionAnalysis } from '@ai-usage/platform-core/session-distillation';
import { createCompactDistillationContext } from './distillation-context';

const analysis: SessionAnalysis = {
  id: 'analysis',
  projectId: 'project',
  revision: 1,
  machineId: 'machine',
  nativeSessionId: 'session',
  createdAt: '2026-10-06T12:00:00.000Z',
  packetDigest: 'a'.repeat(64),
  schemaVersion: 1,
  normalizationVersion: 1,
  extractorVersion: 'session-distillation-v1',
  producer: { kind: 'active-harness', sessionId: null, attribution: 'unknown' },
  validation: 'schema-and-references',
  source: {
    harnessKey: 'codex',
    projectId: 'project',
    machineId: 'machine',
    nativeSessionId: 'session',
    reportAnchor: null,
    version: { digest: 'b'.repeat(64), bytes: 100, totalBytes: 100, modifiedAtMs: 1 },
  },
  coverage: {
    scope: 'session-only',
    status: 'partial',
    completion: 'interrupted',
    lines: 1,
    includedEvents: 1,
    exclusions: [{ reason: 'recorded-truncation', count: 1 }],
    childDiscovery: 'not-performed',
    childrenNotAnalyzed: 2,
  },
  content: {
    schemaVersion: 1,
    summary: {
      text: 'Échec observé 日本語 cache',
      basis: 'observed',
      evidence: [{ eventId: 'e', quote: 'Échec observé' }],
    },
    abstention: null,
    episodes: [],
  },
};

test('compact context deduplicates quotations, preserves uncertainty and includes UTF-8 envelope in the byte budget', async () => {
  const repeated = structuredClone(analysis);
  const assertion = repeated.content.summary;
  repeated.content.episodes = [
    {
      id: 'cache',
      objective: assertion,
      attempts: [assertion],
      decisions: [],
      difficulties: [assertion],
      entryPoints: [],
      openQuestions: [],
      result: { status: 'failed', assertion },
    },
  ];
  const get = () => Promise.resolve(repeated);
  const search = {
    corpus: 'session-analyses' as const,
    items: [
      {
        id: analysis.id,
        projectId: analysis.projectId,
        revision: 1,
        machineId: 'machine',
        nativeSessionId: 'session',
        createdAt: analysis.createdAt,
        packetDigest: analysis.packetDigest,
        summary: assertion.text,
        coverage: 'partial' as const,
        episodeIds: ['cache'],
      },
    ],
    omitted: 0,
  };
  const result = await createCompactDistillationContext({
    search,
    query: 'cache',
    maxBytes: 4096,
    get,
    signal: AbortSignal.timeout(1000),
  });
  expect(result.analyses[0]!.references).toEqual([{ eventId: 'e', quote: 'Échec observé' }]);
  expect(result.analyses[0]!.content.episodes[0]!.attempts[0]!.evidence).toEqual([0]);
  expect(result.analyses[0]!.coverage).toMatchObject({
    status: 'partial',
    childrenNotAnalyzed: 2,
    completion: 'interrupted',
  });
  expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result)));
  expect(result.bytes).toBeLessThan(Buffer.byteLength(JSON.stringify(repeated)));
  expect(result.analyses[0]).not.toHaveProperty('producer');
  expect(result.analyses[0]).not.toHaveProperty('source');
  const small = await createCompactDistillationContext({
    search,
    query: 'cache',
    maxBytes: 512,
    get,
    signal: AbortSignal.timeout(1000),
  });
  expect(small).toMatchObject({ analyses: [], omitted: 1 });
  expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(512);
  expect(small.bytes).toBe(Buffer.byteLength(JSON.stringify(small)));
});
