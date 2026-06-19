import { describe, expect, test } from 'bun:test';
import { LAN_PAIRING_PORT_RANGE, LanPairingError, type LanPeerIdentity } from './index';

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
});
