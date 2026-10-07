/** Fixed adversarial oracle, declared before generation; never reads operator history. */
export const longSessionExpectations = {
  sourceBytesAbove: 4 * 1024 * 1024,
  nativeEventsAbove: 256,
  finalDecision: 'Replace the cache with direct reads; the initial cache decision is superseded.',
  recordedValidation: '12 pass, 0 fail',
  abandonedDecision: 'Keep the cache and increase its lifetime.',
  unverifiedClaim: 'All tests pass already.',
  coverage: 'session-only; one oversized tool result is truncated; no child discovery',
  toolBoundary: 'final-validation',
} as const;

export const createLongDistillationTranscript = (sessionId: string): string => {
  const record = (type: string, payload: Record<string, unknown>, seconds: number) =>
    JSON.stringify({
      type,
      payload,
      timestamp: new Date(Date.parse('2026-10-04T12:00:00.000Z') + seconds * 1000).toISOString(),
    });
  const message = (text: string, seconds: number) =>
    record('event_msg', { type: 'agent_message', message: text }, seconds);
  return [
    record('session_meta', { id: sessionId, cwd: '/synthetic/ai-usage' }, 0),
    record('event_msg', { type: 'task_started', turn_id: 'long-turn' }, 1),
    record('turn_context', { turn_id: 'long-turn', model: 'synthetic-model' }, 1),
    record('event_msg', { type: 'user_message', message: 'Repair stale reads and verify the final decision.' }, 2),
    message(longSessionExpectations.abandonedDecision, 3),
    message(longSessionExpectations.unverifiedClaim, 4),
    record(
      'response_item',
      { type: 'function_call_output', call_id: 'giant-log', output: 'irrelevant diagnostic '.repeat(250_000) },
      5,
    ),
    ...Array.from({ length: 251 }, (_, index) => message(`Repeated inspection ${index}: no new evidence.`, index + 6)),
    record(
      'response_item',
      {
        type: 'function_call',
        call_id: 'final-validation',
        name: 'exec_command',
        arguments: '{"cmd":"bun test src/direct-read.test.ts"}',
      },
      260,
    ),
    record(
      'response_item',
      { type: 'function_call_output', call_id: 'final-validation', output: longSessionExpectations.recordedValidation },
      261,
    ),
    ...Array.from({ length: 80 }, (_, index) => message(`Post-check observation ${index}.`, index + 262)),
    message(longSessionExpectations.finalDecision, 350),
    record('event_msg', { type: 'task_complete', turn_id: 'long-turn' }, 351),
    '',
  ].join('\n');
};
