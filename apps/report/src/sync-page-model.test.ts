import type { SyncState } from '@ai-usage/sync';
import { describe, expect, test } from 'bun:test';
import {
  buildSyncSummary,
  enabledStatusLabel,
  formatSyncDateTime,
  remoteMachineLabel,
  tokenStatusLabel,
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
});
