import { describe, expect, test } from 'bun:test';
import { UsageStoreError } from '@ai-usage/usage-store/reader';
import { e2eWorkRoutingContext, getWorkRoutingContextForServer } from './work-routing-context.server';

const declaration = {
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
} as const;

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
    });
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
