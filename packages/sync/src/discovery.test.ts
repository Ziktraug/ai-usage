import { afterEach, describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { discoverSnapshotRemotes, healthUrlForHost, snapshotUrlForHost, subnetHostsForAddress } from './discovery';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('snapshot remote discovery', () => {
  test('builds subnet candidates from an IPv4 address', () => {
    const hosts = subnetHostsForAddress('192.168.1.63');

    expect(hosts).toHaveLength(253);
    expect(hosts).toContain('192.168.1.1');
    expect(hosts).not.toContain('192.168.1.63');
  });

  test('discovers healthy snapshot remotes', async () => {
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('192.168.1.10')) {
        return Response.json({ ok: true, machine: { id: 'remote-1', label: 'MacBook' } });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const peers = await Effect.runPromise(
      discoverSnapshotRemotes({
        hosts: ['192.168.1.10', '192.168.1.11'],
        configuredRemotes: [{ name: 'macbook', url: snapshotUrlForHost('192.168.1.10') }],
        localMachine: { id: 'local', label: 'Linux PC' },
      }),
    );

    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      host: '192.168.1.10',
      healthUrl: healthUrlForHost('192.168.1.10'),
      machineId: 'remote-1',
      machineLabel: 'MacBook',
      alreadyConfigured: true,
      self: false,
    });
  });

  test('dedupes peers by machine id', async () => {
    globalThis.fetch = (async () =>
      Response.json({ ok: true, machine: { id: 'remote-1', label: 'MacBook' } })) as unknown as typeof fetch;

    const peers = await Effect.runPromise(discoverSnapshotRemotes({ hosts: ['192.168.1.10', '192.168.1.11'] }));

    expect(peers).toHaveLength(1);
  });
});
