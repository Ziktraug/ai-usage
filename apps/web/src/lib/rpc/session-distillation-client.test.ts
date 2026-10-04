import { describe, expect, test } from 'bun:test';
import type { SessionDistillationContractClient } from '@ai-usage/web-contract/session-distillation';
import { createSessionDistillationClient } from './session-distillation-client';

const selection = { revision: 'report-1', rowId: 'row-1' };
const request = { kind: 'evidence' as const, selection, analysisId: 'analysis-1', eventIds: ['event-1', 'event-2'] };
const event = (id: string) => ({
  id,
  callId: null,
  kind: 'user' as const,
  line: 1,
  nativeTurnId: null,
  redacted: false,
  roundId: null,
  text: 'Synthetic request',
  timestamp: null,
  toolName: null,
  truncated: false,
});
const unused = (): Promise<never> => Promise.reject(new Error('Unexpected operation'));

describe('Session analysis browser adapter', () => {
  test('rejects missing, repeated or unrelated evidence while preserving changed-source absence', async () => {
    for (const events of [
      [event('event-1')],
      [event('event-1'), event('event-1')],
      [event('event-1'), event('event-other')],
    ]) {
      const client = createSessionDistillationClient({
        evidence: async () => ({ status: 'available', events }),
        get: unused,
        status: unused,
      });
      await expect(client.evidence(request)).rejects.toThrow('requested events');
    }
    const client = createSessionDistillationClient({
      evidence: async () => ({ status: 'changed', events: [] }),
      get: unused,
      status: unused,
    });
    expect(await client.evidence(request)).toEqual({ status: 'changed', events: [] });
  });

  test('forwards cancellation and rejects malformed successful output', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const transport: SessionDistillationContractClient = {
      evidence: (_input, options) => {
        received = options?.signal;
        return Promise.resolve({ status: 'available', events: request.eventIds.map(event) });
      },
      get: unused,
      status: unused,
    };
    await createSessionDistillationClient(transport).evidence(request, controller.signal);
    expect(received).toBe(controller.signal);
    controller.abort();
    await expect(createSessionDistillationClient(transport).evidence(request, controller.signal)).rejects.toThrow();
    const malformed = {
      ...transport,
      evidence: async () => ({ status: 'available', events: [{ id: 'only-id' }] }),
    } as unknown as SessionDistillationContractClient;
    await expect(createSessionDistillationClient(malformed).evidence(request)).rejects.toThrow();
  });
});
