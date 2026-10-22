import { describe, expect, test } from 'bun:test';
import { ROUTING_QUALIFICATION_BOUNDS } from '@ai-usage/report-core/work-routing';
import {
  parseWorkRoutingContext,
  parseWorkRoutingQualifyOutput,
  type WorkRoutingContext,
  type WorkRoutingQualification,
  workRoutingContract,
} from './work-routing';

const context: WorkRoutingContext = {
  configPath: '/home/operator/.config/ai-usage/config.json',
  declarationErrors: ["routing.executors[1].authorization: must be 'allowed' or 'forbidden'"],
  declarations: [
    {
      accountScope: 'personal',
      authorization: 'allowed',
      capabilities: ['read-only-review'],
      declaredAt: '2026-10-21T20:00:00.000Z',
      effort: null,
      harness: 'claude-code',
      machineId: 'machine-a',
      model: 'Opus',
      quality: 'review-capable',
      subscription: 'verified',
      targets: [{ kind: 'any-local-session' }, { kind: 'project', projectLabel: 'ai-usage' }],
    },
  ],
  executorObservations: [
    {
      authEvidence: 'claude auth status exit 0 loggedIn=true authMethod=claude.ai',
      authMethod: 'claude.ai',
      authState: 'logged-in',
      binaryPath: '/usr/bin/claude',
      harness: 'claude-code',
      machineId: 'machine-a',
      observedAt: '2026-10-21T21:00:00.000Z',
      outcome: 'observed',
      version: '2.1.303 (Claude Code)',
    },
  ],
  generatedAt: '2026-10-21T21:05:00.000Z',
  machineId: 'machine-a',
  observationRead: { skipped: 0, truncated: false },
};

describe('Work routing Web contract', () => {
  test('accepts the exact bounded context and exposes one GET read with typed errors', () => {
    expect(parseWorkRoutingContext(context)).toEqual(context);
    expect(parseWorkRoutingContext({ ...context, machineId: null, configPath: null, declarations: [] })).toMatchObject({
      configPath: null,
      machineId: null,
    });
    expect(workRoutingContract.context['~orpc'].route).toMatchObject({ method: 'GET', path: '/work/routing-context' });
    expect(Object.keys(workRoutingContract.context['~orpc'].errorMap ?? {}).sort()).toEqual([
      'ForbiddenDemo',
      'Unavailable',
    ]);
  });

  test('carries a pinned and an observed account fingerprint and alternate models (ADR 0057)', () => {
    const [declared] = context.declarations;
    const [observed] = context.executorObservations;
    if (!(declared && observed)) {
      throw new Error('fixture context has one declaration and one observation');
    }
    const pinned: WorkRoutingContext = {
      ...context,
      declarations: [{ ...declared, accountFingerprint: '0123456789abcdef', alternateModels: ['Fable'] }],
      executorObservations: [{ ...observed, accountFingerprint: '0123456789abcdef' }],
    };
    expect(parseWorkRoutingContext(pinned)).toEqual(pinned);
  });

  test.each([
    { declarations: [{ ...context.declarations[0], accountFingerprint: 'operator@example.test' }] },
    { declarations: [{ ...context.declarations[0], alternateModels: [] }] },
    { executorObservations: [{ ...context.executorObservations[0], accountFingerprint: '0123456789ABCDEF' }] },
    { executorObservations: [{ ...context.executorObservations[0], email: 'operator@example.test' }] },
    { generatedAt: '2026-10-21T21:05:00Z' },
    { declarations: [{ ...context.declarations[0], authorization: 'maybe' }] },
    { declarations: [{ ...context.declarations[0], targets: [] }] },
    { declarations: [{ ...context.declarations[0], token: 'sk-never' }] },
    { executorObservations: [{ ...context.executorObservations[0], stdout: 'raw output' }] },
    { executorObservations: [{ ...context.executorObservations[0], authEvidence: 'x'.repeat(257) }] },
    { executorObservations: [{ ...context.executorObservations[0], authMethod: 'm'.repeat(65) }] },
    { executorObservations: [{ ...context.executorObservations[0], harness: 'cursor' }] },
    { declarationErrors: [''] },
    { unexpected: true },
  ])('rejects %j', (override) => {
    expect(() => parseWorkRoutingContext({ ...context, ...override })).toThrow();
  });
});

describe('Work routing qualification contract (ADR 0057)', () => {
  const qualification: WorkRoutingQualification = {
    candidates: [
      {
        accountScope: 'personal',
        actions: [],
        candidateId: 'declared:["machine-a","claude-code","personal"]:model:1:Opus',
        eligible: true,
        exclusionReasons: [],
        harness: 'claude-code',
        identity: {
          declared: '0123456789abcdef',
          observed: '0123456789abcdef',
          observedAt: '2026-10-22T08:00:00.000Z',
          state: 'confirmed',
        },
        missingData: ['Quota window Fable · Weekly applies to another model than Opus; not counted.'],
        model: 'Opus',
      },
    ],
    chosenCandidateId: 'declared:["machine-a","claude-code","personal"]:model:1:Opus',
    executors: { outcome: 'success', refreshed: true },
    omittedCandidates: 0,
    qualifiedAt: '2026-10-22T08:00:01.000Z',
    reasons: ['Simulation only: no harness is started and no permission is granted.'],
    recommendation: {
      candidateId: 'declared:["machine-a","claude-code","personal"]:model:1:Opus',
      kind: 'real',
      missing: null,
    },
  };

  test('is one POST that answers the engine decision or a typed failure envelope', () => {
    expect(workRoutingContract.qualify['~orpc'].route).toMatchObject({
      method: 'POST',
      path: '/work/routing-qualification',
    });
    expect(parseWorkRoutingQualifyOutput({ data: qualification, ok: true })).toEqual({ data: qualification, ok: true });
    expect(
      parseWorkRoutingQualifyOutput({
        error: { message: 'The engine is not running.', tag: 'Unavailable' },
        ok: false,
      }),
    ).toMatchObject({ ok: false });
  });

  test.each([
    { leaked: true },
    { executors: { outcome: 'success', refreshed: 'yes' } },
    { recommendation: { candidateId: null, kind: 'likely', missing: null } },
    { reasons: ['x'.repeat(ROUTING_QUALIFICATION_BOUNDS.maxText + 1)] },
    {
      candidates: [
        {
          ...qualification.candidates[0],
          identity: { ...qualification.candidates[0]?.identity, observed: 'operator@example.test' },
        },
      ],
    },
    { candidates: [{ ...qualification.candidates[0], windows: [] }] },
  ])('rejects %j', (override) => {
    expect(() => parseWorkRoutingQualifyOutput({ data: { ...qualification, ...override }, ok: true })).toThrow();
  });
});
