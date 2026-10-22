import { describe, expect, test } from 'bun:test';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import { parseCodexWorkObservation } from '@ai-usage/report-core/codex-work-observation';
import { createCodexSessionParser } from './codex-history';

const at = (second: number) => canonicalInstantFromDate(new Date(Date.UTC(2026, 9, 22, 10, 0, second)));
const event = (second: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: at(second), type, payload });
const meta = (extra: Record<string, unknown> = {}) =>
  event(0, 'session_meta', {
    id: 'session',
    timestamp: at(0),
    cwd: '/work/fixture',
    originator: 'Codex Desktop',
    source: 'vscode',
    thread_source: 'user',
    ...extra,
  });
const request = (callId: string, second: number, questions: unknown[], tool = 'request_user_input') =>
  event(second, 'response_item', {
    type: 'function_call',
    name: tool,
    call_id: callId,
    arguments: JSON.stringify({ questions }),
  });
const output = (callId: string, second: number, value: unknown) =>
  event(second, 'response_item', {
    type: 'function_call_output',
    call_id: callId,
    output: typeof value === 'string' ? value : JSON.stringify(value),
  });
const withoutDate = (line: string): string => JSON.stringify({ ...JSON.parse(line), timestamp: 'invalid' });
const parse = (lines: readonly string[]) => {
  const parser = createCodexSessionParser();
  for (const line of lines) {
    parser.visit(line);
  }
  const observation = parser.finish().session.workObservation;
  if (parseCodexWorkObservation(observation) === null) {
    throw new Error('parser observation must satisfy the bounded contract');
  }
  return observation;
};

