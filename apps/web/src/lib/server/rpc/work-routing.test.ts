import { describe, expect, test } from 'bun:test';
import type { WorkRoutingContext, WorkRoutingQualification } from '@ai-usage/web-contract/work-routing';
import { ORPCError } from '@orpc/client';
import { call } from '@orpc/server';
import { createWorkRoutingRpcRouter, type WorkRoutingRpcDependencies } from './work-routing';

const context: WorkRoutingContext = {
  configPath: '/home/operator/.config/ai-usage/config.json',
  declarationErrors: [],
  declarations: [],
  executorObservations: [],
  generatedAt: '2026-10-21T21:05:00.000Z',
  machineId: 'machine-a',
  observationRead: { skipped: 0, truncated: false },
};

const router = (dependencies: Partial<WorkRoutingRpcDependencies>) =>
  createWorkRoutingRpcRouter({
    isDemo: () => Promise.resolve(false),
    qualify: () => Promise.reject(new Error('qualify is not part of this test')),
    readContext: () => Promise.resolve(context),
    ...dependencies,
  });

const catchError = async (operation: Promise<unknown>): Promise<unknown> => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to fail.');
};

describe('Work routing RPC server adapter', () => {
  test('returns the exact bounded context and forwards cancellation', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const routes = router({
      readContext: (signal) => {
        receivedSignal = signal;
        return Promise.resolve(context);
      },
    });
    expect(await call(routes.context, {}, { signal: controller.signal })).toEqual(context);
    expect(receivedSignal).toBe(controller.signal);
  });

  test('rejects demo mode before reading anything', async () => {
    let reads = 0;
    const routes = router({
      isDemo: () => Promise.resolve(true),
      readContext: () => {
        reads += 1;
        return Promise.resolve(context);
      },
    });
    const error = await catchError(call(routes.context, {}));
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe('ForbiddenDemo');
    expect(reads).toBe(0);
  });

  test('relays the engine qualification envelope and turns failures into Unavailable data (ADR 0057)', async () => {
    const qualification: WorkRoutingQualification = {
      candidates: [],
      chosenCandidateId: null,
      executors: { outcome: 'success', refreshed: true },
      omittedCandidates: 0,
      qualifiedAt: '2026-10-22T08:00:00.000Z',
      reasons: ['Simulation only: no harness is started and no permission is granted.'],
      recommendation: { candidateId: null, kind: 'none', missing: null },
    };
    const inputs: unknown[] = [];
    const input = { target: { harness: 'claude', sourceSessionId: 'session-a' } };
    const routes = router({
      qualify: (value) => {
        inputs.push(value);
        return Promise.resolve({ data: qualification, ok: true });
      },
    });
    expect(await call(routes.qualify, input)).toEqual({ data: qualification, ok: true });
    expect(inputs).toEqual([input]);
    for (const qualify of [
      () => Promise.reject(new Error('/private/engine.sock refused')),
      () => Promise.resolve({ data: { ...qualification, windows: [] }, ok: true }),
    ]) {
      const answer = await call(router({ qualify }).qualify, input);
      expect(answer).toEqual({
        error: { message: 'The routing could not be qualified.', tag: 'Unavailable' },
        ok: false,
      });
    }
  });

  test('sanitizes malformed or failed reads without leaking paths', async () => {
    const privatePath = '/private/usage-store.sqlite';
    for (const readContext of [
      () => Promise.resolve({ ...context, databasePath: privatePath }),
      () => Promise.reject(new Error(`Invalid ai-usage config: ${privatePath}`)),
    ]) {
      const error = await catchError(call(router({ readContext }).context, {}));
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe('Unavailable');
      expect((error as Error).message).not.toContain(privatePath);
    }
  });
});
