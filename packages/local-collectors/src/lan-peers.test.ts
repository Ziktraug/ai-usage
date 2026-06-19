import { describe, expect, test } from 'bun:test';
import { emptyLanPeersConfig, LAN_PEERS_CONFIG_FILE, lanPeersConfigPath, parseLanPeersConfig } from './lan-peers';

describe('LAN peer config boundary', () => {
  test('owns the lan-peers.json path under the ai-usage user config directory', () => {
    expect(lanPeersConfigPath({ home: '/home/test' })).toBe(`/home/test/.config/ai-usage/${LAN_PEERS_CONFIG_FILE}`);
  });

  test('parses trusted peer records', () => {
    const config = parseLanPeersConfig(
      JSON.stringify({
        version: 1,
        peers: [
          {
            machineId: 'machine-b',
            machineLabel: 'Machine B',
            pairedAt: '2026-06-19T12:00:00.000Z',
            tokenEnv: 'AI_USAGE_PEER_MACHINE_B_TOKEN',
          },
        ],
      }),
    );

    expect(config.peers[0]?.machineId).toBe('machine-b');
  });

  test('rejects invalid trusted peer records', () => {
    expect(() => parseLanPeersConfig(JSON.stringify({ version: 1, peers: [{ machineId: 'missing-token' }] }))).toThrow(
      'invalid peers',
    );
    expect(emptyLanPeersConfig()).toEqual({ version: 1, peers: [] });
  });
});
