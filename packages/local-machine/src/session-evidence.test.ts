import { expect, test } from 'bun:test';
import { createCodexSessionParser } from './internal/codex-history';
import { createCodexEvidenceCapture, createEvidenceAccumulator } from './session-evidence';

const at = '2026-11-01T10:00:00.000Z';
test('Codex traces reuse canonical turn ownership and link outputs only by call identity', () => {
  const parser = createCodexSessionParser(true);
  const evidence = createCodexEvidenceCapture();
  const events = [
    { type: 'session_meta', payload: { id: 'test-session', timestamp: at } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Make a patch' } },
    {
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"bun test"}' },
    },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '2 tests passed' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'unknown', output: 'merged PR' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recorded answer' }] },
    },
  ];
  for (const event of events) {
    const line = JSON.stringify({ timestamp: at, ...event });
    parser.visit(line);
    evidence.visit(line, parser.evidenceContext);
  }
  const detail = parser.detail();
  expect(detail).not.toBeNull();
  if (!detail) {
    throw new Error('Missing detail');
  }
  const result = evidence.finish(detail, parser.evidenceTurnIndexes());
  expect(result.records.map((r) => r.kind)).toEqual(['command', 'tool-result', 'tool-result', 'response']);
  expect(result.records[0]?.turnIndex).toBe(detail.turns[0]?.index);
  expect(result.records[1]?.turnIndex).toBe(result.records[0]?.turnIndex);
  expect(result.records[2]?.turnIndex).toBeNull();
  expect(result.coverage.unattributedRecords).toBe(1);
});
test('trace limits preserve explicit omissions and truncated text', () => {
  const collector = createEvidenceAccumulator();
  for (let i = 0; i < 205; i++) {
    collector.add({
      id: String(i),
      at,
      kind: 'response',
      text: 'x'.repeat(9000),
      toolName: null,
      callId: null,
      turnIndex: null,
      promptIds: [],
    });
  }
  const result = collector.finish('session', false);
  expect(result.records.length).toBeLessThanOrEqual(200);
  expect(result.records[0]?.text).toHaveLength(8000);
  expect(result.records[0]?.truncated).toBe(true);
  expect(result.coverage.partial).toBe(true);
  expect(result.coverage.omittedRecords).toBeGreaterThan(0);
  expect(result.records.reduce((n, r) => n + r.text.length, 0)).toBeLessThanOrEqual(256_000);
});

test('Codex replayed output is omitted explicitly and never attributed to the current session', () => {
  const capture = createCodexEvidenceCapture();
  capture.visit(
    JSON.stringify({
      timestamp: at,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Parent history answer' }],
      },
    }),
    () => ({ hasContext: true, replayed: true, turnId: 'parent-turn' }),
  );
  const result = capture.finish(
    {
      sourceSessionId: 'child',
      turns: [],
      coverage: { grouping: { status: 'complete', omittedCount: 0, reasons: [] } },
    },
    new Map(),
  );
  expect(result.records).toEqual([]);
  expect(result.coverage.omittedRecords).toBe(1);
  expect(result.coverage.partial).toBe(true);
});

test('a later conflicting call identity removes earlier output attribution', () => {
  const capture = createCodexEvidenceCapture();
  const parser = createCodexSessionParser(true);
  for (const payload of [
    { type: 'task_started', turn_id: 't1' },
    { type: 'turn_context', turn_id: 't1', model: 'gpt-5' },
    { type: 'user_message', message: 'Check this' },
  ]) {
    parser.visit(
      JSON.stringify({ timestamp: at, type: payload.type === 'turn_context' ? 'turn_context' : 'event_msg', payload }),
    );
  }
  parser.visit(JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: 'session', timestamp: at } }));
  const line = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: at, type: 'response_item', payload });
  capture.visit(
    line({ type: 'function_call', name: 'exec_command', call_id: 'duplicate', arguments: '{"cmd":"first"}' }),
    parser.evidenceContext,
  );
  capture.visit(
    line({ type: 'function_call_output', call_id: 'duplicate', output: 'first output' }),
    parser.evidenceContext,
  );
  capture.visit(
    line({ type: 'function_call', name: 'exec_command', call_id: 'duplicate', arguments: '{"cmd":"different"}' }),
    parser.evidenceContext,
  );
  const detail = parser.detail();
  if (!detail) {
    throw new Error('Expected canonical detail');
  }
  expect(
    capture.finish(detail, parser.evidenceTurnIndexes()).records.find((record) => record.kind === 'tool-result')
      ?.turnIndex,
  ).toBeNull();
});
