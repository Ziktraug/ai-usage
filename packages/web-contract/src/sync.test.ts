import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  manualMergeDownloadTransport,
  manualMergeUploadTransport,
  parseSyncFleet,
  syncContract,
  syncFleetOutputSchema,
} from './sync';

const FORBIDDEN_RPC_VALUE_PATTERN = /text|bytes|file|stream/i;
const fleet = {
  currentMachine: { id: 'machine-a', label: 'Machine A' },
  machines: [
    {
      hasLocalObservedRows: true,
      hasPortableRows: false,
      id: 'machine-a',
      label: 'Machine A',
      lastSeenAt: '2026-08-03T00:00:00.000Z',
      newestSessionAt: null,
      sessionCount: 1,
    },
  ],
  omittedMachines: 0,
  skipped: 0,
};

describe('Sync contract', () => {
  test('defines only the bounded fleet GET procedure and exact public errors', () => {
    expect(Object.keys(syncContract)).toEqual(['fleet']);
    expect(syncContract.fleet['~orpc'].route).toEqual({ method: 'GET', path: '/sync/fleet' });
    expect(Object.keys(syncContract.fleet['~orpc'].errorMap).sort()).toEqual([
      'ForbiddenDemo',
      'IncompatibleStore',
      'Unavailable',
    ]);
  });

  test('deeply validates the closed bounded fleet wire shape', () => {
    expect(parseSyncFleet(fleet)).toEqual(fleet);
    expect(safeParse(syncFleetOutputSchema, { ...fleet, databasePath: '/private/usage.sqlite' }).success).toBe(false);
    expect(
      safeParse(syncFleetOutputSchema, {
        ...fleet,
        machines: [{ ...fleet.machines[0], lastSeenAt: 'not-a-date' }],
      }).success,
    ).toBe(false);
    expect(
      safeParse(syncFleetOutputSchema, {
        ...fleet,
        machines: [fleet.machines[0], fleet.machines[0]],
      }).success,
    ).toBe(false);
  });

  test('keeps upload and download bytes on explicit POST transports', () => {
    expect(manualMergeUploadTransport).toMatchObject({
      body: 'portable-usage-json',
      csrf: 'required',
      method: 'POST',
      path: '/api/manual-merge/upload',
      response: 'bounded-json',
    });
    expect(manualMergeDownloadTransport).toMatchObject({
      body: 'none',
      csrf: 'required',
      method: 'POST',
      path: '/api/manual-merge/download',
      response: 'attachment-portable-usage-json',
    });
    expect(JSON.stringify(syncContract)).not.toMatch(FORBIDDEN_RPC_VALUE_PATTERN);
  });

  test('rejects accessors before fleet data crosses the wire', () => {
    const value = { ...fleet } as Record<string, unknown>;
    Object.defineProperty(value, 'skipped', { enumerable: true, get: () => 0 });
    expect(safeParse(syncFleetOutputSchema, value).success).toBe(false);
  });
});
