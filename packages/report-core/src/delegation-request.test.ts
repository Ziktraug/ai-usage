import { describe, expect, test } from 'bun:test';
import type { DelegationRequest, DelegationSelection } from './delegation-contracts';
import {
  canonicalJson,
  delegationRequestDigest,
  delegationSelectionDigest,
  isDelegationIdempotencyKey,
  isDelegationUuid,
  parseDelegationRequest,
  parseDelegationSelection,
} from './delegation-request';
import { DELEGATION_BOUNDS } from './delegation-vocabulary';

const UUID = '0f8d2c4e-9a1b-4c3d-8e7f-123456789abc';
const OTHER_UUID = '1f8d2c4e-9a1b-4c3d-8e7f-123456789abc';
const SHA256_HEX = /^[0-9a-f]{64}$/u;

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  action: 'read-only-review',
  taskCategory: 'correctness',
  objective: 'Review the parser change for off-by-one errors.',
  checkout: { path: '/home/operator/projects/alpha' },
  scope: { kind: 'commit', commit: 'HEAD' },
  criteria: ['Every bound is tested'],
  constraints: ['Do not suggest a rewrite'],
  ...overrides,
});

const parsed = (value: unknown): DelegationRequest => {
  const result = parseDelegationRequest(value);
  if (result.kind !== 'ok') {
    throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  }
  return result.request;
};

const issuePaths = (value: unknown): string[] => {
  const result = parseDelegationRequest(value);
  if (result.kind !== 'invalid') {
    throw new Error(`expected invalid, got ${result.kind}`);
  }
  return result.issues.map((issue) => issue.path);
};

