import { describe, expect, test } from 'bun:test';
import { parseUsageEngineReplicationStatusOutput } from '@ai-usage/usage-engine-control';
import { renderReplicationStatus } from './replication';

describe('replication status rendering', () => {
  test('renders local-only mode without inventing outbox state', () => {
    const status = parseUsageEngineReplicationStatusOutput({
      kind: 'replication-status',
      lastDiagnostic: null,
      memory: null,
      mode: 'local-only',
      runtimeState: 'disabled',
      usage: null,
    });

    expect(renderReplicationStatus(status, false)).toBe(
      'Replication: local-only\nRuntime: disabled\nLast diagnostic: none\nUsage: not configured\nMemory: not configured',
    );
    expect(JSON.parse(renderReplicationStatus(status, true))).toEqual(status);
  });

  test('renders only bounded connected metadata', () => {
    const status = parseUsageEngineReplicationStatusOutput({
      kind: 'replication-status',
      lastDiagnostic: { code: 'blocked', problemCode: 'generation-gap', streamId: 'memory-v1' },
      memory: {
        acknowledged: 4,
        acknowledgedThroughGeneration: 4,
        blocked: 1,
        inFlight: 0,
        lastAcknowledgedAt: '2026-08-30T10:00:00.000Z',
        lastErrorCode: 'generation-gap',
        nextRetryAt: null,
        oldestUnacknowledgedAt: '2026-08-30T10:01:00.000Z',
        pending: 0,
        streamId: 'memory-v1',
      },
      mode: 'connected',
      runtimeState: 'waiting',
      usage: null,
    });

    const rendered = renderReplicationStatus(status, false);
    expect(rendered).toContain('Last diagnostic: blocked · memory-v1 · generation-gap');
    expect(rendered).toContain('Memory (memory-v1): pending=0 in-flight=0 blocked=1 acknowledged=4 ack-generation=4');
    expect(rendered).not.toContain('payload');
  });
});
