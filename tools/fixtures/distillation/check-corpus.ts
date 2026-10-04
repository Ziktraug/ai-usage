import assert, { match, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import corpus from './corpus.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const caseIds = new Set<string>();
const sessionIds = new Set<string>();
let checkedEvents = 0;
let checkedExpectations = 0;

strictEqual(corpus.cases.length, 9, 'The corpus must retain all nine required semantic cases');
for (const fixture of corpus.cases) {
  assert(!caseIds.has(fixture.id), 'Duplicate fixture identity');
  assert(!sessionIds.has(fixture.sessionId), 'Duplicate native session identity');
  caseIds.add(fixture.id);
  sessionIds.add(fixture.sessionId);
  match(fixture.file, /^transcripts\/[a-z-]+\.jsonl$/);

  const bytes = await readFile(new URL(fixture.file, import.meta.url));
  strictEqual(bytes.length, fixture.bytes, `${fixture.id}: changed source size`);
  assert(bytes.length <= corpus.constraints.maximumTranscriptBytes, `${fixture.id}: source exceeds bound`);
  strictEqual(createHash('sha256').update(bytes).digest('hex'), fixture.sha256, `${fixture.id}: changed source digest`);
  const lines = bytes.toString('utf8').trimEnd().split('\n');
  strictEqual(lines.length, fixture.events.length, `${fixture.id}: event map does not cover every source line`);

  const eventIds = new Set<string>();
  const calls = new Set<string>();
  const completedCalls = new Set<string>();
  for (const [offset, line] of lines.entries()) {
    const event: unknown = JSON.parse(line);
    const mapped = fixture.events[offset];
    assert(mapped, `${fixture.id}: missing event mapping`);
    assert(isRecord(event) && isRecord(event.payload), `${fixture.id}: invalid source event`);
    strictEqual(event.id, mapped.id, `${fixture.id}: source event identity mismatch`);
    strictEqual(event.type, mapped.type, `${fixture.id}: source event type mismatch`);
    strictEqual(mapped.line, offset + 1, `${fixture.id}: source line mismatch`);
    assert(!eventIds.has(mapped.id), `${fixture.id}: duplicate event identity`);
    eventIds.add(mapped.id);
    strictEqual(typeof event.timestamp, 'string', `${fixture.id}: missing timestamp`);
    strictEqual(event.type === 'session_meta', offset === 0, `${fixture.id}: unexpected native session boundary`);
    if (event.type === 'session_meta') {
      strictEqual(event.payload.id, fixture.sessionId, `${fixture.id}: native session identity mismatch`);
      strictEqual(event.payload.cwd, corpus.project.path, `${fixture.id}: unexpected project path`);
    }
    if (event.payload.type === 'function_call') {
      strictEqual(typeof event.payload.call_id, 'string', `${fixture.id}: call has no native identity`);
      const callId = String(event.payload.call_id);
      assert(!calls.has(callId), `${fixture.id}: duplicate native call identity`);
      calls.add(callId);
      strictEqual(typeof event.payload.arguments, 'string', `${fixture.id}: non-string arguments`);
      const argumentsValue: unknown = JSON.parse(String(event.payload.arguments));
      assert(isRecord(argumentsValue), `${fixture.id}: invalid tool arguments`);
    }
    if (event.payload.type === 'function_call_output') {
      const callId = String(event.payload.call_id);
      assert(calls.has(callId), `${fixture.id}: result without preceding call`);
      assert(!completedCalls.has(callId), `${fixture.id}: duplicate call result`);
      completedCalls.add(callId);
      strictEqual(typeof event.payload.output, 'string', `${fixture.id}: invalid recorded tool output`);
    }
  }

  for (const checkpoint of fixture.checkpoints) {
    for (const eventId of checkpoint.evidenceEventIds) {
      assert(eventIds.has(eventId), `${fixture.id}: checkpoint refers to an absent event`);
    }
    if (checkpoint.kind === 'required-fact' || checkpoint.kind === 'useful-entry-point') {
      assert(checkpoint.evidenceEventIds.length > 0, `${fixture.id}: positive expectation lacks independent evidence`);
    }
  }
  for (const eventId of fixture.coverage.truncatedEventIds) {
    assert(eventIds.has(eventId), `${fixture.id}: truncation refers to an absent event`);
  }
  for (const canary of fixture.secretCanaries ?? []) {
    strictEqual(canary.syntheticOnly, true, `${fixture.id}: a secret canary must be synthetic`);
    assert(eventIds.has(canary.eventId), `${fixture.id}: canary refers to an absent event`);
    assert(bytes.includes(canary.literal), `${fixture.id}: missing synthetic redaction canary`);
  }
  checkedEvents += lines.length;
  checkedExpectations += fixture.checkpoints.length;
}

process.stdout.write(
  `Validated ${caseIds.size} synthetic sessions, ${checkedEvents} source events, and ${checkedExpectations} independent checkpoints. No model output was evaluated.\n`,
);
