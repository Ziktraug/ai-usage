import { describe, expect, test } from 'bun:test';
import { parseWorkRoutingContext, type WorkRoutingContext, workRoutingContract } from './work-routing';

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

  test.each([
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
