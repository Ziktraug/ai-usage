import { describe, expect, test } from 'bun:test';
import {
  classifyUsageEngineRetry,
  parseUsageEngineCommand,
  parseUsageEngineCommandCancellationResult,
  parseUsageEngineCommandResult,
  parseUsageEngineErrorResponse,
  parseUsageEngineEvent,
  parseUsageEngineForegroundOutcome,
  parseUsageEngineMergePreviewOutput,
  parseUsageEngineProtocolVersion,
  parseUsageEngineReplayCursor,
  parseUsageEngineStatus,
  parseWebUsageEngineCommand,
  USAGE_ENGINE_PROTOCOL_VERSION,
  usageEngineControlBounds,
} from './contracts';
import { fixtureGeneratedAt, fixtureInstanceId, fixtureStatus } from './test-fixtures';

describe('usage engine control contracts', () => {
  test('parses replay identity and sequence as one cursor', () => {
    expect(parseUsageEngineReplayCursor('engine:42')).toMatchObject({
      eventId: 'engine:42',
      kind: 'engine',
      replaySequence: 42,
    });
    expect(parseUsageEngineReplayCursor('snapshot:0')).toMatchObject({ kind: 'snapshot', replaySequence: 0 });
    expect(() => parseUsageEngineReplayCursor('engine:01')).toThrow('replay cursor');
    expect(() => parseUsageEngineReplayCursor('event-42')).toThrow('replay cursor');
  });

  test('parses the complete operational command catalogue without report data', () => {
    const commands = [
      { command: 'detect-all' },
      { command: 'run-all-enabled' },
      { command: 'run-source', sourceId: 'codex.sessions' },
      { command: 'collect-fresh-report', harness: null, includeCursor: false },
      { command: 'publish' },
      { command: 'set-source-enabled', enabled: false, sourceId: 'rtk.savings' },
      { command: 'replace-project-aliases', projectAliases: [{ match: ['fixture/*'], name: 'Fixture' }] },
      { command: 'replace-project-groups', projectGroups: [] },
      {
        command: 'replace-project-groups-by-reference',
        projectGroups: [
          {
            id: 'group-1',
            name: 'Group 1',
            sources: [`project-source:${'a'.repeat(64)}`],
          },
        ],
        revision: 'revision-a',
      },
      { command: 'set-machine-label', label: 'Workstation' },
      { campaignKey: 'machine-a:codex:root-a', command: 'set-campaign-label-override', label: 'Launch' },
      { command: 'collect-fresh-quota' },
      { command: 'import-cursor', input: { handoffId: 'handoff-1', kind: 'inbox-handoff' } },
      {
        command: 'preview-merge',
        input: { filePath: '/operator/merge.json', kind: 'operator-file' },
      },
      {
        command: 'confirm-merge',
        confirmationToken: `v1.${'b'.repeat(64)}`,
        documentDigest: 'a'.repeat(64),
        input: { handoffId: 'handoff-2', kind: 'inbox-handoff' },
      },
    ] as const;

    for (const command of commands) {
      expect(parseUsageEngineCommand(command) as unknown).toEqual(command);
    }
  });

  test('rejects unknown fields, source IDs, data payloads, and over-budget UTF-8', () => {
    expect(() => parseUsageEngineCommand({ command: 'publish', unexpected: true })).toThrow('unknown');
    expect(() => parseUsageEngineCommand({ command: 'run-source', sourceId: 'other.sessions' })).toThrow('source');
    expect(() =>
      parseUsageEngineCommand({ command: 'collect-fresh-report', harness: 'other', includeCursor: true }),
    ).toThrow('harness');
    expect(() => parseUsageEngineCommand({ command: 'publish', rows: [] })).toThrow('unknown');
    expect(() =>
      parseUsageEngineCommand({
        command: 'set-machine-label',
        label: 'é'.repeat(usageEngineControlBounds.maxMessageBytes),
      }),
    ).toThrow('label');
    expect(() =>
      parseUsageEngineCommand({
        command: 'import-cursor',
        input: { handoffId: 'handoff', kind: 'inbox-handoff', path: '/private' },
      }),
    ).toThrow('unknown');
  });

  test('gives web commands a path-free parser', () => {
    expect(
      parseWebUsageEngineCommand({
        command: 'preview-merge',
        input: { handoffId: 'handoff-1', kind: 'inbox-handoff' },
      }) as unknown,
    ).toEqual({
      command: 'preview-merge',
      input: { handoffId: 'handoff-1', kind: 'inbox-handoff' },
    });
    expect(() =>
      parseWebUsageEngineCommand({
        command: 'preview-merge',
        input: { filePath: '/operator/merge.json', kind: 'operator-file' },
      }),
    ).toThrow('operator');
    expect(() =>
      parseWebUsageEngineCommand({
        command: 'replace-project-groups',
        projectGroups: [
          {
            id: 'group-1',
            name: 'Group 1',
            sources: [{ sourcePath: '/private/history' }],
          },
        ],
      }),
    ).toThrow('path');
    expect(() =>
      parseWebUsageEngineCommand({
        command: 'replace-project-aliases',
        projectAliases: [{ match: ['/private/*'], name: 'Private' }],
      }),
    ).toThrow('path');
    expect(
      parseWebUsageEngineCommand({
        command: 'replace-project-groups-by-reference',
        projectGroups: [
          {
            id: 'group-1',
            name: 'Group 1',
            sources: [`project-source:${'a'.repeat(64)}`],
          },
        ],
        revision: 'revision-a',
      }) as unknown,
    ).toEqual({
      command: 'replace-project-groups-by-reference',
      projectGroups: [
        {
          id: 'group-1',
          name: 'Group 1',
          sources: [`project-source:${'a'.repeat(64)}`],
        },
      ],
      revision: 'revision-a',
    });
    expect(() =>
      parseWebUsageEngineCommand({
        command: 'replace-project-groups-by-reference',
        projectGroups: [{ id: 'group-1', name: 'Group 1', sources: ['/private/history'] }],
        revision: 'revision-a',
      }),
    ).toThrow('reference');
    expect(
      parseWebUsageEngineCommand({
        command: 'replace-project-groups',
        projectGroups: [
          {
            id: 'group-1',
            name: 'Group 1',
            sources: [{ machineId: 'machine-1', project: 'project-1' }],
          },
        ],
      }) as unknown,
    ).toEqual({
      command: 'replace-project-groups',
      projectGroups: [
        {
          id: 'group-1',
          name: 'Group 1',
          sources: [{ machineId: 'machine-1', project: 'project-1' }],
        },
      ],
    });
  });

  test('rejects protocol mismatches and inconsistent status identities', () => {
    expect(Number(parseUsageEngineProtocolVersion(USAGE_ENGINE_PROTOCOL_VERSION))).toBe(2);
    expect(() => parseUsageEngineProtocolVersion(1)).toThrow('protocol');
    expect(parseUsageEngineStatus(fixtureStatus()) as unknown).toEqual(fixtureStatus());
    expect(() =>
      parseUsageEngineStatus({
        ...fixtureStatus(),
        sourceControl: { ...fixtureStatus().sourceControl, instanceId: 'other-instance' },
      }),
    ).toThrow('instance');
    expect(() => parseUsageEngineStatus({ ...fixtureStatus(), sessions: [] })).toThrow('unknown');
  });

  test('parses admission results, bounded completion events, and error responses', () => {
    const accepted = {
      admission: 'accepted',
      commandId: 'command-1',
      instanceId: fixtureInstanceId,
      ok: true,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    };
    expect(parseUsageEngineCommandResult(accepted) as unknown).toEqual(accepted);
    expect(() => parseUsageEngineCommandResult({ ...accepted, payload: { rows: [] } })).toThrow('unknown');
    const cancellation = {
      commandId: 'command-1',
      disposition: 'cancelled',
      instanceId: fixtureInstanceId,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    };
    expect(parseUsageEngineCommandCancellationResult(cancellation) as unknown).toEqual(cancellation);
    expect(() => parseUsageEngineCommandCancellationResult({ ...cancellation, disposition: 'deleted' })).toThrow(
      'disposition',
    );
    expect(() => parseUsageEngineCommandCancellationResult({ ...cancellation, rows: [] })).toThrow('unknown');

    const event = {
      event: 'report-published',
      eventId: 'event-1',
      instanceId: fixtureInstanceId,
      publication: {
        instanceId: fixtureInstanceId,
        publishedAt: fixtureGeneratedAt,
        revision: 'revision-1',
        sourceControlGeneration: 1,
      },
      sequence: 1,
    };
    expect(parseUsageEngineEvent(event) as unknown).toEqual(event);
    expect(() => parseUsageEngineEvent({ ...event, quotaHistory: [] })).toThrow('unknown');

    const completionEvent = {
      completion: {
        command: 'preview-merge',
        commandId: 'command-1',
        completedAt: fixtureGeneratedAt,
        output: {
          bundle: {
            generatedAt: fixtureGeneratedAt,
            machineId: 'machine-b',
            machineLabel: 'Peer MacBook',
          },
          bytes: 1024,
          confirmationToken: `v1.${'b'.repeat(64)}`,
          documentDigest: 'a'.repeat(64),
          kind: 'merge-preview',
          result: {
            deleted: 0,
            fleetChanged: false,
            inserted: 2,
            superseded: 0,
            unchanged: 1,
            updated: 0,
            warnings: 1,
          },
          rows: 3,
          warningCount: 1,
          warningItems: ['One row was skipped.'],
        },
        state: 'succeeded',
      },
      event: 'command-completed',
      eventId: 'event-2',
      instanceId: fixtureInstanceId,
      sequence: 2,
    };
    expect(parseUsageEngineEvent(completionEvent) as unknown).toEqual(completionEvent);
    expect(() =>
      parseUsageEngineEvent({
        ...completionEvent,
        completion: { ...completionEvent.completion, output: { kind: 'none' } },
      }),
    ).toThrow('preview');
    expect(() =>
      parseUsageEngineEvent({
        ...completionEvent,
        completion: {
          ...completionEvent.completion,
          output: {
            ...completionEvent.completion.output,
            result: { ...completionEvent.completion.output.result, inserted: 1 },
          },
        },
      }),
    ).toThrow('row count');
    expect(
      parseUsageEngineEvent({
        ...completionEvent,
        completion: {
          ...completionEvent.completion,
          output: {
            ...completionEvent.completion.output,
            result: { ...completionEvent.completion.output.result, warnings: 100_000 },
            warningCount: 100_000,
          },
        },
      }),
    ).toBeDefined();

    const confirmedEvent = {
      ...completionEvent,
      completion: {
        command: 'confirm-merge',
        commandId: 'command-2',
        completedAt: fixtureGeneratedAt,
        output: { kind: 'none' },
        state: 'succeeded',
      },
      eventId: 'event-3',
      sequence: 3,
    };
    expect(parseUsageEngineEvent(confirmedEvent) as unknown).toEqual(confirmedEvent);
    expect(() =>
      parseUsageEngineEvent({
        ...confirmedEvent,
        completion: { ...confirmedEvent.completion, output: { kind: 'merge-confirmed' } },
      }),
    ).toThrow('preview');

    const cursorImportEvent = {
      ...completionEvent,
      completion: {
        command: 'import-cursor',
        commandId: 'command-3',
        completedAt: fixtureGeneratedAt,
        output: { alreadyImported: false, artifactName: 'abc123-export.csv', kind: 'cursor-import' },
        state: 'succeeded',
      },
      eventId: 'event-4',
      sequence: 4,
    };
    expect(parseUsageEngineEvent(cursorImportEvent) as unknown).toEqual(cursorImportEvent);
    expect(() =>
      parseUsageEngineEvent({
        ...cursorImportEvent,
        completion: {
          ...cursorImportEvent.completion,
          output: { ...cursorImportEvent.completion.output, artifactName: '../private.csv' },
        },
      }),
    ).toThrow('artifact');

    const error = {
      error: { code: 'engine-unavailable', message: 'The engine is not running.' },
      ok: false,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    };
    expect(parseUsageEngineErrorResponse(error) as unknown).toEqual(error);
    const stalePreview = {
      error: { code: 'preview-stale', message: 'Preview the merge file again.' },
      ok: false,
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
    };
    expect(parseUsageEngineErrorResponse(stalePreview) as unknown).toEqual(stalePreview);
    expect(() => parseUsageEngineErrorResponse({ ...error, detail: '/private/token' })).toThrow('unknown');
  });

  test('carries bounded merge bundle identity and warning items into the preview output', () => {
    const preview = {
      bundle: { generatedAt: fixtureGeneratedAt, machineId: 'machine-b', machineLabel: 'Peer MacBook' },
      bytes: 1024,
      confirmationToken: `v1.${'b'.repeat(64)}`,
      documentDigest: 'a'.repeat(64),
      kind: 'merge-preview',
      result: { deleted: 0, fleetChanged: false, inserted: 2, superseded: 0, unchanged: 1, updated: 0, warnings: 2 },
      rows: 3,
      warningCount: 2,
      warningItems: ['A row was skipped.', 'x'.repeat(512)],
    };
    expect(parseUsageEngineMergePreviewOutput(preview) as unknown).toEqual(preview);

    const { bundle: _bundle, ...withoutBundle } = preview;
    expect(() => parseUsageEngineMergePreviewOutput(withoutBundle)).toThrow('missing fields');
    expect(() =>
      parseUsageEngineMergePreviewOutput({ ...preview, bundle: { ...preview.bundle, machineLabel: '' } }),
    ).toThrow('machine label');
    expect(
      parseUsageEngineMergePreviewOutput({
        ...preview,
        bundle: { ...preview.bundle, machineLabel: 'L'.repeat(121) },
      }) as unknown,
    ).toEqual({ ...preview, bundle: { ...preview.bundle, machineLabel: 'L'.repeat(121) } });
    expect(() =>
      parseUsageEngineMergePreviewOutput({
        ...preview,
        bundle: { ...preview.bundle, machineLabel: 'é'.repeat(121) },
      }),
    ).toThrow('machine label');
    expect(() =>
      parseUsageEngineMergePreviewOutput({ ...preview, bundle: { ...preview.bundle, generatedAt: 'yesterday' } }),
    ).toThrow('timestamp');
    expect(() =>
      parseUsageEngineMergePreviewOutput({
        ...preview,
        bundle: { ...preview.bundle, hostname: 'peer.local' },
      }),
    ).toThrow('missing fields');
    expect(() =>
      parseUsageEngineMergePreviewOutput({
        ...preview,
        warningItems: Array.from({ length: 21 }, () => 'A row was skipped.'),
      }),
    ).toThrow('warning items');
    expect(() => parseUsageEngineMergePreviewOutput({ ...preview, warningItems: ['x'.repeat(513)] })).toThrow(
      'warning item',
    );
    expect(() => parseUsageEngineMergePreviewOutput({ ...preview, warningItems: [{ message: 'skipped' }] })).toThrow(
      'warning item',
    );
    expect(() =>
      parseUsageEngineMergePreviewOutput({
        ...preview,
        result: { ...preview.result, warnings: 0 },
        warningCount: 0,
      }),
    ).toThrow('exceed its warning count');
  });

  test('parses bounded foreground completion and rejection outcomes without report data', () => {
    const completed = {
      completion: {
        command: 'publish',
        commandId: 'command-1',
        completedAt: fixtureGeneratedAt,
        output: {
          kind: 'publication',
          publication: { publishedAt: fixtureGeneratedAt, revision: 'revision-1' },
        },
        state: 'succeeded',
      },
      instanceId: fixtureInstanceId,
      kind: 'command-completed',
      protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
      status: fixtureStatus(),
    };
    expect(parseUsageEngineForegroundOutcome(completed) as unknown).toEqual(completed);

    const rejected = {
      kind: 'admission-rejected',
      result: {
        commandId: 'command-1',
        error: { code: 'engine-busy', message: 'The writer lock is held.' },
        instanceId: fixtureInstanceId,
        ok: false,
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
      },
    };
    expect(parseUsageEngineForegroundOutcome(rejected) as unknown).toEqual(rejected);
    expect(() => parseUsageEngineForegroundOutcome({ ...completed, rows: [{ private: true }] })).toThrow('unknown');
  });

  test('enforces serialized limits before parsing result, status, event, and error payloads', () => {
    const oversized = 'é'.repeat(usageEngineControlBounds.maxStatusEventBytes);
    expect(() =>
      parseUsageEngineCommandResult({
        admission: 'accepted',
        commandId: 'command-1',
        instanceId: fixtureInstanceId,
        ok: true,
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
        unexpected: oversized,
      }),
    ).toThrow('byte limit');
    expect(() => parseUsageEngineStatus({ ...fixtureStatus(), unexpected: oversized })).toThrow('byte limit');
    expect(() =>
      parseUsageEngineEvent({
        event: 'report-published',
        eventId: 'event-1',
        instanceId: fixtureInstanceId,
        publication: { unexpected: oversized },
        sequence: 1,
      }),
    ).toThrow('byte limit');
    expect(() =>
      parseUsageEngineErrorResponse({
        error: { code: 'engine-unavailable', message: oversized },
        ok: false,
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
      }),
    ).toThrow('byte limit');
  });

  test('classifies retries by operation without trusting server input', () => {
    expect(classifyUsageEngineRetry('transport-failed', 'command')).toBe('same-command-id');
    expect(classifyUsageEngineRetry('transport-failed', 'status')).toBe('safe-request');
    expect(classifyUsageEngineRetry('transport-failed', 'events')).toBe('reconnect');
    expect(classifyUsageEngineRetry('authentication-failed', 'events')).toBe('never');
    expect(classifyUsageEngineRetry('protocol-mismatch', 'status')).toBe('never');
    expect(classifyUsageEngineRetry('preview-stale', 'command')).toBe('never');
    expect(classifyUsageEngineRetry('merge-invalid-json', 'command')).toBe('never');
    expect(classifyUsageEngineRetry('merge-invalid-input', 'command')).toBe('never');
    expect(classifyUsageEngineRetry('merge-self-merge', 'command')).toBe('never');
    expect(classifyUsageEngineRetry('merge-store-failed', 'command')).toBe('never');
  });
});
