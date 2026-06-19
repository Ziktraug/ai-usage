import type { SyncState } from '@ai-usage/sync';
import type { DiscoveredLanPeer } from '@ai-usage/lan-pairing';
import type { LanMergeState } from '@ai-usage/usage-merge';
import { describe, expect, test } from 'bun:test';
import {
  buildLanMergeSummary,
  buildSyncSummary,
  enabledStatusLabel,
  formatSyncDateTime,
  lanDiscoveredPeerStatusLabel,
  lanMergeErrorHint,
  lanMergeServiceStatusLabel,
  lanPrimaryPeerDetails,
  lanTrustedPeerStatusLabel,
  mergeBundleUrlForLanPeer,
  remoteMachineLabel,
  discoveryBadgesForPeer,
  remoteDraftFromDiscoveredPeer,
  serveStatusLabel,
  syncServeErrorHint,
  syncOperationErrorHint,
  tokenStatusLabel,
  validateServeStartInput,
} from './sync-page-model';

const state: SyncState = {
  localMachine: { id: 'local-1', label: 'Local Workstation' },
  remotes: [
    {
      name: 'macbook',
      url: 'http://macbook.local:3847/snapshot',
      enabled: true,
      tokenStatus: 'present',
      tokenEnv: 'AI_USAGE_SYNC_TOKEN',
      machineLabel: 'MacBook',
      machineId: 'machine-1',
      rows: 12,
      fetchedAt: '2026-06-19T08:30:00.000Z',
    },
    {
      name: 'desktop',
      url: 'http://desktop.local:3847/snapshot',
      enabled: false,
      tokenStatus: 'missing',
      tokenEnv: 'AI_USAGE_DESKTOP_TOKEN',
      rows: 0,
    },
  ],
  storedSnapshots: [
    {
      remoteName: 'macbook',
      remoteUrl: 'http://macbook.local:3847/snapshot',
      fetchedAt: '2026-06-19T08:30:00.000Z',
      machineId: 'machine-1',
      machineLabel: 'MacBook',
      rows: 12,
    },
  ],
  warnings: [{ operation: 'readSyncedSnapshotRecords', message: 'Skipped unreadable snapshot' }],
};

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

describe('sync page model', () => {
  test('summarizes sync state for read-only cards', () => {
    expect(buildSyncSummary(state)).toEqual({
      configuredRemotes: 2,
      enabledRemotes: 1,
      missingTokens: 1,
      storedSnapshots: 1,
      warningCount: 1,
    });
  });

  test('formats compact remote labels', () => {
    expect(tokenStatusLabel('present')).toBe('Env present');
    expect(tokenStatusLabel('missing')).toBe('Missing env');
    expect(tokenStatusLabel('none')).toBe('No token');
    expect(enabledStatusLabel(state.remotes[0]!)).toBe('Enabled');
    expect(enabledStatusLabel(state.remotes[1]!)).toBe('Disabled');
    expect(remoteMachineLabel(state.remotes[0]!)).toBe('MacBook');
    expect(remoteMachineLabel(state.remotes[1]!)).toBe('Not pulled yet');
  });

  test('keeps invalid and missing dates readable', () => {
    expect(formatSyncDateTime(undefined)).toBe('Never');
    expect(formatSyncDateTime('not-a-date')).toBe('not-a-date');
  });

  test('maps known operation errors to recovery hints', () => {
    expect(syncOperationErrorHint({ tag: 'SyncWorkflowError', message: 'Missing token', reason: 'missing-token' })).toContain(
      'token environment variable',
    );
    expect(syncOperationErrorHint({ tag: 'SyncWorkflowError', message: 'Self sync', reason: 'self-sync' })).toContain(
      'local machine',
    );
    expect(syncOperationErrorHint({ tag: 'SyncTransportError', message: 'fetch failed' })).toContain('host');
  });

  test('maps discovered peers to add-remote form defaults and badges', () => {
    const peer = {
      host: '192.168.1.20',
      healthUrl: 'http://192.168.1.20:3847/health',
      snapshotUrl: 'http://192.168.1.20:3847/snapshot',
      machineId: 'remote-1',
      machineLabel: 'Nathans MacBook Pro',
      self: true,
      alreadyConfigured: true,
      lastSeenAt: '2026-06-19T09:00:00.000Z',
    };

    expect(remoteDraftFromDiscoveredPeer(peer)).toEqual({
      name: 'nathans-macbook-pro',
      url: 'http://192.168.1.20:3847/snapshot',
      tokenEnv: '',
    });
    expect(discoveryBadgesForPeer(peer)).toEqual(['self', 'configured']);
  });

  test('labels and validates serve state inputs', () => {
    expect(serveStatusLabel('running')).toBe('Serving');
    expect(validateServeStartInput({ host: '0.0.0.0', port: 3847, token: '' })).toContain('token');
    expect(validateServeStartInput({ host: '127.0.0.1', port: 3847, token: '' })).toBeNull();
    expect(validateServeStartInput({ host: '127.0.0.1', port: 70_000, token: '' })).toContain('Port');
    expect(syncServeErrorHint({ message: 'listen EADDRINUSE: address already in use 0.0.0.0:3847' })).toContain(
      'Port is already used',
    );
  });

  test('summarizes LAN merge state for the primary machine list', () => {
    expect(buildLanMergeSummary(lanState)).toEqual({
      trustedMachines: 1,
      onlineMachines: 1,
      discoveredMachines: 1,
      warningCount: 1,
    });
  });

  test('labels LAN merge statuses and recovery actions', () => {
    expect(lanMergeServiceStatusLabel('stopped')).toBe('Ready');
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
});
