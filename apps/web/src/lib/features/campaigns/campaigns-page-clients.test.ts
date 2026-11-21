import { describe, expect, test } from 'bun:test';
import type { WebContractClient } from '@ai-usage/web-contract';
import { campaignPageClientsFor } from './campaigns-page-clients';
import { createSyntheticCampaignClient } from './campaigns-synthetic';

/** An RPC client that records the label overrides and session lookup reads it receives. */
const recordingRpc = () => {
  const calls: unknown[] = [];
  const sessionCalls: unknown[] = [];
  const rpc = {
    campaign: {
      labelOverrides: (input: unknown) => {
        calls.push(input);
        return Promise.resolve({ campaignLabelOverrides: [] });
      },
    },
    session: {
      lookup: (input: unknown) => {
        sessionCalls.push(input);
        return Promise.reject(new Error('Recorded lookup.'));
      },
    },
  } as unknown as WebContractClient;
  return { calls, rpc, sessionCalls };
};

describe('campaignPageClientsFor', () => {
  test('uses named placeholders while rendering on the server', async () => {
    const { calls, rpc } = recordingRpc();
    const clients = campaignPageClientsFor({ browser: false, mode: 'live', rpc });
    await expect(clients.report.getCampaignLabelOverrides()).rejects.toThrow(
      'The campaigns report RPC client is unavailable during SSR',
    );
    await expect(clients.session.lookup({ revision: 'r', rowId: 'x' })).rejects.toThrow(
      'The campaigns session RPC client is unavailable during SSR',
    );
    expect(calls).toEqual([]);
  });

  test('uses the placeholders in a browser without an RPC context', async () => {
    const clients = campaignPageClientsFor({ browser: true, mode: 'live', rpc: undefined });
    await expect(clients.report.getCampaignLabelOverrides()).rejects.toThrow('campaigns report');
    await expect(clients.session.lookup({ revision: 'r', rowId: 'x' })).rejects.toThrow('campaigns session');
  });

  test('reads live data through the browser RPC adapters', async () => {
    const { calls, rpc, sessionCalls } = recordingRpc();
    const clients = campaignPageClientsFor({ browser: true, mode: 'live', rpc });
    expect(await clients.report.getCampaignLabelOverrides()).toEqual({ campaignLabelOverrides: [] });
    expect(calls).toEqual([{}]);
    await expect(clients.session.lookup({ revision: 'r', rowId: 'x' })).rejects.toThrow('Recorded lookup.');
    expect(sessionCalls).toEqual([{ revision: 'r', rowId: 'x' }]);
  });

  test('outside live mode, sessions come from the synthetic campaign map in every environment', async () => {
    for (const browser of [false, true]) {
      const { rpc, sessionCalls } = recordingRpc();
      const clients = campaignPageClientsFor({ browser, mode: 'demo', rpc });
      expect(Object.keys(clients.session)).toEqual(Object.keys(createSyntheticCampaignClient()));
      await expect(clients.session.vcs({ rowId: 'x' } as never)).rejects.toThrow('unavailable for synthetic campaigns');
      expect(sessionCalls).toEqual([]);
    }
  });
});