describe('parseDelegationRequest', () => {
  test('accepts a complete request, normalizes the checkout path and keeps the client as metadata', () => {
    const value = request({
      checkout: { path: '/home/operator//projects/alpha/' },
      client: { name: 'claude-code', sessionRef: 'session-1', correlationId: 'corr-1' },
      retryOf: UUID,
      scope: { kind: 'range', base: 'main', head: 'feature/x' },
    });
    expect(parsed(value)).toEqual({
      action: 'read-only-review',
      checkout: { path: '/home/operator/projects/alpha' },
      client: { correlationId: 'corr-1', name: 'claude-code', sessionRef: 'session-1' },
      constraints: ['Do not suggest a rewrite'],
      criteria: ['Every bound is tested'],
      objective: 'Review the parser change for off-by-one errors.',
      retryOf: UUID,
      schemaVersion: 1,
      scope: { base: 'main', head: 'feature/x', kind: 'range' },
      taskCategory: 'correctness',
    });
    const minimal = parsed(request({ criteria: [], constraints: [] }));
    expect(minimal).not.toHaveProperty('client');
    expect(minimal).not.toHaveProperty('retryOf');
  });

  test('refuses a reserved action or scope as unsupported, naming what is supported', () => {
    for (const action of ['code-change', 'commit', 'publish']) {
      const result = parseDelegationRequest(request({ action }));
      expect(result).toMatchObject({ kind: 'unsupported', reason: 'action-unsupported' });
      expect(result.kind === 'unsupported' && result.message).toContain("'read-only-review'");
    }
    const scope = parseDelegationRequest(request({ scope: { kind: 'working-tree' } }));
    expect(scope).toMatchObject({ kind: 'unsupported', reason: 'scope-unsupported' });
    expect(scope.kind === 'unsupported' && scope.message).toContain("'commit'");
    expect(scope.kind === 'unsupported' && scope.message).toContain("'range'");
    // An unknown action or scope kind is invalid, not reserved.
    expect(issuePaths(request({ action: 'deploy' }))).toEqual(['action']);
    expect(issuePaths(request({ scope: { kind: 'branch', branch: 'main' } }))).toEqual(['scope.kind']);
  });

  test.each([
    ['not an object', 'nope', ['']],
    ['an unknown key', request({ extra: 1 }), ['']],
    ['another schema version', request({ schemaVersion: 2 }), ['schemaVersion']],
    ['an unknown category', request({ taskCategory: 'speed' }), ['taskCategory']],
    ['a blank objective', request({ objective: '   ' }), ['objective']],
    ['a control character in the objective', request({ objective: 'bad\u0007' }), ['objective']],
    [
      'an oversize objective',
      request({ objective: 'x'.repeat(DELEGATION_BOUNDS.maxObjectiveCharacters + 1) }),
      ['objective'],
    ],
    ['a relative checkout path', request({ checkout: { path: 'projects/alpha' } }), ['checkout.path']],
    ['a parent segment in the checkout path', request({ checkout: { path: '/home/../etc' } }), ['checkout.path']],
    ['an extra checkout key', request({ checkout: { path: '/x', branch: 'main' } }), ['checkout']],
    ['a scope that is not an object', request({ scope: 'HEAD' }), ['scope']],
    ['a commit scope with a range key', request({ scope: { kind: 'commit', commit: 'HEAD', head: 'x' } }), ['scope']],
    ['a revision starting with a dash', request({ scope: { kind: 'commit', commit: '--output=x' } }), ['scope.commit']],
    ['a revision with a space', request({ scope: { kind: 'range', base: 'ma in', head: 'x' } }), ['scope.base']],
    ['an oversize revision', request({ scope: { kind: 'commit', commit: 'a'.repeat(257) } }), ['scope.commit']],
    ['criteria that are not an array', request({ criteria: 'tested' }), ['criteria']],
    ['a blank criterion', request({ criteria: [''] }), ['criteria[0]']],
    [
      'an oversize constraint',
      request({ constraints: ['y'.repeat(DELEGATION_BOUNDS.maxConstraintCharacters + 1)] }),
      ['constraints[0]'],
    ],
    ['an uppercase retryOf', request({ retryOf: UUID.toUpperCase() }), ['retryOf']],
    ['a client that is not an object', request({ client: 'claude' }), ['client']],
    ['an unknown client key', request({ client: { token: 'x' } }), ['client']],
    [
      'an oversize client name',
      request({ client: { name: 'n'.repeat(DELEGATION_BOUNDS.maxClientNameCharacters + 1) } }),
      ['client.name'],
    ],
  ])('reports %s at its path without echoing the value', (_label, value, paths) => {
    const result = parseDelegationRequest(value);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.issues.map((issue) => issue.path)).toEqual(paths);
      expect(JSON.stringify(result.issues)).not.toContain('--output');
    }
  });

  test('counts array lengths before validating elements', () => {
    const oversize = Array.from({ length: DELEGATION_BOUNDS.maxCriteria + 1 }, () => ({ not: 'a string' }));
    const result = parseDelegationRequest(request({ criteria: oversize }));
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.issues).toEqual([
        { path: 'criteria', reason: `must list at most ${DELEGATION_BOUNDS.maxCriteria} entries` },
      ]);
    }
  });

  test('collects every issue of one request instead of stopping at the first', () => {
    expect(issuePaths(request({ taskCategory: 'speed', objective: '', criteria: 'x' }))).toEqual([
      'taskCategory',
      'objective',
      'criteria',
    ]);
  });
});

describe('delegationRequestDigest', () => {
  test('is a lowercase SHA-256 of canonical JSON that ignores the client and key order', async () => {
    const base = parsed(request());
    const digest = await delegationRequestDigest(base);
    expect(digest).toMatch(SHA256_HEX);
    const withClient = parsed(request({ client: { name: 'codex' } }));
    expect(await delegationRequestDigest(withClient)).toBe(digest);
    const reordered = parsed(Object.fromEntries(Object.entries(request()).reverse()) as Record<string, unknown>);
    expect(await delegationRequestDigest(reordered)).toBe(digest);
    const other = parsed(request({ objective: 'Something else' }));
    expect(await delegationRequestDigest(other)).not.toBe(digest);
    const retried = parsed(request({ retryOf: UUID }));
    expect(await delegationRequestDigest(retried)).not.toBe(digest);
  });

  test('canonicalJson sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: [{ z: 1, y: undefined, a: 2 }], a: null })).toBe('{"a":null,"b":[{"a":2,"z":1}]}');
  });
});

