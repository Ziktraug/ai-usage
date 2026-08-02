import { expect, test } from 'bun:test';
import {
  type FocusedReportSupport,
  focusedRevisionFingerprint,
  projectFocusedSupport,
} from '@ai-usage/report-core/focused-report-query';
import {
  parseUsageEngineCommandCompletion,
  parseUsageEngineCommandResult,
  parseWebUsageEngineCommand,
} from '@ai-usage/usage-engine-control';
import type { UsageEngineControlClient } from '@ai-usage/usage-engine-control/client';
import type { ServedReportRevisionManifest } from '@ai-usage/usage-store/reader';
import { demoReportPayload } from '../report-data';
import { reportManifestRequestFingerprint } from '../web-report-payload';
import {
  getReportRevisionBootstrapForServer,
  getReportRevisionManifestForServer,
  saveProjectGroupsForServer,
  saveProjectGroupsFromRequestForServer,
} from './report-payload.server';
import type { UsageReadModel } from './usage-read-model.server';

const revision = 'revision-a';

const storeManifest: ServedReportRevisionManifest = {
  captureFingerprint: 'a'.repeat(64),
  expiresAt: 4000,
  generatedAt: demoReportPayload.generatedAt,
  machineFleetGeneration: 2,
  projectionBytes: 12_000,
  publishedAt: 2000,
  revision,
  rowCount: demoReportPayload.rows.length,
  rowsBytes: 10_000,
  supportBytes: 2000,
  usageStoreGeneration: 3,
};

const focusedSupport = () => {
  const { rows: _rows, tableRows: _tableRows, ...support } = demoReportPayload;
  return projectFocusedSupport(
    support as FocusedReportSupport,
    { harness: ['codex'], machine: [], truncated: false },
    { revision },
  );
};

const readModelWith = (overrides: Partial<UsageReadModel> = {}): UsageReadModel => ({
  queryRevision: () => Promise.reject(new Error('Unexpected exact revision query')),
  readCurrentBootstrap: () => Promise.resolve({ manifest: storeManifest, support: focusedSupport() }),
  readCurrentLocalProjectSources: () => Promise.resolve({ revision, sources: [] }),
  readCurrentManifest: () => Promise.resolve(storeManifest),
  readLocalMergeBundle: () => Promise.reject(new Error('Unexpected merge export read')),
  readLocalMachine: () => Promise.reject(new Error('Unexpected local machine read')),
  readSyncFleet: () => Promise.reject(new Error('Unexpected Sync fleet read')),
  ...overrides,
});

test('returns the current manifest and support bootstrap from one read-model call', async () => {
  let bootstrapReads = 0;
  let manifestReads = 0;
  const result = await getReportRevisionBootstrapForServer(
    readModelWith({
      readCurrentBootstrap: () => {
        bootstrapReads += 1;
        return Promise.resolve({ manifest: storeManifest, support: focusedSupport() });
      },
      readCurrentManifest: () => {
        manifestReads += 1;
        return Promise.resolve(storeManifest);
      },
    }),
  );

  expect({ bootstrapReads, manifestReads }).toEqual({ bootstrapReads: 1, manifestReads: 0 });
  expect(result).toMatchObject({
    bootstrap: {
      requestFingerprint: focusedRevisionFingerprint('support', { revision }),
      revision,
    },
    manifest: {
      captureFingerprint: storeManifest.captureFingerprint,
      expiresAt: storeManifest.expiresAt,
      generatedAt: storeManifest.generatedAt,
      publishedAt: storeManifest.publishedAt,
      revision,
      rowsBytes: storeManifest.rowsBytes,
      supportBytes: storeManifest.supportBytes,
    },
    ok: true,
    requestFingerprint: reportManifestRequestFingerprint,
  });
});

test('reads a manifest without contacting the engine or requesting publication', async () => {
  let manifestReads = 0;
  const result = await getReportRevisionManifestForServer(
    readModelWith({
      readCurrentManifest: () => {
        manifestReads += 1;
        return Promise.resolve(storeManifest);
      },
    }),
  );

  expect(manifestReads).toBe(1);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('Expected the current revision manifest.');
  }
  expect(String(result.manifest.revision)).toBe(revision);
});

test('uses the mode-aware read-model resolver when no direct model is injected', async () => {
  let resolutions = 0;

  const result = await getReportRevisionManifestForServer(undefined, () => {
    resolutions += 1;
    return Promise.resolve(readModelWith());
  });

  expect(resolutions).toBe(1);
  expect(result).toMatchObject({ manifest: { revision }, ok: true });
});

