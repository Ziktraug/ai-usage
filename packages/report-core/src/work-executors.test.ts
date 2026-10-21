import { describe, expect, test } from 'bun:test';
import {
  EXECUTOR_BOUNDS,
  type ExecutorDeclaration,
  type ExecutorObservation,
  executorDeclarationKey,
  executorHarnessFamily,
  executorHarnessForFamily,
  isRoutingConfigShape,
  parseExecutorDeclarations,
  parseExecutorObservation,
} from './work-executors';

const MACHINE = 'machine-a';
const DECLARED_AT = '2026-10-21T20:00:00.000Z';

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountScope: 'personal',
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: DECLARED_AT,
  harness: 'claude-code',
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
  ...overrides,
});

const parse = (executors: readonly unknown[], defaultMachineId: string | null = MACHINE) =>
  parseExecutorDeclarations({ executors }, { defaultMachineId });

describe('executor declarations', () => {
  test('parses a complete entry, defaults the machine to this machine and stores declaredAt canonically', () => {
    const result = parse([entry({ declaredAt: '2026-10-21T22:00:00+02:00', effort: 'high', model: 'Opus' })]);
    expect(result.issues).toEqual([]);
    const expected: ExecutorDeclaration = {
      accountScope: 'personal',
      authorization: 'allowed',
      capabilities: ['read-only-review'],
      declaredAt: DECLARED_AT,
      effort: 'high',
      harness: 'claude-code',
      machineId: MACHINE,
      model: 'Opus',
      quality: 'review-capable',
      subscription: 'verified',
      targets: [{ kind: 'any-local-session' }],
    };
    expect(result.declarations).toEqual([expected]);
    expect(executorDeclarationKey(expected)).toBe(JSON.stringify([MACHINE, 'claude-code', 'personal']));
  });

  test('an invalid entry is reported with path and reason without invalidating its neighbours', () => {
    const result = parse([
      entry({ harness: 'cursor', targets: [{ kind: 'project' }], declaredAt: 'yesterday', extra: true }),
      entry({ accountScope: 'team', harness: 'codex', machineId: 'machine-b' }),
    ]);
    expect(result.declarations.map((declaration) => declaration.accountScope)).toEqual(['team']);
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      'routing.executors[0]',
      'routing.executors[0].declaredAt',
      'routing.executors[0].harness',
      'routing.executors[0].targets[0].projectLabel',
    ]);
    expect(result.issues.every((issue) => !issue.reason.includes('cursor'))).toBe(true);
    expect(result.issues.find((issue) => issue.path === 'routing.executors[0]')?.reason).toContain('extra');
  });

  test('requires machineId when no local machine identity is known', () => {
    const result = parse([entry()], null);
    expect(result.declarations).toEqual([]);
    expect(result.issues).toEqual([
      { path: 'routing.executors[0].machineId', reason: 'is required because no local machine identity is known' },
    ]);
    expect(parse([entry({ machineId: 'explicit' })], null).declarations[0]?.machineId).toBe('explicit');
  });

  test.each([
    { authorization: 'maybe' },
    { subscription: 'unverified' },
    { quality: 'unknown' },
    { capabilities: ['write'] },
    { capabilities: 'read-only-review' },
    { targets: [] },
    { targets: [{ kind: 'any-local-session', projectLabel: 'x' }] },
    { targets: [{ kind: 'everywhere' }] },
    { accountScope: '' },
    { accountScope: 'a'.repeat(EXECUTOR_BOUNDS.maxScope + 1) },
    { model: '' },
    { effort: 42 },
    { declaredAt: 1_760_000_000_000 },
    { declaredAt: '2026-10-21' },
    { declaredAt: undefined },
  ])('rejects %j with a located reason', (override) => {
    const result = parse([entry(override)]);
    expect(result.declarations).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every((issue) => issue.path.startsWith('routing.executors[0]'))).toBe(true);
  });

  test('keeps the first of duplicate (machine, harness, account) entries and reports the rest', () => {
    const result = parse([entry({ model: 'first' }), entry({ model: 'second' })]);
    expect(result.declarations.map((declaration) => declaration.model)).toEqual(['first']);
    expect(result.issues).toEqual([
      {
        path: 'routing.executors[1]',
        reason: 'duplicates executors[0] (same machineId, harness and accountScope); ignored',
      },
    ]);
  });

  test('reports entries beyond the declaration bound instead of reading them', () => {
    const entries = Array.from({ length: EXECUTOR_BOUNDS.maxDeclarations + 1 }, (_, index) =>
      entry({ accountScope: `account-${index}` }),
    );
    const result = parse(entries);
    expect(result.declarations).toHaveLength(EXECUTOR_BOUNDS.maxDeclarations);
    expect(result.issues).toEqual([
      { path: `routing.executors[${EXECUTOR_BOUNDS.maxDeclarations}]`, reason: 'exceeds the 64-entry bound; ignored' },
    ]);
  });

  test('accepts an absent section and reports a malformed one at the section path', () => {
    expect(parseExecutorDeclarations(undefined, { defaultMachineId: MACHINE })).toEqual({
      declarations: [],
      issues: [],
    });
    for (const malformed of [null, [], { executors: 'none' }, { executors: [], other: true }]) {
      expect(isRoutingConfigShape(malformed)).toBe(false);
      const result = parseExecutorDeclarations(malformed, { defaultMachineId: MACHINE, path: 'home.routing' });
      expect(result.declarations).toEqual([]);
      expect(result.issues).toEqual([
        { path: 'home.routing', reason: 'must be an object whose only key is an executors array' },
      ]);
    }
    expect(isRoutingConfigShape({ executors: [] })).toBe(true);
  });

  test('maps harnesses to quota key families both ways', () => {
    expect(executorHarnessFamily('claude-code')).toBe('claude');
    expect(executorHarnessFamily('codex')).toBe('codex');
    expect(executorHarnessForFamily('claude')).toBe('claude-code');
    expect(executorHarnessForFamily('codex')).toBe('codex');
    expect(executorHarnessForFamily('cursor')).toBeNull();
  });
});

