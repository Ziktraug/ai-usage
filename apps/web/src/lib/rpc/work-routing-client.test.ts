import { describe, expect, test } from 'bun:test';
import type { WorkRoutingContext } from '@ai-usage/web-contract/work-routing';
import { ORPCError } from '@orpc/client';
import { createWorkRoutingClient, type WorkRoutingRpcTransport } from './work-routing-client';

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