describe('parseDelegationSelection', () => {
  const choice: DelegationSelection = {
    kind: 'choice',
    qualificationId: UUID,
    routeId: 'declared:["machine","claude-code","personal"]',
    selectorVersion: 'calling-model/claude-code',
  };

  test('accepts a choice with optional confidence and rationale, and an abstention with a reason', () => {
    expect(
      parseDelegationSelection({ ...choice, confidence: 0.4, rationale: ['Recommended for correctness'] }),
    ).toEqual({
      kind: 'ok',
      selection: { ...choice, confidence: 0.4, rationale: ['Recommended for correctness'] },
    });
    expect(parseDelegationSelection(choice)).toEqual({ kind: 'ok', selection: choice });
    const abstain: DelegationSelection = {
      kind: 'abstain',
      note: 'The task needs the working tree.',
      qualificationId: UUID,
      reason: 'task-unsuitable',
      selectorVersion: 'calling-model/codex',
    };
    expect(parseDelegationSelection(abstain)).toEqual({ kind: 'ok', selection: abstain });
  });

  test.each([
    ['a non-object', 'choose', ['']],
    ['an unknown kind', { ...choice, kind: 'maybe' }, ['kind']],
    ['an extra key', { ...choice, routeIds: [] }, ['']],
    ['an abstention key on a choice', { ...choice, reason: 'keep-with-caller' }, ['']],
    ['an uppercase qualification id', { ...choice, qualificationId: UUID.toUpperCase() }, ['qualificationId']],
    ['a blank route id', { ...choice, routeId: ' ' }, ['routeId']],
    ['a confidence above one', { ...choice, confidence: 1.5 }, ['confidence']],
    ['a NaN confidence', { ...choice, confidence: Number.NaN }, ['confidence']],
    [
      'too many rationale lines',
      { ...choice, rationale: Array.from({ length: DELEGATION_BOUNDS.maxSelectionRationale + 1 }, () => 'r') },
      ['rationale'],
    ],
    [
      'an oversize rationale line',
      { ...choice, rationale: ['r'.repeat(DELEGATION_BOUNDS.maxSelectionRationaleCharacters + 1)] },
      ['rationale[0]'],
    ],
    [
      'an oversize selector version',
      { ...choice, selectorVersion: 'v'.repeat(DELEGATION_BOUNDS.maxSelectorVersionCharacters + 1) },
      ['selectorVersion'],
    ],
    [
      'an unknown abstention reason',
      { kind: 'abstain', qualificationId: UUID, reason: 'tired', selectorVersion: 'x' },
      ['reason'],
    ],
    [
      'an oversize abstention note',
      {
        kind: 'abstain',
        note: 'n'.repeat(501),
        qualificationId: UUID,
        reason: 'keep-with-caller',
        selectorVersion: 'x',
      },
      ['note'],
    ],
  ])('refuses %s', (_label, value, paths) => {
    const result = parseDelegationSelection(value);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.issues.map((issue) => issue.path)).toEqual(paths);
    }
  });

  test('the selection digest covers only what starts work: kind, route and qualification', async () => {
    const digest = await delegationSelectionDigest(choice);
    expect(digest).toMatch(SHA256_HEX);
    expect(
      await delegationSelectionDigest({ ...choice, confidence: 0.9, rationale: ['x'], selectorVersion: 'other/1' }),
    ).toBe(digest);
    expect(await delegationSelectionDigest({ ...choice, qualificationId: OTHER_UUID })).not.toBe(digest);
    expect(await delegationSelectionDigest({ ...choice, routeId: 'other' })).not.toBe(digest);
    expect(
      await delegationSelectionDigest({
        kind: 'abstain',
        qualificationId: UUID,
        reason: 'keep-with-caller',
        selectorVersion: 'x',
      }),
    ).not.toBe(digest);
  });
});

describe('identifiers', () => {
  test('isDelegationIdempotencyKey applies the vocabulary pattern', () => {
    expect(isDelegationIdempotencyKey('claude-code:session-1:turn-7')).toBe(true);
    expect(isDelegationIdempotencyKey('short')).toBe(false);
    expect(isDelegationIdempotencyKey('k'.repeat(DELEGATION_BOUNDS.maxIdempotencyKeyCharacters + 1))).toBe(false);
    expect(isDelegationIdempotencyKey('has space here')).toBe(false);
    expect(isDelegationIdempotencyKey(12_345_678)).toBe(false);
  });

  test('isDelegationUuid accepts lowercase RFC 4122 text only', () => {
    expect(isDelegationUuid(UUID)).toBe(true);
    expect(isDelegationUuid(UUID.toUpperCase())).toBe(false);
    expect(isDelegationUuid(`${UUID}0`)).toBe(false);
    expect(isDelegationUuid(null)).toBe(false);
  });
});
