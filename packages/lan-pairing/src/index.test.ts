import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import {
  LAN_PAIRING_PORT_RANGE,
  LanPairingError,
  makeLanPairingService,
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
