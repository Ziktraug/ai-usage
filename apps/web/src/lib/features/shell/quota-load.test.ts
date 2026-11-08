import { expect, spyOn, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { createWebRpcClient } from '../../rpc/client';
import { loadOptionalQuotaRail } from './quota-load';

const rpc = createWebRpcClient({
  url: 'http://quota.invalid/rpc',
  fetch: () => Promise.reject(new Error('Unexpected transport')),
});

test('an optional quota read failure leaves an empty hydration delta instead of rejecting the document', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const state = await loadOptionalQuotaRail({
      createRpc: () => Promise.resolve(rpc),
      createClient: () => ({ getProviderQuotaHistory: () => Promise.reject(new ORPCError('Unavailable')) }),
    });
    expect(state.dehydratedState.queries).toHaveLength(0);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

test('a programming defect in optional acquisition is reported, but still cannot fail the document', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new TypeError('Quota invariant violated');
  try {
    const state = await loadOptionalQuotaRail({ createRpc: () => Promise.reject(failure) });
    expect(state.dehydratedState.queries).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith('Unexpected navigation prefetch failure', failure);
  } finally {
    logged.mockRestore();
  }
});

test.each(['INTERNAL_SERVER_ERROR', 'BAD_REQUEST', 'OUTPUT_VALIDATION_ERROR', 'UNDECLARED'])(
  'reports unexpected RPC code %s without failing optional quota acquisition',
  async (code) => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new ORPCError(code);
    try {
      const state = await loadOptionalQuotaRail({
        createRpc: () => Promise.resolve(rpc),
        createClient: () => ({ getProviderQuotaHistory: () => Promise.reject(error) }),
      });
      expect(state.dehydratedState.queries).toHaveLength(0);
      expect(logged).toHaveBeenCalledWith('Unexpected navigation prefetch failure', error);
    } finally {
      logged.mockRestore();
    }
  },
);
