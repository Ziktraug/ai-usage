import { describe, expect, test } from 'bun:test';
import type { DelegationCancelOutput, DelegationJobsOutput } from '@ai-usage/web-contract/delegation';
import { ORPCError } from '@orpc/client';
import { createDelegationClient, type DelegationRpcTransport } from './delegation-client';

const JOB_ID = '0f2c2b0e-6b1a-4c3e-9f1d-2a7b8c9d0e1f';
const jobsOutput: DelegationJobsOutput = { jobs: [], omitted: 0, skipped: 0 };
const cancelOutput: DelegationCancelOutput = { jobId: JOB_ID, result: 'cancelling', state: 'running' };

const rejecting = (error: unknown): DelegationRpcTransport => ({
  cancel: () => Promise.reject(error),
  job: () => Promise.reject(error),
  jobs: () => Promise.reject(error),
  recordAcceptance: () => Promise.reject(error),
  saveSettings: () => Promise.reject(error),
  settings: () => Promise.reject(error),
  simulate: () => Promise.reject(error),
});

describe('Delegation browser client', () => {
  test('validates the answers and forwards inputs and the caller signal', async () => {
    const controller = new AbortController();
    const calls: unknown[] = [];
    const client = createDelegationClient({
      ...rejecting(new Error('not part of this test')),
      cancel: (input, options) => {
        calls.push(['cancel', input, options?.signal]);
        return Promise.resolve(cancelOutput);
      },
      jobs: (input, options) => {
        calls.push(['jobs', input, options?.signal]);
        return Promise.resolve(jobsOutput);
      },
      settings: (input, options) => {
        calls.push(['settings', input, options?.signal]);
        return Promise.resolve({} as never);
      },
    });
    expect(await client.jobs({ limit: 20 }, { signal: controller.signal })).toEqual({ data: jobsOutput, ok: true });
    expect(await client.cancel({ jobId: JOB_ID }, { signal: controller.signal })).toEqual({
      data: cancelOutput,
      ok: true,
    });
    // An answer the contract refuses is unavailable, never rendered.
    expect(await client.settings({ signal: controller.signal })).toEqual({
      error: { message: 'Delegation settings are unavailable.', tag: 'Unavailable' },
      ok: false,
    });
    expect(calls).toEqual([
      ['jobs', { limit: 20 }, controller.signal],
      ['cancel', { jobId: JOB_ID }, controller.signal],
      ['settings', {}, controller.signal],
    ]);
  });

  test('keeps a defined error with its tag, revision, issues and reason', async () => {
    const conflict = createDelegationClient(
      rejecting(
        new ORPCError('Conflict', {
          data: { reason: 'revision-conflict', revision: 'c'.repeat(16) },
          defined: true,
          message: 'Changed on disk.',
          status: 409,
        }),
      ),
    );
    expect(await conflict.saveSettings({ delegation: {}, expectedRevision: 'a'.repeat(16) })).toEqual({
      error: { message: 'Changed on disk.', reason: 'revision-conflict', revision: 'c'.repeat(16), tag: 'Conflict' },
      ok: false,
    });
    const invalid = createDelegationClient(
      rejecting(
        new ORPCError('InvalidInput', {
          data: {
            issues: [{ path: 'delegation.rules[0].id', reason: 'must be a slug' }, { bogus: true }],
            reason: 'invalid-configuration',
          },
          defined: true,
          message: 'Refused.',
          status: 422,
        }),
      ),
    );
    expect(await invalid.saveSettings({ delegation: {}, expectedRevision: 'a'.repeat(16) })).toEqual({
      error: {
        issues: [{ path: 'delegation.rules[0].id', reason: 'must be a slug' }],
        message: 'Refused.',
        reason: 'invalid-configuration',
        tag: 'InvalidInput',
      },
      ok: false,
    });
    const missing = createDelegationClient(
      rejecting(
        new ORPCError('Unavailable', {
          data: { reason: 'job-not-found' },
          defined: true,
          message: 'No delegation job has this id.',
          status: 503,
        }),
      ),
    );
    expect(await missing.job({ jobId: JOB_ID })).toEqual({
      error: { message: 'No delegation job has this id.', reason: 'job-not-found', tag: 'Unavailable' },
      ok: false,
    });
    const demo = createDelegationClient(
      rejecting(new ORPCError('ForbiddenDemo', { defined: true, message: 'Demo mode.', status: 403 })),
    );
    expect(await demo.settings()).toEqual({ error: { message: 'Demo mode.', tag: 'ForbiddenDemo' }, ok: false });
  });

  test('maps anything else to Unavailable with fixed text and never leaks a server detail', async () => {
    const privatePath = '/private/store.sqlite';
    const client = createDelegationClient(rejecting(new Error(`engine at ${privatePath}`)));
    const outcomes = await Promise.all([
      client.settings(),
      client.jobs({}),
      client.job({ jobId: JOB_ID }),
      client.saveSettings({ delegation: {}, expectedRevision: 'a'.repeat(16) }),
      client.simulate({ checkoutPath: '/x', scope: { commit: 'HEAD', kind: 'commit' }, taskCategory: 'tests' }),
      client.cancel({ jobId: JOB_ID }),
      client.recordAcceptance({ jobId: JOB_ID, verdict: 'accepted' }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ error: { tag: 'Unavailable' }, ok: false });
      expect(JSON.stringify(outcome)).not.toContain(privatePath);
    }
    // An undefined oRPC error (a 500 the server did not type) is not trusted either.
    const untyped = createDelegationClient(
      rejecting(new ORPCError('Conflict', { defined: false, message: `at ${privatePath}`, status: 500 })),
    );
    expect(await untyped.jobs({})).toEqual({
      error: { message: 'Delegation jobs are unavailable.', tag: 'Unavailable' },
      ok: false,
    });
  });

  test('re-throws cancellation instead of reporting it as unavailable', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createDelegationClient({
      ...rejecting(new Error('not part of this test')),
      jobs: () => Promise.resolve(jobsOutput),
    });
    await expect(client.jobs({}, { signal: controller.signal })).rejects.toThrow();
    await expect(client.cancel({ jobId: JOB_ID }, { signal: controller.signal })).rejects.toThrow();
  });
});
