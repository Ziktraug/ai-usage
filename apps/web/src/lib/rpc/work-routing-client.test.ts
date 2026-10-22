import { describe, expect, test } from 'bun:test';
import type { WorkRoutingContext, WorkRoutingQualification } from '@ai-usage/web-contract/work-routing';
import { ORPCError } from '@orpc/client';
import {
  createWorkRoutingClient,
  createWorkRoutingQualifyClient,
  type WorkRoutingRpcTransport,
} from './work-routing-client';

const context: WorkRoutingContext = {
  configPath: null,
  declarationErrors: [],
  declarations: [],
  executorObservations: [],
  generatedAt: '2026-10-21T21:05:00.000Z',
  machineId: null,
  observationRead: { skipped: 0, truncated: false },
};

describe('Work routing browser client', () => {
  test('validates output, forwards the caller signal and turns typed errors into data', async () => {
    const controller = new AbortController();
    let receivedInput: unknown;
    let receivedSignal: AbortSignal | undefined;
    const client = createWorkRoutingClient({
      context: (input, options) => {
        receivedInput = input;
        receivedSignal = options?.signal;
        return Promise.resolve(context);
      },
    });
    expect(await client.getContext({ signal: controller.signal })).toEqual({ data: context, ok: true });
    expect(receivedInput).toEqual({});
    expect(receivedSignal).toBe(controller.signal);

    const demo = createWorkRoutingClient({
      context: () =>
        Promise.reject(new ORPCError('ForbiddenDemo', { defined: true, message: 'Demo mode.', status: 403 })),
    });
    expect(await demo.getContext()).toEqual({ error: { message: 'Demo mode.', tag: 'ForbiddenDemo' }, ok: false });

    const malformed = createWorkRoutingClient({
      context: () => Promise.resolve({ ...context, databasePath: '/private/store' } as never),
    } as WorkRoutingRpcTransport);
    const result = await malformed.getContext();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('/private/store');
  });

  test('re-throws cancellation instead of reporting it as unavailable', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createWorkRoutingClient({ context: () => Promise.resolve(context) });
    await expect(client.getContext({ signal: controller.signal })).rejects.toThrow();
  });
});

describe('Work routing qualification browser client (ADR 0057)', () => {
  const input = { target: { desktopSessionId: null, harness: 'claude', sourceSessionId: 'session-a' } };
  const qualification = {
    candidates: [],
    chosenCandidateId: null,
    executors: { outcome: 'success', refreshed: true },
    omittedCandidates: 0,
    qualifiedAt: '2026-10-22T08:00:00.000Z',
    reasons: ['Simulation only: no harness is started and no permission is granted.'],
    recommendation: { candidateId: null, kind: 'none', missing: null },
  } satisfies WorkRoutingQualification;

  test('posts each request to the engine path, validates the envelope and maps failures to data', async () => {
    const received: unknown[] = [];
    const client = createWorkRoutingQualifyClient({
      qualify: (value) => {
        received.push(value);
        return Promise.resolve({ data: qualification, ok: true } as never);
      },
    });
    expect(await client.qualify(input)).toEqual({ data: qualification, ok: true });
    expect(await client.qualify(input)).toEqual({ data: qualification, ok: true });
    // No cache: two clicks are two engine qualifications.
    expect(received).toEqual([input, input]);

    const demo = createWorkRoutingQualifyClient({
      qualify: () =>
        Promise.reject(new ORPCError('ForbiddenDemo', { defined: true, message: 'Demo mode.', status: 403 })),
    });
    expect(await demo.qualify(input)).toEqual({ error: { message: 'Demo mode.', tag: 'ForbiddenDemo' }, ok: false });

    const leaking = createWorkRoutingQualifyClient({
      qualify: () => Promise.resolve({ data: { ...qualification, windows: [] }, ok: true } as never),
    });
    expect(await leaking.qualify(input)).toEqual({
      error: { message: 'The routing could not be qualified.', tag: 'Unavailable' },
      ok: false,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(client.qualify(input, { signal: controller.signal })).rejects.toThrow();
  });
});
