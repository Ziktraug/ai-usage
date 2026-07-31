import { describe, expect, test } from 'bun:test';
import {
  classifyUsageEngineRetry,
  parseUsageEngineCommand,
  parseUsageEngineCommandCancellationResult,
  parseUsageEngineCommandResult,
  parseUsageEngineErrorResponse,
  parseUsageEngineEvent,
  parseUsageEngineForegroundOutcome,
  parseUsageEngineProtocolVersion,
  parseUsageEngineStatus,
  parseWebUsageEngineCommand,
  usageEngineControlBounds,
} from './contracts';
import { fixtureGeneratedAt, fixtureInstanceId, fixtureStatus } from './test-fixtures';

describe('usage engine control contracts', () => {
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
      { command: 'collect-fresh-quota' },
      { command: 'import-cursor', input: { handoffId: 'handoff-1', kind: 'inbox-handoff' } },
      {
        command: 'preview-merge',
        input: { filePath: '/operator/merge.json', kind: 'operator-file' },
      },
      {
        command: 'confirm-merge',
        confirmationToken: 'confirmation-1',
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
    expect(Number(parseUsageEngineProtocolVersion(1))).toBe(1);
    expect(() => parseUsageEngineProtocolVersion(2)).toThrow('protocol');
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
      protocolVersion: 1,
    };
    expect(parseUsageEngineCommandResult(accepted) as unknown).toEqual(accepted);
    expect(() => parseUsageEngineCommandResult({ ...accepted, payload: { rows: [] } })).toThrow('unknown');
    const cancellation = {
      commandId: 'command-1',
      disposition: 'cancelled',
      instanceId: fixtureInstanceId,
      protocolVersion: 1,
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
          bytes: 1024,
          confirmationToken: 'confirmation-1',
          documentDigest: 'a'.repeat(64),
          kind: 'merge-preview',
          result: {
            deleted: 0,
            fleetChanged: false,
            inserted: 2,
            superseded: 0,
            unchanged: 1,
            updated: 0,
            warnings: 0,
          },
          rows: 3,
          warningCount: 0,
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
      protocolVersion: 1,
    };
    expect(parseUsageEngineErrorResponse(error) as unknown).toEqual(error);
    const stalePreview = {
      error: { code: 'preview-stale', message: 'Preview the merge file again.' },
      ok: false,
      protocolVersion: 1,
    };
    expect(parseUsageEngineErrorResponse(stalePreview) as unknown).toEqual(stalePreview);
    expect(() => parseUsageEngineErrorResponse({ ...error, detail: '/private/token' })).toThrow('unknown');
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
      protocolVersion: 1,
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
        protocolVersion: 1,
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
        protocolVersion: 1,
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
        protocolVersion: 1,
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
