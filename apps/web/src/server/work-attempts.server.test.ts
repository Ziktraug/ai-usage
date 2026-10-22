import { describe, expect, test } from 'bun:test';
import type { ReviewAttempt } from '@ai-usage/report-core/work-attempts';
import type { UsageEngineCommandCompletion, UsageEngineCommandId } from '@ai-usage/usage-engine-control';
import { UsageStoreError } from '@ai-usage/usage-store/reader';
import {
  listWorkAttemptsForServer,
  releaseWorkAttemptReservationForServer,
  startWorkAttemptForServer,
  toWorkAttemptWire,
  type WorkAttemptsServerReaders,
} from './work-attempts.server';

const NOW = new Date('2026-10-22T10:05:00.000Z');
const attempt: ReviewAttempt = {
  acceptance: 'pending',
  action: 'read-only-review',
  attemptId: 'attempt-1',
  candidateId: 'declared:["machine-a","claude-code","personal"]',
  declaration: {
    accountScope: 'personal',
    authorization: 'allowed',
    capabilities: ['read-only-review'],
    declaredAt: '2026-10-21T08:00:00.000Z',
    effort: 'high',
    harness: 'claude-code',
    machineId: 'machine-a',
    model: 'opus',
    quality: 'review-capable',
    subscription: 'verified',
    targets: [{ kind: 'any-local-session' }],
  },
  durationMs: 5000,
  endedAt: '2026-10-22T10:01:00.000Z',
  executorHarness: 'claude-code',
  exitCode: 0,
  failureReason: null,
  guarantee: {
    cliVersion: '2.1.306',
    effort: null,
    model: 'opus',
    managedSettings: 'absent',
    safeMode: true,
    settingSources: [],
    tools: ['Read', 'Grep', 'Glob'],
  },
  idempotencyKey: 'k'.repeat(64),
  launchSessionId: '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
  machineId: 'machine-a',
  nativeSessionId: 'native-1',
  numTurns: 2,
  pid: 4242,
  releaseEvidence: null,
  releasedAt: null,
  requestedAt: '2026-10-22T10:00:00.000Z',
  resultExcerpt: 'Finding 1',
  resultKind: 'review',
  scope: {
    base: 'first-parent',
    baseSha: 'c'.repeat(40),
    fileCount: 1,
    files: [{ additions: 1, coverage: 'complete', deletions: 0, path: 'a.ts', previousPath: null, status: 'modified' }],
    headSha: 'b'.repeat(40),
    includedBytes: 90,
    includedLines: 7,
    kind: 'commit',
    parentCount: 1,
    patchBytes: 90,
    patchLines: 7,
    patchSha256: 'd'.repeat(64),
    repositoryPrefix: '',
    subject: 'fix: one',
    truncated: false,
    workingTreeDirty: false,
  },
  startedAt: '2026-10-22T10:00:01.000Z',
  state: 'finished',
  target: {
    checkoutOrigin: 'desktop-cwd',
    checkoutPath: '/home/operator/src/ai-usage',
    desktopSessionId: 'local_one',
    harness: 'claude',
    projectLabel: 'ai-usage',
    sessionTitle: 'Investigate',
    sourceSessionId: 'session-a',
  },
  updatedAt: '2026-10-22T10:01:00.000Z',
  validations: [],
};

const readers = (overrides: Partial<WorkAttemptsServerReaders> = {}): WorkAttemptsServerReaders => ({
  now: () => NOW,
  readAttempts: () => Promise.resolve({ attempts: [attempt], skipped: 1, truncated: false }),
  readRouting: () =>
    Promise.resolve({ machineId: 'machine-a', reviewTargets: [{ checkoutPath: '/home/operator/src', label: null }] }),
  resolveSessionRows: ({ harnessKey, sourceSessionIds }) =>
    Promise.resolve(
      new Map(
        harnessKey === 'claude' && sourceSessionIds.includes('native-1') ? [['native-1', 'row-native-1'] as const] : [],
      ),
    ),
  resolveTarget: () =>
    Promise.resolve({
      desktop: {
        cwd: '/home/operator/src/ai-usage',
        desktopSessionId: 'local_one',
        title: 'Investigate',
        worktreePath: null,
      },
      session: null,
    }),
  ...overrides,
});

const completion = (output: unknown): UsageEngineCommandCompletion =>
  ({
    command: 'start-review-attempt',
    commandId: 'c'.repeat(36) as UsageEngineCommandId,
    completedAt: NOW.toISOString(),
    output,
    state: 'succeeded',
  }) as UsageEngineCommandCompletion;

