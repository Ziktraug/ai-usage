import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { LocalHistoryStorage, createLocalHistoryStorage } from './local-history';
import {
  emptyLanPeersConfig,
  LAN_PEERS_CONFIG_FILE,
  lanPeersConfigPath,
  parseLanPeersConfig,
  readLanPeersConfig,
  upsertStoredLanPeer,
} from './lan-peers';

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

  test('reads empty config and upserts trusted peers on disk', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-lan-peers-'));
    try {
      const storage = createLocalHistoryStorage(home);
      const empty = await Effect.runPromise(readLanPeersConfig.pipe(Effect.provideService(LocalHistoryStorage, storage)));
      const first = await Effect.runPromise(
        upsertStoredLanPeer({
          machineId: 'machine-b',
          machineLabel: 'Machine B',
          pairedAt: '2026-06-19T12:00:00.000Z',
          tokenEnv: 'AI_USAGE_LAN_MERGE_MACHINE_B_TOKEN',
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );
      const second = await Effect.runPromise(
        upsertStoredLanPeer({
          machineId: 'machine-b',
          machineLabel: 'Machine B',
          pairedAt: '2026-06-19T12:30:00.000Z',
          tokenEnv: 'AI_USAGE_LAN_MERGE_MACHINE_B_TOKEN',
          lastSeenAt: '2026-06-19T12:30:00.000Z',
        }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
      );

      expect(empty).toEqual(emptyLanPeersConfig());
      expect(first.peers).toHaveLength(1);
      expect(second.peers).toHaveLength(1);
      expect(second.peers[0]?.lastSeenAt).toBe('2026-06-19T12:30:00.000Z');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
