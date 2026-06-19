import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createUsageMergePairingEnvelope,
  decodeUsageMergeCredential,
  encodeUsageMergeCredential,
  lanIdentityFromMachine,
  storedLanPeerFromPairingEnvelope,
  upsertUsageMergeEnvToken,
  usageMergeTokenEnvNameForMachine,
  UsageMergeError,
  USAGE_MERGE_PROTOCOL,
  USAGE_MERGE_PROTOCOL_VERSION,
} from './index';

describe('usage-merge public boundary', () => {
  test('adapts ai-usage machines into generic LAN identities', () => {
    expect(lanIdentityFromMachine({ id: 'machine-a', label: 'Machine A' })).toEqual({
      id: 'machine-a',
      label: 'Machine A',
      protocol: USAGE_MERGE_PROTOCOL,
      version: USAGE_MERGE_PROTOCOL_VERSION,
    });
  });

  test('uses a typed public error', () => {
    const error = new UsageMergeError({
      message: 'Cannot merge this machine into itself',
      operation: 'mergePeer',
      reason: 'self-merge',
    });

    expect(error._tag).toBe('UsageMergeError');
  });

  test('encodes ai-usage merge credentials into generic pairing envelopes', () => {
    const machine = { id: 'machine-a', label: 'Machine A' };
    const tokenEnv = usageMergeTokenEnvNameForMachine(machine);
    const token = 'secret-token';
    const envelope = createUsageMergePairingEnvelope({ machine, tokenEnv, token });
    const decoded = decodeUsageMergeCredential(envelope.credential);

    expect(tokenEnv).toBe('AI_USAGE_LAN_MERGE_MACHINE_A_TOKEN');
    expect(envelope.peerId).toBe(machine.id);
    expect(envelope.metadata.protocol).toBe(USAGE_MERGE_PROTOCOL);
    expect(decoded).toEqual({ version: 1, tokenEnv, token });
    expect(JSON.stringify(envelope)).not.toContain('secret-token');
  });

  test('creates stored trusted peer records from pairing envelopes', () => {
    const machine = { id: 'machine-b', label: 'Machine B' };
    const identity = lanIdentityFromMachine(machine);
    const envelope = createUsageMergePairingEnvelope({
      machine,
      tokenEnv: usageMergeTokenEnvNameForMachine(machine),
      token: 'secret-token',
    });

    const peer = storedLanPeerFromPairingEnvelope({
      identity,
      envelope,
      pairedAt: new Date('2026-06-19T12:00:00.000Z'),
    });

    expect(peer).toEqual({
      machineId: 'machine-b',
      machineLabel: 'Machine B',
      tokenEnv: 'AI_USAGE_LAN_MERGE_MACHINE_B_TOKEN',
      pairedAt: '2026-06-19T12:00:00.000Z',
      lastSeenAt: '2026-06-19T12:00:00.000Z',
    });
    expect(() => storedLanPeerFromPairingEnvelope({ identity: lanIdentityFromMachine({ id: 'other', label: 'Other' }), envelope, pairedAt: new Date() })).toThrow();
    expect(() => decodeUsageMergeCredential(encodeUsageMergeCredential({ tokenEnv: 'BAD-NAME', token: 'secret' }))).toThrow();
  });

  test('upserts usage merge tokens in the workspace root env file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ai-usage-merge-env-'));
    try {
      const appCwd = path.join(root, 'apps', 'web');
      mkdirSync(appCwd, { recursive: true });
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
      writeFileSync(path.join(root, '.env'), 'AI_USAGE_LAN_MERGE_MACHINE_A_TOKEN=old\nOTHER=value\n');

      const first = upsertUsageMergeEnvToken('AI_USAGE_LAN_MERGE_MACHINE_A_TOKEN', 'new', appCwd);
      const second = upsertUsageMergeEnvToken('AI_USAGE_LAN_MERGE_MACHINE_B_TOKEN', 'secret', appCwd);

      expect(first.path).toBe(path.join(root, '.env'));
      expect(second.path).toBe(path.join(root, '.env'));
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
        'AI_USAGE_LAN_MERGE_MACHINE_A_TOKEN=new\nOTHER=value\nAI_USAGE_LAN_MERGE_MACHINE_B_TOKEN=secret\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
