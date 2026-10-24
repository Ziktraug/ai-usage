import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { WorkThreadCommand, WorkThreadCommandResult } from '@ai-usage/report-core/work-thread';
import {
  classifyUsageEngineRetry,
  parseUsageEngineCommand,
  parseUsageEngineCommandCancellationResult,
  parseUsageEngineCommandCompletion,
  parseUsageEngineCommandId,
  parseUsageEngineCommandResult,
  parseUsageEngineErrorResponse,
  parseUsageEngineEvent,
  parseUsageEngineForegroundOutcome,
  parseUsageEngineMergePreviewOutput,
  parseUsageEngineProtocolVersion,
  parseUsageEngineReplayCursor,
  parseUsageEngineReplicationStatusOutput,
  parseUsageEngineStatus,
  parseUsageEngineWorkThreadOutput,
  parseWebUsageEngineCommand,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommandCompletion,
  usageEngineControlBounds,
} from './contracts';
import { fixtureGeneratedAt, fixtureInstanceId, fixtureStatus } from './test-fixtures';

const WORK_THREAD_ID = '11111111-1111-4111-8111-111111111111';
const WORK_THREAD_COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const WORK_THREAD_LINK_ID = '33333333-3333-4333-8333-333333333333';

describe('work-thread control contracts', () => {
  const create: WorkThreadCommand = {
    commandId: WORK_THREAD_COMMAND_ID,
    intent: 'change',
    links: [{ key: 'github.com/owner/repo#7', kind: 'pull-request' }],
    objective: null,
    op: 'create',
    projectLabel: 'Project',
    title: 'Follow the change',
  };
  const wait: Extract<WorkThreadCommand, { op: 'set-follow-state' }> = {
    acknowledgedRemainders: [],
    commandId: WORK_THREAD_COMMAND_ID,
    expectedRevision: 1,
    op: 'set-follow-state',
    reason: null,
    threadId: WORK_THREAD_ID,
    to: 'waiting',
    waitingFor: 'A review',
    waitingOn: {
      kind: 'pull-request-review',
      linkKey: 'github.com/owner/repo#7',
      since: parseCanonicalInstant(fixtureGeneratedAt),
    },
  };

  test('round-trips every operation through the engine and browser parsers', () => {
    const inputs: readonly WorkThreadCommand[] = [
      create,
      wait,
      {
        commandId: WORK_THREAD_COMMAND_ID,
        key: 'session:machine/claude/session',
        kind: 'session',
        op: 'link',
        threadId: WORK_THREAD_ID,
      },
      { commandId: WORK_THREAD_COMMAND_ID, linkId: WORK_THREAD_LINK_ID, op: 'detach-link', threadId: WORK_THREAD_ID },
      { commandId: WORK_THREAD_COMMAND_ID, note: 'Keep following', op: 'set-note', threadId: WORK_THREAD_ID },
      { commandId: WORK_THREAD_COMMAND_ID, op: 'rename', threadId: WORK_THREAD_ID, title: 'Renamed' },
    ];
    for (const input of inputs) {
      const command = { command: 'work-thread', input } as const;
      expect(parseUsageEngineCommand(JSON.parse(JSON.stringify(command)))).toEqual(command);
      expect(parseWebUsageEngineCommand(command)).toEqual(command);
    }
  });

  test('rejects unknown wrapper, command, link, and waiting fields and malformed inputs', () => {
    expect(() => parseUsageEngineCommand({ command: 'work-thread', input: create, extra: true })).toThrow();
    expect(() => parseUsageEngineCommand({ command: 'work-thread' })).toThrow();
    const invalidInputs = [
      { ...create, extra: true },
      { ...create, commandId: 'not-an-id' },
      { ...create, links: [{ ...create.links[0], extra: true }] },
      { ...create, links: [{ key: '/local/path', kind: 'pull-request' }] },
      { ...wait, expectedRevision: 0 },
      { ...wait, waitingOn: { ...wait.waitingOn, extra: true } },
      { ...wait, to: 'done' },
    ];
    for (const input of invalidInputs) {
      expect(() => parseUsageEngineCommand({ command: 'work-thread', input })).toThrow();
    }
  });

  test('successes, replay, and typed failures all round-trip as succeeded completions', () => {
    const results: readonly WorkThreadCommandResult[] = [
      { applied: true, followRevision: 2, ok: true, threadId: WORK_THREAD_ID },
      { applied: false, followRevision: 2, ok: true, threadId: WORK_THREAD_ID },
      { currentRevision: 2, failure: 'revision-conflict', message: 'Refresh the thread.', ok: false },
      { currentRevision: null, failure: 'not-found', message: 'Thread is missing.', ok: false },
      { currentRevision: 2, failure: 'invalid-transition', message: 'Already following.', ok: false },
      { currentRevision: 2, failure: 'invalid-link', message: 'Link is unavailable.', ok: false },
    ];
    for (const result of results) {
      const completion: UsageEngineCommandCompletion = {
        command: 'work-thread',
        commandId: parseUsageEngineCommandId(WORK_THREAD_COMMAND_ID),
        completedAt: fixtureGeneratedAt,
        output: { kind: 'work-thread', result },
        state: 'succeeded',
      };
      expect(parseUsageEngineCommandCompletion(JSON.parse(JSON.stringify(completion)))).toEqual(completion);
    }
  });

  test('rejects malformed outputs and unknown nested result fields', () => {
    const success = { applied: true, followRevision: 1, ok: true, threadId: WORK_THREAD_ID };
    const failure = { currentRevision: 1, failure: 'revision-conflict', message: 'Refresh.', ok: false };
    const results = [
      { ...success, extra: true },
      { ...success, applied: 1 },
      { ...success, followRevision: 0 },
      { ...success, followRevision: 1.5 },
      { ...success, followRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...success, threadId: 'not-an-id' },
      { ...failure, extra: true },
      { ...failure, currentRevision: 0 },
      { ...failure, currentRevision: undefined },
      { ...failure, failure: 'unknown' },
      { ...failure, message: '' },
      { ...failure, message: 'x'.repeat(usageEngineControlBounds.maxMessageBytes + 1) },
      { ...failure, ok: 'false' },
    ];
    for (const result of results) {
      expect(() => parseUsageEngineWorkThreadOutput({ kind: 'work-thread', result })).toThrow();
    }
    expect(() => parseUsageEngineWorkThreadOutput({ kind: 'work-thread', result: success, extra: true })).toThrow();
    expect(() => parseUsageEngineWorkThreadOutput({ kind: 'none', result: success })).toThrow();
    expect(() => parseUsageEngineWorkThreadOutput({ kind: 'work-thread' })).toThrow();
  });
});

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
      { command: 'replication-status' },
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
      {
        action: 'read-only-review',
        candidateId: 'declared:["machine-a","claude-code","personal"]',
        command: 'start-review-attempt',
        target: { desktopSessionId: 'local_one', harness: 'claude', sourceSessionId: 'session-a' },
      },
      {
        command: 'qualify-review-routing',
        target: { desktopSessionId: null, harness: 'claude', sourceSessionId: 'session-a' },
      },
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
    expect(Number(parseUsageEngineProtocolVersion(USAGE_ENGINE_PROTOCOL_VERSION))).toBe(3);
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

  test('parses content-free replication status and rejects inconsistent local mode', () => {
    const status = {
      kind: 'replication-status',
      lastDiagnostic: { code: 'retry-scheduled', problemCode: 'rate-limited', streamId: 'usage-v1' },
      memory: null,
      mode: 'connected',
      runtimeState: 'waiting',
      usage: {
        acknowledged: 8,
        acknowledgedThroughGeneration: 8,
        blocked: 0,
        inFlight: 0,
        lastAcknowledgedAt: fixtureGeneratedAt,
        lastErrorCode: 'rate-limited',
        nextRetryAt: fixtureGeneratedAt,
        oldestUnacknowledgedAt: fixtureGeneratedAt,
        pending: 2,
        streamId: 'usage-v1',
      },
    } as const;
    expect(parseUsageEngineReplicationStatusOutput(status) as unknown).toEqual(status);
    expect(() =>
      parseUsageEngineReplicationStatusOutput({
        ...status,
        lastDiagnostic: null,
        mode: 'local-only',
        runtimeState: 'disabled',
      }),
    ).toThrow('inconsistent');
    expect(() =>
      parseUsageEngineReplicationStatusOutput({
        ...status,
        usage: { ...status.usage, streamId: 'memory-v1' },
      }),
    ).toThrow('inconsistent');
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

  test('carries a bounded routing qualification and refuses one that does not conform (ADR 0057)', () => {
    const qualification = {
      candidates: [
        {
          accountScope: 'personal',
          actions: [],
          candidateId: 'declared:["machine-a","claude-code","personal"]',
          eligible: true,
          exclusionReasons: [],
          harness: 'claude-code',
          identity: {
            declared: '0123456789abcdef',
            observed: '0123456789abcdef',
            observedAt: '2026-10-22T08:00:00.000Z',
            state: 'confirmed',
          },
          missingData: ['Effort was not observed (optional).'],
          model: 'Opus',
        },
      ],
      chosenCandidateId: 'declared:["machine-a","claude-code","personal"]',
      executors: { outcome: 'success', refreshed: true },
      omittedCandidates: 0,
      qualifiedAt: '2026-10-22T08:00:01.000Z',
      reasons: ['Simulation only: no harness is started and no permission is granted.'],
      recommendation: { candidateId: 'declared:["machine-a","claude-code","personal"]', kind: 'real', missing: null },
    };
    const completion = {
      command: 'qualify-review-routing',
      commandId: 'command-1',
      completedAt: '2026-10-22T08:00:02.000Z',
      output: { kind: 'routing-qualification', qualification },
      state: 'succeeded',
    };
    expect(parseUsageEngineCommandCompletion(completion)).toEqual(completion as never);
    for (const output of [
      { kind: 'routing-qualification', qualification: { ...qualification, report: [] } },
      { kind: 'routing-qualification', qualification: { ...qualification, recommendation: { kind: 'maybe' } } },
      { kind: 'none' },
      { kind: 'routing-qualification', qualification, rows: [] },
    ]) {
      expect(() => parseUsageEngineCommandCompletion({ ...completion, output })).toThrow();
    }
    expect(() =>
      parseUsageEngineCommand({ command: 'qualify-review-routing', target: { harness: 'claude' } }),
    ).toThrow();
    expect(() =>
      parseUsageEngineCommand({
        candidateId: 'x',
        command: 'qualify-review-routing',
        target: { harness: 'claude', sourceSessionId: 'session-a' },
      }),
    ).toThrow();
  });

  test('carries the operator release of a held review reservation and its bounded answer (ADR 0055)', () => {
    const command = { attemptId: 'attempt-lost', command: 'release-review-reservation' };
    expect(parseUsageEngineCommand(command)).toEqual(command as never);
    expect(parseWebUsageEngineCommand(command)).toEqual(command as never);
    expect(() => parseUsageEngineCommand({ ...command, reason: 'free text' })).toThrow();
    expect(() => parseUsageEngineCommand({ command: 'release-review-reservation' })).toThrow();

    const completion = {
      command: 'release-review-reservation',
      commandId: 'command-1',
      completedAt: '2026-10-22T08:00:02.000Z',
      output: {
        attemptId: 'attempt-lost',
        evidence: 'operator-declared-ended',
        kind: 'review-reservation-release',
        pids: [],
        releasedAt: '2026-10-22T08:00:02.000Z',
        result: 'released',
      },
      state: 'succeeded',
    };
    expect(parseUsageEngineCommandCompletion(completion)).toEqual(completion as never);
    const found = {
      ...completion,
      output: { ...completion.output, evidence: null, pids: [4242], releasedAt: null, result: 'process-found' },
    };
    expect(parseUsageEngineCommandCompletion(found)).toEqual(found as never);
    for (const output of [
      { ...completion.output, result: 'maybe' },
      { ...completion.output, evidence: 'age' },
      { ...completion.output, pids: [-1] },
      { ...completion.output, rows: [] },
      { kind: 'none' },
    ]) {
      expect(() => parseUsageEngineCommandCompletion({ ...completion, output })).toThrow();
    }
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

  test('a review stop command identifies an owned attempt without claiming confirmed termination', () => {
    const command = { attemptId: 'attempt-owned', command: 'stop-review-attempt' };
    expect(parseUsageEngineCommand(command)).toEqual(command as never);
    expect(parseWebUsageEngineCommand(command)).toEqual(command as never);
    expect(() => parseUsageEngineCommand({ ...command, pid: 123 })).toThrow();
    expect(() => parseUsageEngineCommand({ command: 'stop-review-attempt' })).toThrow();
    const completion = {
      command: 'stop-review-attempt',
      commandId: 'command-stop',
      completedAt: '2026-10-22T08:00:02.000Z',
      output: { attemptId: 'attempt-owned', kind: 'review-attempt-stop', result: 'requested' },
      state: 'succeeded',
    };
    for (const result of ['requested', 'not-owned', 'already-ended']) {
      const value = { ...completion, output: { ...completion.output, result } };
      expect(parseUsageEngineCommandCompletion(value)).toEqual(value as never);
    }
    for (const output of [
      { ...completion.output, result: 'all-descendants-killed' },
      { ...completion.output, pid: 123 },
      { ...completion.output, attemptId: '' },
    ]) {
      expect(() => parseUsageEngineCommandCompletion({ ...completion, output })).toThrow();
    }
  });
});
