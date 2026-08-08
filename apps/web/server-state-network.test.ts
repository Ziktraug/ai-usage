import { describe, expect, test } from 'bun:test';
import {
  rpcOperationForPathname,
  type ServerStateRequestRecord,
  summarizeServerStateRequests,
} from './e2e/server-state-network';

describe('browser server-state network characterization', () => {
  test('maps physical oRPC paths to stable contract operations and rejects drift', () => {
    expect(rpcOperationForPathname('/rpc/report/focusedOverview')).toBe('report.focusedOverview');
    expect(rpcOperationForPathname('/rpc/session/campaign-children')).toBe('session.campaignChildren');
    expect(rpcOperationForPathname('/rpc/skills/reconcile/example')).toBe('skills.reconcileOne');
    expect(rpcOperationForPathname('/rpc/skills/snapshot')).toBe('skills.snapshot');
    expect(rpcOperationForPathname('/rpc/skills/projectInventories')).toBe('skills.projectInventories');
    expect(rpcOperationForPathname('/skills/__data.json')).toBeUndefined();
    expect(() => rpcOperationForPathname('/rpc/report/renamedWithoutInstrumentation')).toThrow(
      'Unmapped browser oRPC procedure path',
    );
  });

  test('counts route data, procedures, and request owners without conflating them', () => {
    const records: ServerStateRequestRecord[] = [
      {
        method: 'POST',
        operation: 'report.focusedOverview',
        owner: 'svelte-report-root',
        pathname: '/rpc/report/focusedOverview',
        resourceType: 'fetch',
        url: '/rpc/report/focusedOverview',
      },
      {
        method: 'POST',
        operation: 'report.focusedOverview',
        owner: 'svelte-report-root',
        pathname: '/rpc/report/focusedOverview',
        resourceType: 'fetch',
        url: '/rpc/report/focusedOverview',
      },
      {
        method: 'GET',
        pathname: '/skills/__data.json',
        resourceType: 'fetch',
        url: '/skills/__data.json?x-sveltekit-invalidated=1',
      },
    ];

    expect(summarizeServerStateRequests(records)).toEqual({
      operations: { 'report.focusedOverview': 2 },
      owners: { 'svelte-report-root': 2 },
      routeData: 1,
      totalRpc: 2,
    });
  });
});
