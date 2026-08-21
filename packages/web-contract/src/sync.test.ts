import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  MAX_MACHINE_LABEL_BYTES,
  manualMergeDownloadTransport,
  manualMergeUploadTransport,
  parseSyncFleet,
  parseSyncMachineLabelResult,
  syncContract,
  syncFleetOutputSchema,
  syncMachineLabelInputSchema,
  syncMachineLabelOutputSchema,
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
  test('defines only the bounded fleet read and machine rename with exact public errors', () => {
    expect(Object.keys(syncContract)).toEqual(['fleet', 'setMachineLabel']);
    expect(syncContract.fleet['~orpc'].route).toEqual({ method: 'GET', path: '/sync/fleet' });
    expect(Object.keys(syncContract.fleet['~orpc'].errorMap).sort()).toEqual([
      'ForbiddenDemo',
      'IncompatibleStore',
      'Unavailable',
    ]);
    expect(syncContract.setMachineLabel['~orpc'].route).toEqual({ method: 'POST', path: '/sync/setMachineLabel' });
    expect(Object.keys(syncContract.setMachineLabel['~orpc'].errorMap).sort()).toEqual([
      'EngineUnavailable',
      'Forbidden',
      'ForbiddenDemo',
      'InvalidInput',
    ]);
  });

  test('bounds the machine label by the engine byte limit and closes both wire shapes', () => {
    expect(safeParse(syncMachineLabelInputSchema, { label: 'Studio Mac' }).success).toBe(true);
    expect(safeParse(syncMachineLabelInputSchema, { label: '   ' }).success).toBe(false);
    expect(safeParse(syncMachineLabelInputSchema, { label: 'x'.repeat(MAX_MACHINE_LABEL_BYTES) }).success).toBe(true);
    expect(safeParse(syncMachineLabelInputSchema, { label: 'x'.repeat(MAX_MACHINE_LABEL_BYTES + 1) }).success).toBe(
      false,
    );
    // Two-byte characters reach the engine's byte bound at half the character count.
    expect(safeParse(syncMachineLabelInputSchema, { label: 'é'.repeat(120) }).success).toBe(true);
    expect(safeParse(syncMachineLabelInputSchema, { label: 'é'.repeat(121) }).success).toBe(false);
    expect(safeParse(syncMachineLabelInputSchema, { label: 'ok', machineId: 'machine-b' }).success).toBe(false);

    expect(parseSyncMachineLabelResult({ machine: { id: 'machine-a', label: 'Studio Mac' } })).toEqual({
      machine: { id: 'machine-a', label: 'Studio Mac' },
    });
    expect(
      safeParse(syncMachineLabelOutputSchema, {
        machine: { configPath: '/private/machine.json', id: 'machine-a', label: 'Studio Mac' },
      }).success,
    ).toBe(false);
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
      abort: 'request-signal-with-late-staging-cleanup',
      body: 'portable-usage-json',
      csrf: 'required',
      method: 'POST',
      path: '/api/manual-merge/upload',
      response: 'bounded-json',
    });
    expect(manualMergeDownloadTransport).toMatchObject({
      abort: 'request-signal',
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
