import { describe, expect, test } from 'bun:test';
import type { UsageEngineCommandCompletion, UsageEngineCommandId } from '@ai-usage/usage-engine-control';
import { UsageStoreError } from '@ai-usage/usage-store/reader';
import type { ExecutorDeclarationWire, WorkRoutingQualification } from '@ai-usage/web-contract/work-routing';
import {
  e2eWorkRoutingContext,
  getWorkRoutingContextForServer,
  qualifyWorkRoutingForServer,
} from './work-routing-context.server';

const declaration: ExecutorDeclarationWire = {
  accountScope: 'personal',
  authorization: 'allowed',
  capabilities: ['read-only-review'],
  declaredAt: '2026-10-21T20:00:00.000Z',
  effort: null,
  harness: 'claude-code',
  machineId: 'machine-a',
  model: null,
  quality: 'review-capable',
  subscription: 'verified',
  targets: [{ kind: 'any-local-session' }],
};

describe('Work routing context server read', () => {
  test('joins declarations and the latest observations for this machine with located issues', async () => {
    const requestedMachines: (string | null)[] = [];
    const context = await getWorkRoutingContextForServer({
      now: () => new Date('2026-10-21T21:05:00.000Z'),
      readDeclarations: () =>
        Promise.resolve({
          configPath: '/home/operator/.config/ai-usage/config.json',
          declarations: [declaration],
          issues: [{ path: 'routing.executors[1].harness', reason: "must be 'claude-code' or 'codex'" }],
          machineId: 'machine-a',
        }),
      readObservations: (machineId) => {
        requestedMachines.push(machineId);
        return Promise.resolve({
          observations: [
            {
              authEvidence: 'codex login status exit 1',
              authMethod: null,
              authState: 'logged-out',
              binaryPath: '/usr/bin/codex',
              harness: 'codex',
              machineId: 'machine-a',
              observedAt: '2026-10-21T21:00:00.000Z',
              outcome: 'observed',
              version: 'codex-cli 0.163.0',
            },
          ],
          skipped: 1,
          truncated: false,
        });
      },
    });
    expect(requestedMachines).toEqual(['machine-a']);
    expect(context).toEqual({
      configPath: '/home/operator/.config/ai-usage/config.json',
      declarationErrors: ["routing.executors[1].harness: must be 'claude-code' or 'codex'"],
      declarations: [declaration],
      executorObservations: [
        {
          authEvidence: 'codex login status exit 1',
          authMethod: null,
          authState: 'logged-out',
          binaryPath: '/usr/bin/codex',
          harness: 'codex',
          machineId: 'machine-a',
          observedAt: '2026-10-21T21:00:00.000Z',
          outcome: 'observed',
          version: 'codex-cli 0.163.0',
        },
      ],
      generatedAt: '2026-10-21T21:05:00.000Z',
      machineId: 'machine-a',
      observationRead: { skipped: 1, truncated: false },
      reviewTargetErrors: [],
      reviewTargets: [],
    });
  });

  test('carries the declared review targets and their located issues', async () => {
    const context = await getWorkRoutingContextForServer({
      now: () => new Date('2026-10-21T21:05:00.000Z'),
      readDeclarations: () =>
        Promise.resolve({
          configPath: '/home/operator/.config/ai-usage/config.json',
          declarations: [],
          issues: [],
          machineId: 'machine-a',
          reviewTargetIssues: [{ path: 'routing.reviewTargets[1].checkoutPath', reason: 'must be an absolute path' }],
          reviewTargets: [{ checkoutPath: '/home/operator/src/ai-usage', label: 'main' }],
        }),
      readObservations: () => Promise.resolve({ observations: [], skipped: 0, truncated: false }),
    });
    expect(context.reviewTargets).toEqual([{ checkoutPath: '/home/operator/src/ai-usage', label: 'main' }]);
    expect(context.reviewTargetErrors).toEqual(['routing.reviewTargets[1].checkoutPath: must be an absolute path']);
  });

  test('propagates read failures and cancellation instead of serving a partial context', async () => {
    const failure = new UsageStoreError({ message: 'schema', operation: 'read', reason: 'schema-too-old' });
    await expect(
      getWorkRoutingContextForServer({
        readDeclarations: () => Promise.resolve({ configPath: '/c', declarations: [], issues: [], machineId: null }),
        readObservations: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
    const controller = new AbortController();
    controller.abort();
    await expect(
      getWorkRoutingContextForServer(
        {
          readDeclarations: () => Promise.reject(new Error('must not be read')),
          readObservations: () => Promise.reject(new Error('must not be read')),
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  test('the Playwright fixture is a valid context with one declared route and one signed-in observation', () => {
    const fixture = e2eWorkRoutingContext();
    expect(fixture.declarations).toHaveLength(1);
    expect(fixture.executorObservations[0]?.authState).toBe('logged-in');
    expect(fixture.declarations[0]?.machineId).toBe(fixture.executorObservations[0]?.machineId);
  });
});

describe('Work routing qualification server relay (ADR 0057)', () => {
  const input = { target: { harness: 'claude', sourceSessionId: 'session-a' } };
  const qualification = {
    candidates: [],
    chosenCandidateId: null,
    executors: { outcome: 'success', refreshed: true },
    omittedCandidates: 0,
    qualifiedAt: '2026-10-22T08:00:00.000Z',
    reasons: ['Simulation only: no harness is started and no permission is granted.'],
    recommendation: { candidateId: null, kind: 'none', missing: null },
  } satisfies WorkRoutingQualification;
  const succeeded = (output: unknown): UsageEngineCommandCompletion =>
    ({
      command: 'qualify-review-routing',
      commandId: 'command-1' as UsageEngineCommandId,
      completedAt: '2026-10-22T08:00:01.000Z',
      output,
      state: 'succeeded',
    }) as UsageEngineCommandCompletion;

  test('forwards exactly one engine command per request and relays the decision', async () => {
    const commands: unknown[] = [];
    const answered = await qualifyWorkRoutingForServer(
      input,
      (command) => {
        commands.push(command);
        return Promise.resolve(succeeded({ kind: 'routing-qualification', qualification }));
      },
      { mode: 'live' },
    );
    expect(commands).toEqual([
      {
        command: 'qualify-review-routing',
        target: { desktopSessionId: null, harness: 'claude', sourceSessionId: 'session-a' },
      },
    ]);
    expect(answered).toEqual({ data: qualification, ok: true });
  });

  test('reports an absent or failing engine as Unavailable data and never contacts it in demo or e2e', async () => {
    expect(await qualifyWorkRoutingForServer(input, () => Promise.reject(new Error('down')), { mode: 'live' })).toEqual(
      {
        error: { message: 'The engine could not qualify the routing; it may be stopped or busy.', tag: 'Unavailable' },
        ok: false,
      },
    );
    const failed = {
      command: 'qualify-review-routing',
      commandId: 'command-1' as UsageEngineCommandId,
      completedAt: '2026-10-22T08:00:01.000Z',
      error: { code: 'command-failed', message: 'x' },
      state: 'failed',
    } as UsageEngineCommandCompletion;
    expect(await qualifyWorkRoutingForServer(input, () => Promise.resolve(failed), { mode: 'live' })).toMatchObject({
      error: { tag: 'Unavailable' },
      ok: false,
    });
    const never = () => Promise.reject(new Error('the engine must not be contacted'));
    expect(await qualifyWorkRoutingForServer(input, never, { mode: 'demo' })).toEqual({
      error: { message: 'Routing qualification is not available in the demo.', tag: 'ForbiddenDemo' },
      ok: false,
    });
    const e2e = await qualifyWorkRoutingForServer(input, never, {
      mode: 'e2e',
      now: () => new Date('2026-06-11T09:05:00.000Z'),
    });
    expect(e2e.ok).toBe(true);
    if (e2e.ok) {
      // The fixture route is declared and signed in but has no quota: never a real recommendation.
      expect(e2e.data.executors).toEqual({ outcome: 'not-run', refreshed: false });
      expect(e2e.data.recommendation.kind).toBe('conditional');
      expect(e2e.data.recommendation.missing).toBe('quota observation');
    }
  });
});