describe('executor observations', () => {
  const observation: ExecutorObservation = {
    authEvidence: 'codex login status exit 0 (output mentions "Logged in")',
    authState: 'logged-in',
    binaryPath: '/usr/bin/codex',
    harness: 'codex',
    machineId: MACHINE,
    observedAt: '2026-10-21T21:00:00.000Z',
    outcome: 'observed',
    version: 'codex-cli 0.163.0',
  };

  test('re-validates a stored observation exactly and canonicalizes its time', () => {
    expect(parseExecutorObservation(observation)).toEqual(observation);
    expect(parseExecutorObservation({ ...observation, observedAt: '2026-10-21T23:00:00+02:00' })?.observedAt).toBe(
      '2026-10-21T21:00:00.000Z',
    );
    expect(
      parseExecutorObservation({
        ...observation,
        authEvidence: 'claude binary not found on PATH',
        authState: 'unknown',
        binaryPath: null,
        outcome: 'unavailable',
        version: null,
      }),
    ).not.toBeNull();
  });

  test.each([
    { harness: 'cursor' },
    { authState: 'maybe' },
    { outcome: 'ok' },
    { authEvidence: '' },
    { authEvidence: 'x'.repeat(EXECUTOR_BOUNDS.maxText + 1) },
    { authEvidence: 'line\nbreak' },
    { version: '' },
    { binaryPath: 'p'.repeat(EXECUTOR_BOUNDS.maxPath + 1) },
    { machineId: '' },
    { observedAt: 'soon' },
    { observedAt: 1_760_000_000_000 },
    { stdout: 'never stored' },
  ])('rejects %j', (override) => {
    expect(parseExecutorObservation({ ...observation, ...override })).toBeNull();
  });

  test('rejects non-objects', () => {
    expect(parseExecutorObservation(null)).toBeNull();
    expect(parseExecutorObservation('observed')).toBeNull();
  });
});
