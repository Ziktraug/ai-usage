import { describe, expect, test } from 'bun:test';
import type { DiscoveredLanPeer } from '@ai-usage/lan-pairing';
import type { LanMergeState } from '@ai-usage/usage-merge';
import {
  buildLanMergeSummary,
  formatSyncDateTime,
  lanDiscoveredPeerStatusLabel,
  lanMergeErrorHint,
  lanMergeServiceStatusLabel,
  lanPrimaryPeerDetails,
  lanTrustedPeerStatusLabel,
  mergeBundleUrlForLanPeer,
} from './sync-page-model';

const MERIDIEM_PATTERN = /\b[AP]M\b/;

const lanState: LanMergeState = {
  localMachine: { id: 'local-1', label: 'Local Workstation' },
  service: { status: 'stopped', urls: ['http://192.168.1.10:3847/lan/merge-bundle'] },
  discoveredPeers: [
    {
      identity: { id: 'peer-1', label: 'MacBook', protocol: 'ai-usage-lan-merge', version: 1 },
      host: '192.168.1.20',
      port: 3847,
      online: true,
      pairingAvailable: true,
      self: false,
      lastSeenAt: '2026-06-19T09:00:00.000Z',
    },
  ],
  trustedPeers: [
    {
      machineId: 'peer-1',
      machineLabel: 'MacBook',
      tokenEnv: 'AI_USAGE_LAN_MERGE_MACBOOK_TOKEN',
      pairedAt: '2026-06-19T08:00:00.000Z',
      online: true,
      paired: true,
      lastMergedAt: '2026-06-19T08:30:00.000Z',
      rows: 12,
      warnings: 1,
    },
  ],
};

describe('LAN merge sync page model', () => {
  test('summarizes LAN merge state for the primary machine list', () => {
    expect(buildLanMergeSummary(lanState)).toEqual({
      trustedMachines: 1,
      onlineMachines: 1,
      discoveredMachines: 1,
      warningCount: 1,
    });
  });

  test('labels LAN merge statuses and recovery actions', () => {
    expect(lanMergeServiceStatusLabel('stopped')).toBe('Stopped');
    expect(lanMergeServiceStatusLabel('running')).toBe('Online');
    expect(lanMergeServiceStatusLabel('error')).toBe('Needs attention');
    expect(lanTrustedPeerStatusLabel(lanState.trustedPeers[0]!)).toBe('Available');
    expect(lanDiscoveredPeerStatusLabel(lanState.discoveredPeers[0]!)).toBe('Ready to pair');
    expect(lanMergeErrorHint({ tag: 'UsageMergeError', message: 'Missing token', reason: 'missing-token' })).toContain(
      'Pair this machine again',
    );
  });

  test('keeps primary LAN machine details free of tokens and URLs', () => {
    const details = lanPrimaryPeerDetails(lanState.trustedPeers[0]!);
    expect(details.join(' ')).not.toContain('AI_USAGE');
    expect(details.join(' ')).not.toContain('http://');
    expect(details).toContain('12 rows');
    expect(details).toContain('1 warnings');
  });

  test('builds diagnostics-only merge bundle URLs from discovered peers', () => {
    const peer: DiscoveredLanPeer = lanState.discoveredPeers[0]!;
    expect(mergeBundleUrlForLanPeer(peer)).toBe('http://192.168.1.20:3847/lan/merge-bundle');
  });

  test('keeps invalid and missing dates readable', () => {
    expect(formatSyncDateTime(undefined)).toBe('Never');
    expect(formatSyncDateTime('not-a-date')).toBe('not-a-date');
  });

  test('formats sync timestamps with a 24-hour clock', () => {
    const afternoon = new Date(2026, 5, 19, 13, 30).toISOString();
    const midnight = new Date(2026, 5, 19, 0, 5).toISOString();

    expect(formatSyncDateTime(afternoon)).toContain('13:30');
    expect(formatSyncDateTime(afternoon)).not.toMatch(MERIDIEM_PATTERN);
    expect(formatSyncDateTime(midnight)).toContain('00:05');
  });
});