test('returns a stable unavailable result when the read-only store cannot be opened', async () => {
  const unavailable = readModelWith({
    readCurrentBootstrap: () => Promise.reject({ reason: 'store-missing' }),
    readCurrentManifest: () => Promise.reject({ reason: 'store-missing' }),
  });

  expect(await getReportRevisionBootstrapForServer(unavailable)).toEqual({
    error: { message: 'Report data is unavailable.', tag: 'RevisionUnavailable' },
    ok: false,
    requestFingerprint: reportManifestRequestFingerprint,
  });
  expect(await getReportRevisionManifestForServer(unavailable)).toEqual({
    error: { message: 'Report data is unavailable.', tag: 'RevisionUnavailable' },
    ok: false,
    requestFingerprint: reportManifestRequestFingerprint,
  });
});

test('forwards only an opaque revision-keyed project group command to the engine', async () => {
  const command = parseWebUsageEngineCommand({
    command: 'replace-project-groups-by-reference',
    projectGroups: [
      {
        id: 'group-a',
        name: 'Group A',
        sources: [`project-source:${'a'.repeat(64)}`],
      },
    ],
    revision,
  });
  if (command.command !== 'replace-project-groups-by-reference') {
    throw new Error('Expected a project group reference command fixture.');
  }
  let received: unknown;
  const control: UsageEngineControlClient = {
    cancelCommand: () => Promise.reject(new Error('Unexpected command cancellation')),
    changes: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('Unexpected event subscription')),
      }),
    }),
    execute: (value) => {
      received = value;
      return Promise.resolve(
        parseUsageEngineCommandResult({
          admission: 'accepted',
          commandId: 'command-a',
          instanceId: 'instance-a',
          ok: true,
          protocolVersion: 1,
        }),
      );
    },
    getStatus: () => Promise.reject(new Error('Unexpected status read')),
  };

  expect(
    await saveProjectGroupsForServer(command, control, (_control, value) => {
      received = value;
      return Promise.resolve(
        parseUsageEngineCommandCompletion({
          command: 'replace-project-groups-by-reference',
          commandId: 'command-a',
          completedAt: '2026-07-30T10:00:00.000Z',
          output: { kind: 'none' },
          state: 'succeeded',
        }),
      );
    }),
  ).toEqual({ accepted: true });
  expect(received).toEqual(command);
  expect(JSON.stringify(received)).not.toContain('/');
});

test('rejects project group mutations from an untrusted Host before engine admission', async () => {
  const command = parseWebUsageEngineCommand({
    command: 'replace-project-groups-by-reference',
    projectGroups: [],
    revision,
  });
  if (command.command !== 'replace-project-groups-by-reference') {
    throw new Error('Expected a project group reference command fixture.');
  }
  let admissions = 0;
  const control: UsageEngineControlClient = {
    cancelCommand: () => Promise.reject(new Error('Unexpected command cancellation')),
    changes: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('Unexpected event subscription')),
      }),
    }),
    execute: () => {
      admissions += 1;
      return Promise.reject(new Error('Unexpected command admission'));
    },
    getStatus: () => Promise.reject(new Error('Unexpected status read')),
  };

  try {
    await saveProjectGroupsFromRequestForServer(
      new Request('http://attacker.example/_serverFn/saveProjectGroups', {
        headers: { host: 'attacker.example' },
        method: 'POST',
      }),
      command,
      control,
    );
    throw new Error('Expected an untrusted Host rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    expect(error instanceof Response ? error.status : 0).toBe(403);
  }
  expect(admissions).toBe(0);
});

test('propagates an aborted project group request before engine admission', async () => {
  const command = parseWebUsageEngineCommand({
    command: 'replace-project-groups-by-reference',
    projectGroups: [],
    revision,
  });
  if (command.command !== 'replace-project-groups-by-reference') {
    throw new Error('Expected a project group reference command fixture.');
  }
  let controlCalls = 0;
  const control: UsageEngineControlClient = {
    cancelCommand: () => Promise.reject(new Error('Unexpected command cancellation')),
    changes: () => {
      controlCalls += 1;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('Unexpected event subscription')),
        }),
      };
    },
    execute: () => {
      controlCalls += 1;
      return Promise.reject(new Error('Unexpected command admission'));
    },
    getStatus: () => {
      controlCalls += 1;
      return Promise.reject(new Error('Unexpected status read'));
    },
  };
  const abort = new AbortController();
  abort.abort();
  const request = new Request('http://localhost:3000/_serverFn/saveProjectGroups', {
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
    method: 'POST',
    signal: abort.signal,
  });

  await expect(saveProjectGroupsFromRequestForServer(request, command, control)).rejects.toMatchObject({
    code: 'aborted',
  });
  expect(controlCalls).toBe(0);
});
