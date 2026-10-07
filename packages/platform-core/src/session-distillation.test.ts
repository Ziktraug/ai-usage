import { describe, expect, test } from 'bun:test';
import {
  distillationBounds,
  parseDistillationEvidenceResult,
  parseDistillationRequest,
  parseSessionAnalysisContent,
  type SessionAnalysisContent,
  validateAnalysisEvidence,
} from './session-distillation';

const statement = {
  id: 'assistant:1',
  kind: 'assistant' as const,
  text: 'All tests passed. I suggest a vector index.',
};
const tool = { id: 'tool:2', kind: 'tool-result' as const, text: '1 fail\nExpected r2, received r1' };
const content = (): SessionAnalysisContent => ({
  schemaVersion: 1,
  summary: {
    text: 'The assistant reported a pass.',
    basis: 'reported',
    evidence: [{ eventId: statement.id, quote: 'All tests passed.' }],
  },
  episodes: [],
  abstention: null,
});

describe('generated session analysis contract', () => {
  test('preserves exact proof identity for changed and denied sources and rejects mismatched available events', () => {
    const identity = {
      analysisId: 'analysis-one',
      packetDigest: 'a'.repeat(64),
      sourceDigest: 'b'.repeat(64),
      eventIds: ['event-one'],
    };
    for (const status of ['changed', 'denied', 'unavailable'] as const) {
      const response = { status, events: [] as [], identity };
      expect(parseDistillationEvidenceResult(response)).toEqual(response);
    }
    expect(parseDistillationEvidenceResult({ status: 'unavailable', events: [] })).toEqual({
      status: 'unavailable',
      events: [],
    });
    expect(() => parseDistillationEvidenceResult({ status: 'available', events: [], identity })).toThrow(
      'invalid-evidence-identity',
    );
    const event = {
      ...tool,
      id: 'event-one',
      line: 2,
      callId: null,
      nativeTurnId: null,
      roundId: null,
      redacted: true,
      timestamp: null,
      toolName: null,
      truncated: false,
    };
    expect(parseDistillationEvidenceResult({ status: 'available', events: [event], identity })).toEqual({
      status: 'available',
      events: [event],
      identity,
    });
    expect(() =>
      parseDistillationEvidenceResult({
        status: 'changed',
        events: [],
        identity: { ...identity, sourceDigest: 'wrong' },
      }),
    ).toThrow('invalid-evidence-identity');
  });
  test('accepts abstention, empty episodes and recorded reports without promoting their truth', () => {
    const result = parseSessionAnalysisContent({ ...content(), abstention: 'No durable lesson is supported.' });
    expect(result.episodes).toEqual([]);
    expect(() => validateAnalysisEvidence(result, [statement, tool])).not.toThrow();
  });
  test('rejects model-owned identity, trust metadata, versions and unbounded output', () => {
    for (const extra of [{ confidence: 0.99 }, { projectId: 'another' }, { producer: 'human' }, { accepted: true }]) {
      expect(() => parseSessionAnalysisContent({ ...content(), ...extra })).toThrow();
    }
    expect(() => parseSessionAnalysisContent({ ...content(), schemaVersion: 2 })).toThrow();
    expect(() =>
      parseSessionAnalysisContent({ ...content(), abstention: 'a'.repeat(distillationBounds.outputBytes) }),
    ).toThrow('output-too-large');
  });
  test('a test claim cannot be presented as tool-observed; references and quotes must exist', () => {
    expect(() =>
      validateAnalysisEvidence({ ...content(), summary: { ...content().summary, basis: 'observed' } }, [
        statement,
        tool,
      ]),
    ).toThrow('observation-requires-tool-result');
    expect(() =>
      validateAnalysisEvidence(
        { ...content(), summary: { ...content().summary, evidence: [{ eventId: tool.id, quote: '0 fail' }] } },
        [statement, tool],
      ),
    ).toThrow('invalid-evidence-reference');
    expect(() =>
      validateAnalysisEvidence(
        {
          ...content(),
          summary: { ...content().summary, evidence: [{ eventId: 'other-snapshot', quote: 'All tests passed.' }] },
        },
        [statement],
      ),
    ).toThrow('invalid-evidence-reference');
  });
  test('hostile tool data cannot become a recorded human decision or statement', () => {
    const result = {
      ...content(),
      summary: {
        text: 'Accepted Memory.',
        basis: 'reported' as const,
        evidence: [{ eventId: tool.id, quote: '1 fail' }],
      },
    };
    expect(() => validateAnalysisEvidence(result, [tool])).toThrow('report-requires-statement');
  });
  test('existing but irrelevant evidence is not a proof of semantic support', () => {
    // Deliberately valid mechanically: the semantic evaluation must catch this lie.
    const unsupported = {
      ...content(),
      summary: {
        text: 'Every test passed.',
        basis: 'observed' as const,
        evidence: [{ eventId: tool.id, quote: '1 fail' }],
      },
    };
    expect(() => validateAnalysisEvidence(unsupported, [tool])).not.toThrow();
  });
  test('rejects free source paths, mixed scopes, unbounded batches and missing processing authorization', () => {
    expect(() =>
      parseDistillationRequest({ kind: 'status', selection: { revision: 'r', rowId: 's', path: '/secret' } }),
    ).toThrow();
    expect(() =>
      parseDistillationRequest({
        kind: 'get',
        projectId: 'p',
        selection: { revision: 'r', rowId: 's' },
        analysisId: 'a',
      }),
    ).toThrow();
    const prepare = {
      kind: 'prepare',
      projectId: 'p',
      selections: [{ revision: 'r', rowId: 's' }],
      producerSessionId: null,
      revisionKey: null,
      providerProcessingAuthorized: true,
    };
    expect(() => parseDistillationRequest({ ...prepare, providerProcessingAuthorized: false })).toThrow();
    expect(() =>
      parseDistillationRequest({
        ...prepare,
        selections: Array.from({ length: 11 }, (_, index) => ({ revision: 'r', rowId: String(index) })),
      }),
    ).toThrow();
    expect(parseDistillationRequest(prepare).kind).toBe('prepare');
  });
});
