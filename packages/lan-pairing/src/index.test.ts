import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import {
  discoverLanPeers,
  discoveryHostsForAddresses,
  LAN_PAIRING_PORT_RANGE,
  LanPairingError,
  makeLanPairingService,
  makeLanPairingServiceWithOptions,
  subnetHostsForAddress,
  type LanPeerProbeTransport,
  type LanPairingService,
  type LanPeerIdentity,
} from './index';

const identity = (id: string): LanPeerIdentity => ({
  id,
  label: id,
  protocol: 'example-protocol',
  version: 1,
});

const makeService = () => Effect.runPromise(makeLanPairingService);

const stopAll = async (...services: LanPairingService[]) => {
  await Promise.all(services.map((service) => Effect.runPromise(service.stop())));
};

const missingPeer = (host: string, port: number) =>
  new LanPairingError({
    operation: 'readLanPeer',
    message: `No peer at ${host}:${port}`,
    reason: 'peer-not-found',
  });

describe('LAN pairing public boundary', () => {
  test('documents the stable v1 LAN port range', () => {
    expect(LAN_PAIRING_PORT_RANGE).toEqual({ start: 3847, end: 3857 });
  });

  test('keeps peer identity generic and project-agnostic', () => {
    const identity: LanPeerIdentity = {
      id: 'peer-a',
      label: 'Peer A',
      protocol: 'example-protocol',
      version: 1,
    };

    expect(identity.protocol).toBe('example-protocol');
  });

  test('uses a typed public error', () => {
    const error = new LanPairingError({
      message: 'Peer was not found',
      operation: 'scan',
      reason: 'peer-not-found',
    });

    expect(error._tag).toBe('LanPairingError');
  });

  test('builds active subnet discovery candidates from multiple local interfaces', () => {
    const hosts = discoveryHostsForAddresses(['192.168.1.63', '10.0.0.4']);

    expect(subnetHostsForAddress('192.168.1.63')).toHaveLength(253);
    expect(hosts).toContain('192.168.1.1');
    expect(hosts).toContain('10.0.0.1');
    expect(hosts).not.toContain('192.168.1.63');
    expect(hosts).not.toContain('10.0.0.4');
  });

  test('scans the stable LAN port range through an injectable transport', async () => {
    const probes: Array<{ host: string; port: number }> = [];
    const transport: LanPeerProbeTransport = {
      readPeer: (input) => {
        probes.push({ host: input.host, port: input.port });
        if (input.host === '192.168.1.10' && input.port === 3850) {
          return Effect.succeed({ identity: identity('peer-a'), pairingAvailable: true });
        }
        return Effect.fail(missingPeer(input.host, input.port));
      },
    };

    const peers = await Effect.runPromise(
      discoverLanPeers({
        localIdentity: identity('local'),
        hosts: ['192.168.1.10'],
        transport,
        now: new Date('2026-06-19T12:00:00.000Z'),
      }),
    );

    expect(probes.map((probe) => probe.port).sort((a, b) => a - b)).toEqual([
      3847,
      3848,
      3849,
      3850,
      3851,
      3852,
      3853,
      3854,
      3855,
      3856,
      3857,
    ]);
    expect(peers).toEqual([
      {
        identity: identity('peer-a'),
        host: '192.168.1.10',
        port: 3850,
        online: true,
        pairingAvailable: true,
        self: false,
        lastSeenAt: '2026-06-19T12:00:00.000Z',
      },
    ]);
  });

  test('dedupes discovered peers by machine id and marks self peers', async () => {
    const transport: LanPeerProbeTransport = {
      readPeer: (input) => {
        if (input.host === '192.168.1.10') {
          return Effect.succeed({ identity: { ...identity('peer-a'), label: 'Peer A' }, pairingAvailable: true });
        }
        if (input.host === '192.168.1.11') {
          return Effect.succeed({ identity: { ...identity('peer-a'), label: 'Peer A Duplicate' }, pairingAvailable: true });
        }
        if (input.host === '192.168.1.12') {
          return Effect.succeed({ identity: { ...identity('local'), label: 'Local' }, pairingAvailable: true });
        }
        return Effect.fail(missingPeer(input.host, input.port));
      },
    };

    const peers = await Effect.runPromise(
      discoverLanPeers({
        localIdentity: identity('local'),
        hosts: ['192.168.1.10', '192.168.1.11', '192.168.1.12'],
        ports: [3847],
        transport,
      }),
    );

    expect(peers).toHaveLength(2);
    expect(peers.find((peer) => peer.identity.id === 'peer-a')?.host).toBe('192.168.1.10');
    expect(peers.find((peer) => peer.identity.id === 'local')?.self).toBe(true);
  });

  test('service scan updates the discovery cache and marks missing peers offline', async () => {
    let online = true;
    const transport: LanPeerProbeTransport = {
      readPeer: (input) =>
        online
          ? Effect.succeed({ identity: { ...identity('peer-a'), label: 'Peer A' }, pairingAvailable: true })
          : Effect.fail(missingPeer(input.host, input.port)),
    };
    const service = await Effect.runPromise(
      makeLanPairingServiceWithOptions({
        discoveryHosts: ['192.168.1.10'],
        discoveryTransport: transport,
      }),
    );

    try {
      await Effect.runPromise(service.start({ identity: identity('local'), portRange: { start: 0, end: 0 } }));
      const first = await Effect.runPromise(service.scan());
      online = false;
      const second = await Effect.runPromise(service.scan());
      const state = await Effect.runPromise(service.getState());

      expect(first[0]?.online).toBe(true);
      expect(second[0]?.online).toBe(false);
      expect(state.discoveredPeers[0]?.online).toBe(false);
    } finally {
      await stopAll(service);
    }
  });

  test('starts two local servers on random ports', async () => {
    const first = await makeService();
    const second = await makeService();

    try {
      await Effect.runPromise(first.start({ identity: identity('peer-a'), portRange: { start: 0, end: 0 } }));
      await Effect.runPromise(second.start({ identity: identity('peer-b'), portRange: { start: 0, end: 0 } }));
      const firstState = await Effect.runPromise(first.getState());
      const secondState = await Effect.runPromise(second.getState());

      expect(firstState.status).toBe('running');
      expect(secondState.status).toBe('running');
      expect(firstState.port).toBeNumber();
      expect(secondState.port).toBeNumber();
      expect(firstState.port).not.toBe(secondState.port);

      const health = await fetch(`http://127.0.0.1:${firstState.port}/lan/health`);
      expect(health.status).toBe(200);
      expect((await health.json()).peer.identity.id).toBe('peer-a');
    } finally {
      await stopAll(first, second);
    }
  });

  test('skips an occupied port and uses the next port in range', async () => {
    const occupied = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('occupied'),
    });
    const occupiedPort = occupied.port ?? 0;
    const service = await makeService();

    try {
      await Effect.runPromise(
        service.start({
          identity: identity('peer-a'),
          portRange: { start: occupiedPort, end: occupiedPort + 1 },
        }),
      );
      const state = await Effect.runPromise(service.getState());

      expect(state.port).toBe(occupiedPort + 1);
    } finally {
      await stopAll(service);
      void occupied.stop();
    }
  });

  test('startup fails clearly when the full port range is occupied', async () => {
    const occupied = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('occupied'),
    });
    const occupiedPort = occupied.port ?? 0;
    const service = await makeService();

    try {
      const result = await Effect.runPromise(
        Effect.either(
          service.start({
            identity: identity('peer-a'),
            portRange: { start: occupiedPort, end: occupiedPort },
          }),
        ),
      );
      const state = await Effect.runPromise(service.getState());

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') expect(result.left.reason).toBe('port-unavailable');
      expect(state.status).toBe('error');
      expect(state.lastError).toContain(`${occupiedPort}-${occupiedPort}`);
    } finally {
      await stopAll(service);
      void occupied.stop();
    }
  });

  test('starts and stops idempotently without exposing raw pairing passwords', async () => {
    const service = await makeService();

    try {
      await Effect.runPromise(service.start({ identity: identity('peer-a'), portRange: { start: 0, end: 0 } }));
      await Effect.runPromise(service.start({ identity: identity('peer-a'), portRange: { start: 0, end: 0 } }));
      const state = await Effect.runPromise(service.getState());

      await Effect.runPromise(service.startPairing({ peerId: 'peer-b', password: 'secret-password' }));
      const pairingState = await Effect.runPromise(service.getState());
      const peer = await fetch(`http://127.0.0.1:${state.port}/lan/peer`);
      const confirm = await fetch(`http://127.0.0.1:${state.port}/lan/pairing/confirm`, {
        method: 'POST',
        body: JSON.stringify({ peerId: 'peer-b', password: 'secret-password' }),
      });

      expect(pairingState.status).toBe('pairing');
      expect(JSON.stringify(pairingState)).not.toContain('secret-password');
      expect(JSON.stringify(await peer.json())).not.toContain('secret-password');
      expect(JSON.stringify(await confirm.json())).not.toContain('secret-password');

      await Effect.runPromise(service.stop());
      await Effect.runPromise(service.stop());
      expect((await Effect.runPromise(service.getState())).status).toBe('stopped');
    } finally {
      await stopAll(service);
    }
  });
});
