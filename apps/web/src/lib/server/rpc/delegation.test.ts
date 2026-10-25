import { describe, expect, test } from 'bun:test';
import type { DelegationCancelOutput } from '@ai-usage/web-contract/delegation';
import { ORPCError } from '@orpc/client';
import { call } from '@orpc/server';
import { createDelegationRpcRouter, type DelegationFailure, type DelegationRpcDependencies } from './delegation';

const JOB_ID = '0f2c2b0e-6b1a-4c3e-9f1d-2a7b8c9d0e1f';
const cancelOutput: DelegationCancelOutput = { jobId: JOB_ID, result: 'cancelling', state: 'running' };

const router = (dependencies: Partial<DelegationRpcDependencies>) =>
  createDelegationRpcRouter({
    cancel: () => Promise.resolve({ data: cancelOutput, kind: 'ok' }),
    readJob: () => Promise.reject(new Error('readJob is not part of this test')),
    readJobs: () => Promise.resolve({ data: { jobs: [], omitted: 0, skipped: 0 }, kind: 'ok' }),
    readSettings: () => Promise.reject(new Error('readSettings is not part of this test')),
    recordAcceptance: () => Promise.resolve({ data: { evaluationId: 'eval-1' }, kind: 'ok' }),
    saveSettings: () =>
      Promise.resolve({ data: { issues: [], result: 'written', revision: 'a'.repeat(16) }, kind: 'ok' }),
    simulate: () => Promise.reject(new Error('simulate is not part of this test')),
    ...dependencies,
  });

const catchError = async (operation: Promise<unknown>): Promise<ORPCError<string, unknown>> => {
  try {
    await operation;
  } catch (error) {
    if (error instanceof ORPCError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected operation to fail.');
};

describe('Delegation RPC server adapter', () => {
  test('relays the dependency data through the contract schema and forwards cancellation', async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const routes = router({
      cancel: (input, signal) => {
        seen.push([input, signal]);
        return Promise.resolve({ data: cancelOutput, kind: 'ok' });
      },
    });
    expect(await call(routes.cancel, { jobId: JOB_ID }, { signal: controller.signal })).toEqual(cancelOutput);
    expect(seen).toEqual([[{ jobId: JOB_ID }, controller.signal]]);
    expect(await call(routes.jobs, {})).toEqual({ jobs: [], omitted: 0, skipped: 0 });
    expect(await call(routes.saveSettings, { delegation: {}, expectedRevision: 'b'.repeat(16) })).toEqual({
      issues: [],
      result: 'written',
      revision: 'a'.repeat(16),
    });
  });

  test('maps each typed failure to the defined error of the procedure, with its detail', async () => {
    const conflict: DelegationFailure = { kind: 'conflict', message: 'Changed on disk.', revision: 'c'.repeat(16) };
    const saved = await catchError(
      call(router({ saveSettings: () => Promise.resolve(conflict) }).saveSettings, {
        delegation: {},
        expectedRevision: 'b'.repeat(16),
      }),
    );
    expect(saved.code).toBe('Conflict');
    expect(saved.message).toBe('Changed on disk.');
    expect(saved.data).toEqual({ reason: 'revision-conflict', revision: 'c'.repeat(16) });

    const invalid: DelegationFailure = {
      issues: [{ path: 'delegation.rules[0].id', reason: 'must be a slug' }],
      kind: 'invalid-input',
      message: 'Refused.',
      reason: 'invalid-configuration',
    };
    const refused = await catchError(
      call(router({ saveSettings: () => Promise.resolve(invalid) }).saveSettings, {
        delegation: {},
        expectedRevision: 'b'.repeat(16),
      }),
    );
    expect(refused.code).toBe('InvalidInput');
    expect(refused.data).toEqual({
      issues: [{ path: 'delegation.rules[0].id', reason: 'must be a slug' }],
      reason: 'invalid-configuration',
    });

    const demo = await catchError(
      call(router({ readJobs: () => Promise.resolve({ kind: 'forbidden-demo', message: 'Demo.' }) }).jobs, {}),
    );
    expect(demo.code).toBe('ForbiddenDemo');

    const store = await catchError(
      call(router({ readJobs: () => Promise.resolve({ kind: 'incompatible-store', message: 'Old store.' }) }).jobs, {}),
    );
    expect(store.code).toBe('IncompatibleStore');
    expect(store.message).toBe('Old store.');

    const engine = await catchError(
      call(router({ cancel: () => Promise.resolve({ kind: 'engine-unavailable', message: 'Engine down.' }) }).cancel, {
        jobId: JOB_ID,
      }),
    );
    expect(engine.code).toBe('EngineUnavailable');

    // The procedure defines no Conflict: a conflict there is still visible, as Unavailable.
    const jobsConflict = await catchError(call(router({ readJobs: () => Promise.resolve(conflict) }).jobs, {}));
    expect(jobsConflict.code).toBe('Unavailable');
    expect(jobsConflict.data).toEqual({ reason: 'revision-conflict' });

    const missing = await catchError(
      call(router({ readJob: () => Promise.resolve({ kind: 'not-found', message: 'No such job.' }) }).job, {
        jobId: JOB_ID,
      }),
    );
    expect(missing.code).toBe('Unavailable');
    expect(missing.data).toEqual({ reason: 'job-not-found' });
    expect(missing.message).toBe('No such job.');
  });

  test('turns thrown dependencies and malformed answers into Unavailable without leaking paths', async () => {
    const privatePath = '/private/usage-store.sqlite';
    for (const readJobs of [
      () => Promise.reject(new Error(`SQLITE_BUSY at ${privatePath}`)),
      () =>
        Promise.resolve({
          data: { databasePath: privatePath, jobs: [], omitted: 0, skipped: 0 },
          kind: 'ok' as const,
        }),
    ]) {
      const error = await catchError(call(router({ readJobs }).jobs, {}));
      expect(error.code).toBe('Unavailable');
      expect(error.message).not.toContain(privatePath);
      expect(JSON.stringify(error.data)).not.toContain(privatePath);
    }
  });

  test('propagates cancellation instead of reporting it as unavailable', async () => {
    const controller = new AbortController();
    const routes = router({
      readJobs: () => {
        controller.abort();
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      },
    });
    await expect(call(routes.jobs, {}, { signal: controller.signal })).rejects.toBeInstanceOf(DOMException);
  });
});