describe('Codex native request attribution through the existing parser', () => {
  test('invalid timestamps on recognized requests and linked outputs report evidence loss without fabricating dates', () => {
    const missingRequest = parse([meta(), withoutDate(request('lost', 1, [{ id: 'q', question: 'Continue ?' }]))]);
    expect(missingRequest).toMatchObject({ requests: [], rejectedRecords: 1, lastEventAt: at(0) });
    const missingResponse = parse([
      meta(),
      request('q', 1, [{ id: 'q', question: 'Continue ?' }]),
      withoutDate(output('q', 2, { answers: { q: { answers: ['yes'] } } })),
    ]);
    expect(missingResponse?.rejectedRecords).toBe(1);
    expect(missingResponse?.requests[0]?.questions[0]?.answeredAt).toBeNull();
    expect(missingResponse?.lastEventAt).toBe(at(1));
  });

  test('unrelated invalid events and proven replay do not claim lost owned request evidence', () => {
    const invalidQuestion = withoutDate(request('lost', 1, [{ id: 'q', question: 'Continue ?' }]));
    const result = parse([
      meta({ forked_from_id: 'parent', thread_source: 'subagent' }),
      event(1, 'event_msg', { type: 'task_started', turn_id: 'copied', started_at: Date.parse(at(-100)) / 1000 }),
      event(2, 'turn_context', { turn_id: 'copied', model: 'gpt-5' }),
      invalidQuestion,
      event(3, 'event_msg', { type: 'task_complete', turn_id: 'copied' }),
      event(4, 'event_msg', { type: 'task_started', turn_id: 'own', started_at: Date.parse(at(4)) / 1000 }),
      event(5, 'turn_context', { turn_id: 'own', model: 'gpt-5' }),
      withoutDate(
        event(6, 'response_item', {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'unrelated',
          arguments: '{}',
        }),
      ),
      withoutDate(output('unknown-call', 7, { accepted: true })),
      '{"type":"response_item","payload":',
    ]);
    expect(result?.rejectedRecords).toBe(0);
    const owned = parse([
      meta({ forked_from_id: 'parent', thread_source: 'subagent' }),
      event(4, 'event_msg', { type: 'task_started', turn_id: 'own', started_at: Date.parse(at(4)) / 1000 }),
      event(5, 'turn_context', { turn_id: 'own', model: 'gpt-5' }),
      invalidQuestion,
    ]);
    expect(owned?.rejectedRecords).toBe(1);
    expect(owned?.requests).toEqual([]);
  });

  test('C01/C02: native async acceptance is a receipt; later dictated French message and completion answer nothing', () => {
    const result = parse([
      meta(),
      request('async', 1, [{ title: 'Quel seuil retenir ?', options: ['10', '20'] }], 'request_user_input_async'),
      output('async', 2, { accepted: true }),
      event(3, 'event_msg', { type: 'user_message', message: 'Je reviens demain, ne change rien.' }),
      event(4, 'event_msg', { type: 'task_complete', turn_id: 'turn' }),
    ]);
    expect(result).toMatchObject({
      originator: 'Codex Desktop',
      source: 'vscode',
      threadSource: 'user',
      latestUserMessageAt: at(3),
    });
    expect(result?.requests[0]).toMatchObject({
      acknowledgedAt: at(2),
      rejectedAt: null,
      questions: [{ id: null, answeredAt: null }],
    });
  });

  test('A03: installed sync response payload answers Q1 by call and question identity while Q2 remains open', () => {
    // Payload qualified against codex-cli 0.163.0 ToolRequestUserInputResponse JSON schema.
    // This envelope is synthetic; live async traces do not expose equivalent answer identities.
    const result = parse([
      meta(),
      request('q1', 1, [{ id: 'choice', header: 'Q1', question: 'Quel seuil ?' }]),
      request('q2', 2, [{ id: 'choice', header: 'Q2', question: 'Publier maintenant ?' }]),
      output('q1', 3, { answers: { choice: { answers: ['10'] } } }),
    ]);
    expect(result?.requests[0]?.questions[0]?.answeredAt).toBe(at(3));
    expect(result?.requests[1]?.questions[0]?.answeredAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain('"answers"');
  });

  test('A04: one answer in a multiquestion call closes only the matching question', () => {
    const result = parse([
      meta(),
      request('q', 1, [
        { id: 'threshold', header: 'Seuil', question: 'Quel seuil ?' },
        { id: 'publish', header: 'Publication', question: 'Publier maintenant ?' },
      ]),
      output('wrong-call', 2, { answers: { publish: { answers: ['go'] } } }),
      output('q', 3, { answers: { threshold: { answers: ['10'] }, unknown: { answers: ['go'] } } }),
    ]);
    expect(result?.requests[0]?.questions.map((question) => question.answeredAt)).toEqual([at(3), null]);
  });

  test('empty answers and asynchronous answer-shaped output never establish a response', () => {
    const result = parse([
      meta(),
      request('q', 1, [{ id: 'q', question: 'Continue ?' }]),
      output('q', 2, { answers: { q: { answers: [] } } }),
      request('async', 3, [{ title: 'Continue ?' }], 'request_user_input_async'),
      output('async', 4, { answers: { q: { answers: ['go'] } } }),
    ]);
    expect(result?.requests.every((entry) => entry.questions.every((question) => question.answeredAt === null))).toBe(
      true,
    );
  });

  test('known unavailable tool and explicit failed output are recorded as rejected, not delivered requests', () => {
    const result = parse([
      meta(),
      request('q', 1, [{ id: 'q', question: 'Continue ?' }]),
      output('q', 2, 'request_user_input is unavailable in Default mode'),
      request('async', 3, [{ title: 'Continue ?' }], 'request_user_input_async'),
      output('async', 4, { error: 'UI unavailable' }),
    ]);
    expect(result?.requests.map((entry) => entry.rejectedAt)).toEqual([at(2), at(4)]);
    expect(result?.requests.every((entry) => entry.acknowledgedAt === null)).toBe(true);
  });

  test('bounds and private question text are explicit; multiline French text remains readable', () => {
    const lines = [meta()];
    for (let i = 0; i < 18; i++) {
      lines.push(
        request(`q${i}`, i + 1, [
          { id: 'q', question: i === 17 ? 'Quel seuil\n retenir\t demain ?' : 'a'.repeat(600) },
        ]),
      );
    }
    lines.push(request('invalid', 19, [{ question: 'Missing native id' }]));
    lines.push(request('private', 20, [{ id: 'private', question: 'PRIVATE_SENTINEL', isSecret: true }]));
    const result = parse(lines);
    expect(result?.requests).toHaveLength(16);
    expect(result?.omittedRequests).toBe(3);
    expect(result?.rejectedRecords).toBe(1);
    expect(result?.requests[0]?.questions[0]?.textTruncated).toBe(true);
    expect(result?.requests.at(-2)?.questions[0]?.text).toBe('Quel seuil retenir demain ?');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
  });

  test('C03: copied fork history is not a new request; an owned child turn may ask its own question', () => {
    const result = parse([
      meta({ forked_from_id: 'parent', thread_source: 'subagent' }),
      event(1, 'event_msg', { type: 'task_started', turn_id: 'copied', started_at: Date.parse(at(-100)) / 1000 }),
      event(2, 'turn_context', { turn_id: 'copied', model: 'gpt-5' }),
      request('inherited', 3, [{ id: 'q', question: 'Old parent question' }]),
      event(4, 'event_msg', { type: 'task_complete', turn_id: 'copied' }),
      event(5, 'event_msg', { type: 'task_started', turn_id: 'own', started_at: Date.parse(at(5)) / 1000 }),
      event(6, 'turn_context', { turn_id: 'own', model: 'gpt-5' }),
      request('own', 7, [{ id: 'q', question: 'Child question' }]),
    ]);
    expect(result?.forkedFromId).toBe('parent');
    expect(result?.threadSource).toBe('subagent');
    expect(result?.requests.map((entry) => entry.callId)).toEqual(['own']);
  });

  test('C03: native review and guardian source discriminants remain available as bounded provenance', () => {
    for (const source of [
      { subagent: 'review' },
      { subagent: { other: 'guardian' } },
      { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
    ]) {
      expect(parse([meta({ source })])?.source).toBe(JSON.stringify(source));
    }
  });
});
