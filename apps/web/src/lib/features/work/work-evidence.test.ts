import { describe, expect, test } from 'bun:test';
import {
  projectWorkEvidence,
  type WorkEvidence,
  type WorkIdentity,
  workIdentityKey,
  workParentCoverage,
} from './work-evidence';

const session: WorkIdentity = { machineId: 'synthetic-machine', harness: 'claude', sessionId: 'requester' };
const base = { session, source: 'synthetic native observation', coverage: 'partial' as const };
const request: WorkEvidence = {
  ...base,
  id: 'request-1',
  observedAt: '2026-06-11T08:00:00.000Z',
  kind: 'pr-request',
  repository: { host: 'github.example', repository: 'demo/repository' },
};
const opened: Extract<WorkEvidence, { kind: 'pr-opened' }> = {
  ...base,
  session: { ...session, harness: 'codex', sessionId: 'other-session' },
  id: 'opened-1',
  observedAt: '2026-06-11T09:00:00.000Z',
  kind: 'pr-opened',
  pullRequest: { host: 'github.example', repository: 'demo/repository', number: 42 },
  fulfillsRequest: { session, requestId: request.id },
};

describe('Work evidence projection boundary (synthetic observations, not collected outcomes)', () => {
  test('requalifies a native request only from a later explicitly linked PR observed elsewhere, retaining both facts', () => {
    const before = projectWorkEvidence(session, [request]);
    const after = projectWorkEvidence(session, [request, opened]);
    expect(before[0]?.kind).toBe('waiting');
    expect(after[0]).toMatchObject({
      kind: 'observed',
      text: 'Requested PR observed open',
      evidence: [request, opened],
    });
    expect(after[0]?.uncertainty).toContain('does not prove merge or deployment');
    expect(request.kind).toBe('pr-request');
  });
  test.each([
    { ...opened, fulfillsRequest: null },
    { ...opened, fulfillsRequest: { session, requestId: 'different-request' } },
    { ...opened, observedAt: '2026-06-11T07:00:00.000Z' },
    { ...opened, pullRequest: { ...opened.pullRequest, host: 'other.example' } },
    { ...opened, pullRequest: { ...opened.pullRequest, repository: 'other/repository' } },
    { ...opened, fulfillsRequest: { session: { ...session, machineId: 'other-machine' }, requestId: request.id } },
  ])('does not resolve a request using unrelated or earlier evidence', (observation) => {
    expect(projectWorkEvidence(session, [request, observation])[0]?.kind).toBe('waiting');
  });
  test('local changes carry no validation or delivery claim', () => {
    const evidence: WorkEvidence = {
      ...base,
      id: 'changes',
      observedAt: opened.observedAt,
      kind: 'local-modifications',
    };
    expect(projectWorkEvidence(session, [evidence])).toEqual([
      {
        kind: 'observed',
        text: 'Local modifications observed',
        evidence: [evidence],
        uncertainty: 'Validation and delivery are unobserved.',
      },
    ]);
  });
  test.each(['unanswered', 'dismissed'] as const)(
    'a %s proposal carries no execution authorization or invented reason',
    (response) => {
      const result = projectWorkEvidence(session, [
        { ...base, id: 'proposal', observedAt: opened.observedAt, kind: 'proposal', response },
      ]);
      expect(result[0]?.kind).toBe('proposal');
      expect(result[0]?.uncertainty).toContain('not authorization');
      expect(result[0]?.text).toBe(
        response === 'unanswered' ? 'Proposal unanswered' : 'Proposal dismissed; reason undeclared',
      );
    },
  );
  test('same checkout or branch never replaces machine, harness and session identity', () => {
    const other = { ...session, sessionId: 'distinct-work-same-checkout' };
    expect(workIdentityKey(session)).not.toBe(workIdentityKey(other));
    expect(projectWorkEvidence(other, [request, opened])).toEqual([]);
    expect(workIdentityKey({ ...session, machineId: 'another-machine' })).not.toBe(workIdentityKey(session));
  });
  test('child lineage distinguishes a declared parent outside the bounded observation from no parent evidence', () => {
    const child = { session: { ...session, sessionId: 'child' }, parentSessionId: session.sessionId };
    expect(workParentCoverage(child, [session])).toBe('Explicit parent observed');
    expect(workParentCoverage(child, [])).toContain('absence is not established');
    expect(workParentCoverage(child, [{ ...session, harness: 'codex' }])).toContain('outside this bounded observation');
    expect(workParentCoverage({ ...child, parentSessionId: null }, [])).toBe('Parent not declared');
  });
});
