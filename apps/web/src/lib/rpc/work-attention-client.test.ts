import { describe, expect, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { syntheticWorkAttentionDataset } from '../features/work/work-attention-synthetic';
import {
  createWorkAttentionClient,
  parseWorkAttentionDataset,
  resolveWorkAttentionClient,
  type WorkAttentionRpc,
} from './work-attention-client';

const dataset = syntheticWorkAttentionDataset();
const rpcAnswering = (answer: () => Promise<unknown>): WorkAttentionRpc => ({ work: { attention: answer } });
const serialized = (): unknown => JSON.parse(JSON.stringify(dataset));

describe('Work attention client narrowing', () => {
  test('accepts a well-formed envelope and returns the dataset typed by the shared contract', async () => {
    const calls: unknown[] = [];
    const client = createWorkAttentionClient(
      rpcAnswering((...input) => {
        calls.push(input);
        return Promise.resolve({ data: serialized(), ok: true });
      }),
    );
    const result = await client.attention({ limit: 100, machineId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.roots).toHaveLength(dataset.roots.length);
      expect(result.data.roots[0]?.session).toEqual(dataset.roots[0]?.session ?? null);
      expect(result.data.coverage.desktopSessions.filesParsed).toBe(39);
    }
    expect(calls).toEqual([[{ limit: 100, machineId: null }, {}]]);
  });
  test('the rpc receives the normalized request and the abort signal', async () => {
    const seen: unknown[] = [];
    const controller = new AbortController();
    const client = createWorkAttentionClient(rpcAnswering(() => Promise.resolve({ data: serialized(), ok: true })));
    const spy: WorkAttentionRpc = {
      work: {
        attention: (input, options) => {
          seen.push(input, options?.signal === controller.signal);
          return Promise.resolve({ data: serialized(), ok: true });
        },
      },
    };
    await createWorkAttentionClient(spy).attention({ limit: 50 }, { signal: controller.signal });
    expect(seen).toEqual([{ limit: 50 }, true]);
    await expect(client.attention({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(client.attention({ limit: 201 })).rejects.toBeInstanceOf(RangeError);
  });
  test.each([
    ['not an object', 'nope'],
    ['missing ok', { data: dataset }],
    ['data without roots', { data: { ...dataset, roots: undefined }, ok: true }],
    [
      'root with an unknown attention',
      { data: { ...dataset, roots: [{ ...dataset.roots[0], attention: 'urgent' }] }, ok: true },
    ],
    [
      'root with an unknown fact kind',
      {
        data: {
          ...dataset,
          roots: [
            {
              ...dataset.roots[0],
              facts: [{ id: 'x', kind: 'rumour', provenance: dataset.roots[0]?.facts[0]?.provenance }],
            },
          ],
        },
        ok: true,
      },
    ],
    ['total below the served roots', { data: { ...dataset, totalRoots: 1 }, ok: true }],
    [
      'root without the reconsidered flag',
      { data: { ...dataset, roots: [{ ...dataset.roots[0], reconsidered: undefined }] }, ok: true },
    ],
    ['too many roots', { data: { ...dataset, roots: Array.from({ length: 201 }, () => dataset.roots[0]) }, ok: true }],
    ['error without a known tag', { error: { message: 'x', tag: 'Teapot' }, ok: false }],
  ])('rejects a malformed envelope (%s) as a typed failure without inventing data', async (_label, response) => {
    const client = createWorkAttentionClient(rpcAnswering(() => Promise.resolve(response)));
    const result = await client.attention({});
    expect(result).toEqual({
      error: { message: 'The Work attention response did not match the shared contract.', tag: 'MalformedResponse' },
      ok: false,
    });
  });
  test('passes the envelope error tags through and maps defined oRPC errors', async () => {
    const forbidden = createWorkAttentionClient(
      rpcAnswering(() =>
        Promise.resolve({ error: { message: 'Demo serves no store.', tag: 'ForbiddenDemo' }, ok: false }),
      ),
    );
    expect(await forbidden.attention({})).toEqual({
      error: { message: 'Demo serves no store.', tag: 'ForbiddenDemo' },
      ok: false,
    });
    const thrown = createWorkAttentionClient(
      rpcAnswering(() => Promise.reject(new ORPCError('IncompatibleStore', { defined: true, message: 'Schema 3.' }))),
    );
    expect(await thrown.attention({})).toEqual({
      error: { message: 'Schema 3.', tag: 'IncompatibleStore' },
      ok: false,
    });
  });
  test('maps transport failures to one generic unavailability without the transport message', async () => {
    const client = createWorkAttentionClient(rpcAnswering(() => Promise.reject(new Error('ECONNREFUSED 127.0.0.1'))));
    const result = await client.attention({});
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
    if (!result.ok) {
      expect(result.error.tag).toBe('Unavailable');
    }
  });
  test('an aborted call rejects with the abort reason instead of a result', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createWorkAttentionClient(rpcAnswering(() => Promise.resolve({ data: serialized(), ok: true })));
    await expect(client.attention({}, { signal: controller.signal })).rejects.toBeDefined();
  });
  test('the integration seam reads work.attention through the contract client', async () => {
    const calls: unknown[] = [];
    const rpc = {
      work: {
        attention: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({ data: serialized(), ok: true });
        },
      },
    };
    const result = await resolveWorkAttentionClient(rpc as never).attention({ limit: 20 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ limit: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.roots.length).toBe(dataset.roots.length);
    }
  });
});

describe('parseWorkAttentionDataset', () => {
  test('round-trips the synthetic dataset through JSON', () => {
    expect(parseWorkAttentionDataset(serialized())).toEqual(dataset);
  });
  test('refuses text over the shared bounds instead of truncating it', () => {
    const oversized = { ...(serialized() as Record<string, unknown>) };
    const roots = (oversized.roots as Record<string, unknown>[]).map((root, index) =>
      index === 0 ? { ...root, title: 'x'.repeat(257) } : root,
    );
    expect(parseWorkAttentionDataset({ ...oversized, roots })).toBeUndefined();
  });
});