describe('Work attempts server', () => {
  test('lists attempts without pid, key or declaration snapshot and resolves the target admission', async () => {
    const wire = toWorkAttemptWire(attempt, 'row-native-1');
    expect(wire).not.toHaveProperty('pid');
    expect(wire).not.toHaveProperty('idempotencyKey');
    expect(wire).not.toHaveProperty('declaration');
    expect(wire).not.toHaveProperty('launchSessionId');
    expect(wire.reservation).toEqual({ held: false, releaseEvidence: null, releasedAt: null });
    expect(wire.scope as unknown).toEqual(attempt.scope);
    expect(wire.guarantee as unknown).toEqual(attempt.guarantee);
    // A lost attempt not released with evidence still holds the target.
    expect(toWorkAttemptWire({ ...attempt, state: 'lost' }).reservation.held).toBe(true);
    expect(
      toWorkAttemptWire({ ...attempt, releaseEvidence: 'process-absent', releasedAt: attempt.updatedAt, state: 'lost' })
        .reservation,
    ).toEqual({ held: false, releaseEvidence: 'process-absent', releasedAt: attempt.updatedAt });
    expect(wire.declared).toEqual({ accountScope: 'personal', effort: 'high', model: 'opus' });
    // An alternate-model candidate (ADR 0057) shares the declaration; the model it launched is its own.
    const alternate = toWorkAttemptWire({
      ...attempt,
      candidateId: `${attempt.candidateId}:model:1:Fable`,
      declaration: { ...attempt.declaration!, alternateModels: ['Fable'] },
    });
    expect(alternate.declared).toEqual({ accountScope: 'personal', effort: 'high', model: 'Fable' });
    // A candidate id the snapshot does not produce names no model rather than the primary one.
    expect(toWorkAttemptWire({ ...attempt, candidateId: 'declared:unknown' }).declared?.model).toBeNull();
    expect(wire.nativeSessionRowId).toBe('row-native-1');
    expect(toWorkAttemptWire(attempt).nativeSessionRowId).toBeNull();

    const seen: unknown[] = [];
    const output = await listWorkAttemptsForServer(
      { limit: 10, target: { harness: 'claude', sourceSessionId: 'session-a' } },
      {
        mode: 'live',
        readers: readers({
          readAttempts: (input) => {
            seen.push(input);
            return Promise.resolve({ attempts: [attempt], skipped: 1, truncated: true });
          },
        }),
      },
    );
    expect(seen).toEqual([
      { limit: 10, machineId: 'machine-a', target: { harness: 'claude', sourceSessionId: 'session-a' } },
    ]);
    expect(output).toEqual({
      data: {
        attempts: [wire],
        generatedAt: NOW.toISOString(),
        skipped: 1,
        target: {
          admitted: true,
          checkoutOrigin: 'desktop-cwd',
          checkoutPath: '/home/operator/src/ai-usage',
          harness: 'claude',
          sourceSessionId: 'session-a',
        },
        truncated: true,
      },
      ok: true,
    });

    const outside = await listWorkAttemptsForServer(
      { target: { harness: 'claude', sourceSessionId: 'session-a' } },
      {
        mode: 'live',
        readers: readers({ readRouting: () => Promise.resolve({ machineId: 'machine-a', reviewTargets: [] }) }),
      },
    );
    expect(outside.ok && outside.data.target).toMatchObject({
      admitted: false,
      checkoutPath: '/home/operator/src/ai-usage',
    });

    const unresolved = await listWorkAttemptsForServer(
      { target: { harness: 'codex', sourceSessionId: 'x' } },
      { mode: 'live', readers: readers({ resolveTarget: () => Promise.resolve({ desktop: null, session: null }) }) },
    );
    expect(unresolved.ok && unresolved.data.target).toMatchObject({
      admitted: false,
      checkoutOrigin: null,
      checkoutPath: null,
    });

    const untargeted = await listWorkAttemptsForServer({}, { mode: 'live', readers: readers() });
    expect(untargeted.ok && untargeted.data.target).toBeNull();
  });

  test('keeps demo closed, answers the synthetic e2e runtime empty and classifies store failures', async () => {
    expect(await listWorkAttemptsForServer({}, { mode: 'demo', readers: readers() })).toEqual({
      error: { message: 'Execution is not available in the demo.', tag: 'ForbiddenDemo' },
      ok: false,
    });
    expect(await listWorkAttemptsForServer({}, { mode: 'e2e', readers: readers() })).toMatchObject({
      data: { attempts: [], target: null },
      ok: true,
    });
    const incompatible = new UsageStoreError({ message: 'schema', operation: 'read', reason: 'schema-too-new' });
    expect(
      await listWorkAttemptsForServer(
        {},
        { mode: 'live', readers: readers({ readAttempts: () => Promise.reject(incompatible) }) },
      ),
    ).toMatchObject({ error: { tag: 'IncompatibleStore' }, ok: false });
    // Not yet upgraded by the engine: typed, and it says what upgrades it.
    const older = new UsageStoreError({ message: 'columns', operation: 'read', reason: 'schema-too-old' });
    expect(
      await listWorkAttemptsForServer(
        {},
        { mode: 'live', readers: readers({ readAttempts: () => Promise.reject(older) }) },
      ),
    ).toEqual({
      error: {
        message:
          'The usage store has not been upgraded for this version yet; the engine upgrades it when it next starts.',
        tag: 'IncompatibleStore',
      },
      ok: false,
    });
    const privatePath = '/private/usage.sqlite';
    const failed = await listWorkAttemptsForServer(
      {},
      { mode: 'live', readers: readers({ readRouting: () => Promise.reject(new Error(`config at ${privatePath}`)) }) },
    );
    expect(failed).toMatchObject({ error: { tag: 'Unavailable' }, ok: false });
    expect(JSON.stringify(failed)).not.toContain(privatePath);
  });

  test('forwards one engine command, relays a refusal as data and never starts anything in demo or e2e', async () => {
    const commands: unknown[] = [];
    const input = {
      action: 'read-only-review' as const,
      candidateId: 'declared:["machine-a","claude-code","personal"]',
      target: { harness: 'claude', sourceSessionId: 'session-a' },
    };
    const started = await startWorkAttemptForServer(
      input,
      (command) => {
        commands.push(command);
        return Promise.resolve(
          completion({
            attempt: { attemptId: 'attempt-1', reused: false, state: 'starting' },
            kind: 'review-attempt',
            refusal: null,
          }),
        );
      },
      { mode: 'live' },
    );
    expect(commands).toEqual([
      {
        action: 'read-only-review',
        candidateId: input.candidateId,
        command: 'start-review-attempt',
        target: { desktopSessionId: null, harness: 'claude', sourceSessionId: 'session-a' },
      },
    ]);
    expect(started).toEqual({ data: { attemptId: 'attempt-1', reused: false, state: 'starting' }, ok: true });

    const refused = await startWorkAttemptForServer(
      input,
      () =>
        Promise.resolve(
          completion({
            attempt: { attemptId: 'attempt-2', reused: false, state: 'refused' },
            kind: 'review-attempt',
            refusal: {
              message: 'add routing.reviewTargets for /home/operator/src/ai-usage',
              reason: 'target-not-allowed',
            },
          }),
        ),
      { mode: 'live' },
    );
    expect(refused).toEqual({
      error: {
        message: 'add routing.reviewTargets for /home/operator/src/ai-usage',
        reason: 'target-not-allowed',
        tag: 'Refused',
      },
      ok: false,
    });

    const down = await startWorkAttemptForServer(input, () => Promise.reject(new Error('engine-unavailable')), {
      mode: 'live',
    });
    expect(down).toMatchObject({ error: { reason: null, tag: 'Unavailable' }, ok: false });

    let executions = 0;
    const execute = () => {
      executions += 1;
      return Promise.reject(new Error('must not execute'));
    };
    expect(await startWorkAttemptForServer(input, execute, { mode: 'demo' })).toMatchObject({
      error: { tag: 'ForbiddenDemo' },
    });
    expect(await startWorkAttemptForServer(input, execute, { mode: 'e2e' })).toMatchObject({
      error: { tag: 'Unavailable' },
    });
    expect(executions).toBe(0);
  });

  test('forwards the operator release as one engine command and relays what the engine did (ADR 0055)', async () => {
    const commands: unknown[] = [];
    const released = await releaseWorkAttemptReservationForServer(
      { attemptId: 'attempt-lost' },
      (command) => {
        commands.push(command);
        return Promise.resolve({
          command: 'release-review-reservation',
          commandId: 'c'.repeat(36) as UsageEngineCommandId,
          completedAt: NOW.toISOString(),
          output: {
            attemptId: 'attempt-lost',
            evidence: 'operator-declared-ended',
            kind: 'review-reservation-release',
            pids: [],
            releasedAt: NOW.toISOString(),
            result: 'released',
          },
          state: 'succeeded',
        });
      },
      { mode: 'live' },
    );
    expect(commands).toEqual([{ attemptId: 'attempt-lost', command: 'release-review-reservation' }]);
    expect(released).toEqual({
      data: {
        attemptId: 'attempt-lost',
        evidence: 'operator-declared-ended',
        pids: [],
        releasedAt: NOW.toISOString(),
        result: 'released',
      },
      ok: true,
    });
    let executions = 0;
    const execute = () => {
      executions += 1;
      return Promise.reject(new Error('must not execute'));
    };
    expect(await releaseWorkAttemptReservationForServer({ attemptId: 'a' }, execute, { mode: 'demo' })).toMatchObject({
      error: { tag: 'ForbiddenDemo' },
    });
    expect(await releaseWorkAttemptReservationForServer({ attemptId: 'a' }, execute, { mode: 'e2e' })).toMatchObject({
      error: { tag: 'Unavailable' },
    });
    expect(executions).toBe(0);
    expect(
      await releaseWorkAttemptReservationForServer({ attemptId: 'a' }, () => Promise.reject(new Error('down')), {
        mode: 'live',
      }),
    ).toMatchObject({ error: { tag: 'Unavailable' }, ok: false });
  });
});
