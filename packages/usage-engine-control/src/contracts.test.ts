import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { WorkThreadCommand, WorkThreadCommandResult } from '@ai-usage/report-core/work-thread';
import {
  boundUsageEngineDelegationConfigIssues,
  boundUsageEngineReviewMessage,
  classifyUsageEngineRetry,
  parseUsageEngineCommand,
  parseUsageEngineCommandCancellationResult,
  parseUsageEngineCommandCompletion,
  parseUsageEngineCommandId,
  parseUsageEngineCommandResult,
  parseUsageEngineDelegationConfigOutput,
  parseUsageEngineDelegationStartOutput,
  parseUsageEngineErrorResponse,
  parseUsageEngineEvent,
  parseUsageEngineForegroundOutcome,
  parseUsageEngineMergePreviewOutput,
  parseUsageEngineProjectGroupReferenceCommand,
  parseUsageEngineProtocolVersion,
  parseUsageEngineReplayCursor,
  parseUsageEngineReviewAttemptOutput,
  parseUsageEngineStatus,
  parseUsageEngineWorkThreadOutput,
  parseWebUsageEngineCommand,
  USAGE_ENGINE_PROTOCOL_VERSION,
  type UsageEngineCommandCompletion,
  UsageEngineContractError,
  usageEngineControlBounds,
  usageEngineMaxReviewMessageBytes,
} from './contracts';
import { fixtureGeneratedAt, fixtureInstanceId, fixtureStatus } from './test-fixtures';

const WORK_THREAD_ID = '11111111-1111-4111-8111-111111111111';
const WORK_THREAD_COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const WORK_THREAD_LINK_ID = '33333333-3333-4333-8333-333333333333';

describe('narrow project group reference command parser', () => {
  const reference = `project-source:${'a'.repeat(64)}`;
  const group = { id: 'group-a', name: 'Group A', sources: [reference] };
  const command = { command: 'replace-project-groups-by-reference', projectGroups: [group], revision: 'revision-a' };

  test.each([
    { ...command, projectGroups: [] },
    command,
    { ...command, projectGroups: [{ ...group, sources: [reference, `project-source:${'b'.repeat(64)}`] }] },
    { ...command, projectGroups: [{ ...group, name: 'é'.repeat(usageEngineControlBounds.maxMessageBytes / 2) }] },
  ])('accepts and preserves the same reference command as the general parsers: %j', (input) => {
    expect(parseUsageEngineProjectGroupReferenceCommand(input) as unknown).toEqual(input);
    expect(parseUsageEngineProjectGroupReferenceCommand(input) as unknown).toEqual(parseUsageEngineCommand(input));
    expect(parseUsageEngineProjectGroupReferenceCommand(input) as unknown).toEqual(parseWebUsageEngineCommand(input));
  });

  test.each([
    { ...command, extra: true },
    { command: command.command, projectGroups: command.projectGroups },
    { ...command, projectGroups: null },
    { ...command, projectGroups: Array.from({ length: usageEngineControlBounds.maxProjectGroups + 1 }, () => group) },
    { ...command, projectGroups: [group, group] },
    { ...command, projectGroups: [{ ...group, extra: true }] },
    { ...command, projectGroups: [{ id: group.id, name: group.name }] },
    { ...command, projectGroups: [{ ...group, id: '' }] },
    { ...command, projectGroups: [{ ...group, name: '' }] },
    { ...command, projectGroups: [{ ...group, name: 'é'.repeat(usageEngineControlBounds.maxMessageBytes / 2 + 1) }] },
    { ...command, projectGroups: [{ ...group, sources: [] }] },
    { ...command, projectGroups: [{ ...group, sources: [reference, reference] }] },
    { ...command, projectGroups: [{ ...group, sources: ['/private/worktree'] }] },
    { ...command, projectGroups: [{ ...group, sources: [`project-source:${'A'.repeat(64)}`] }] },
    { ...command, projectGroups: [{ ...group, sources: [`project-source:${'a'.repeat(63)}`] }] },
    { ...command, revision: '' },
    { ...command, revision: null },
    { ...command, revision: 'revision with spaces' },
    { ...command, revision: 'x'.repeat(usageEngineControlBounds.maxCommandBytes) },
  ])('rejects malformed reference commands with the same typed failure: %j', (input) => {
    expect(() => parseUsageEngineProjectGroupReferenceCommand(input)).toThrow(UsageEngineContractError);
    let generalError: unknown;
    try {
      parseUsageEngineCommand(input);
    } catch (error) {
      generalError = error;
    }
    expect(generalError).toBeInstanceOf(UsageEngineContractError);
    expect(() => parseUsageEngineProjectGroupReferenceCommand(input)).toThrow(
      generalError instanceof Error ? generalError.message : 'Expected general parser rejection',
    );
    expect(() => parseWebUsageEngineCommand(input)).toThrow(UsageEngineContractError);
  });

  test.each([null, [], undefined, 7, 'publish', {}, { command: 7 }].map((input) => ({ input })))(
    'rejects a non-command envelope: %j',
    ({ input }) => {
      expect(() => parseUsageEngineProjectGroupReferenceCommand(input)).toThrow(UsageEngineContractError);
    },
  );

  test.each(['publish', 'detect-all', 'run-all-enabled', 'collect-fresh-quota'])(
    'rejects the otherwise valid unrelated %s command',
    (kind) => {
      const unrelated = { command: kind };
      expect(parseUsageEngineCommand(unrelated)).toEqual(unrelated);
      expect(() => parseUsageEngineProjectGroupReferenceCommand(unrelated)).toThrow('command kind is invalid');
    },
  );

  test('rejects cyclic and oversized envelopes before reading their fields', () => {
    const cyclic: Record<string, unknown> = { ...command };
    cyclic.extra = cyclic;
    expect(() => parseUsageEngineProjectGroupReferenceCommand(cyclic)).toThrow('not serializable');
    expect(() =>
      parseUsageEngineProjectGroupReferenceCommand({
        ...command,
        extra: 'x'.repeat(usageEngineControlBounds.maxCommandBytes),
      }),
    ).toThrow('exceeds its byte limit');
  });
});

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
      {
        command: 'qualify-delegation',
        purpose: 'simulation',
        request: { action: 'read-only-review', checkout: { path: '/home/operator/src/project' }, schemaVersion: 1 },
      },
      {
        command: 'start-delegation',
        idempotencyKey: 'claude-code:session-a:1',
        request: { action: 'read-only-review', schemaVersion: 1 },
        selection: { kind: 'abstain', qualificationId: '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5' },
      },
      { command: 'cancel-delegation', jobId: '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5' },
      {
        author: 'calling-model',
        authorLabel: 'claude-code',
        command: 'record-delegation-evaluation',
        evaluation: { kind: 'verification', verdict: 'confirmed' },
        jobId: '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5',
      },
      {
        command: 'update-delegation-config',
        delegation: { defaults: { reservePercent: 25 } },
        expectedRevision: '0123456789abcdef',
      },
      {
        command: 'update-delegation-config',
        executors: [{ harness: 'claude-code' }],
        expectedRevision: '0123456789abcdef',
        reviewTargets: [{ checkoutPath: '/home/operator/src' }],
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

  test('rejects the removed replication-status command and its completion', () => {
    expect(() => parseUsageEngineCommand({ command: 'replication-status' })).toThrow('command kind is unknown');
    expect(() =>
      parseUsageEngineCommandCompletion({
        command: 'replication-status',
        commandId: 'command-1',
        completedAt: fixtureGeneratedAt,
        output: {
          kind: 'replication-status',
          lastDiagnostic: null,
          memory: null,
          mode: 'local-only',
          runtimeState: 'disabled',
          usage: null,
        },
        state: 'succeeded',
      }),
    ).toThrow('completion command kind is unknown');
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
    expect(Number(parseUsageEngineProtocolVersion(USAGE_ENGINE_PROTOCOL_VERSION))).toBe(4);
    expect(() => parseUsageEngineProtocolVersion(1)).toThrow('protocol');
    // Protocol 3 still offered `replication-status`; a protocol-3 peer fails closed.
    expect(() => parseUsageEngineProtocolVersion(3)).toThrow('protocol');
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

  test('carries the common review policy refusals of a legacy review attempt (PR #73 F1)', () => {
    const completion = {
      command: 'start-review-attempt',
      commandId: 'command-1',
      completedAt: '2026-10-25T08:00:02.000Z',
      output: {
        attempt: { attemptId: 'attempt-refused', reused: false, state: 'refused' },
        kind: 'review-attempt',
        refusal: {
          message: 'The delegation policy does not admit route r: Forbidden by rule no-acme',
          reason: 'policy-refused',
        },
      },
      state: 'succeeded',
    };
    for (const reason of ['policy-refused', 'scope-unavailable', 'target-reserved', 'pool-busy']) {
      const refused = {
        ...completion,
        output: { ...completion.output, refusal: { ...completion.output.refusal, reason } },
      };
      expect(parseUsageEngineCommandCompletion(refused)).toEqual(refused as never);
    }
    expect(() =>
      parseUsageEngineCommandCompletion({
        ...completion,
        output: { ...completion.output, refusal: { ...completion.output.refusal, reason: 'rule-said-no' } },
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

  test('carries the delegation commands as bounded objects and keeps the start out of the web (ADR 0077)', () => {
    const request = { action: 'read-only-review', checkout: { path: '/home/operator/src/project' }, schemaVersion: 1 };
    const selection = { kind: 'choice', qualificationId: '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5', routeId: 'r' };
    const qualify = { command: 'qualify-delegation', purpose: 'delegation', request };
    const start = { command: 'start-delegation', idempotencyKey: 'session-a:turn-7', request, selection };
    const cancel = { command: 'cancel-delegation', jobId: 'job-1' };
    const evaluate = {
      author: 'operator',
      authorLabel: null,
      command: 'record-delegation-evaluation',
      evaluation: { kind: 'acceptance', verdict: 'accepted' },
      jobId: 'job-1',
    };
    const configure = { command: 'update-delegation-config', expectedRevision: 'abcdef0123456789', reviewTargets: [] };
    for (const command of [qualify, cancel, evaluate, configure]) {
      expect(parseWebUsageEngineCommand(command) as unknown).toEqual(command);
    }
    expect(parseUsageEngineCommand(start) as unknown).toEqual(start);
    expect(() => parseWebUsageEngineCommand(start)).toThrow('start a delegation');

    // The nested payloads are objects the engine parses; the control plane refuses only non-objects.
    expect(() => parseUsageEngineCommand({ ...qualify, request: 'review HEAD' })).toThrow('object');
    expect(() => parseUsageEngineCommand({ ...qualify, purpose: 'dry-run' })).toThrow('purpose');
    expect(() => parseUsageEngineCommand({ ...qualify, extra: true })).toThrow('unknown');
    expect(() => parseUsageEngineCommand({ ...start, idempotencyKey: 'short' })).toThrow('idempotency');
    expect(() => parseUsageEngineCommand({ ...start, idempotencyKey: 'has space in it' })).toThrow('idempotency');
    expect(() => parseUsageEngineCommand({ ...start, selection: [] })).toThrow('object');
    expect(() => parseUsageEngineCommand({ command: 'cancel-delegation' })).toThrow('unknown or missing');
    // The engine's own author is never accepted from a caller.
    expect(() => parseUsageEngineCommand({ ...evaluate, author: 'automated-check' })).toThrow('author');
    expect(() => parseUsageEngineCommand({ ...evaluate, evaluation: null })).toThrow('object');
    expect(() => parseUsageEngineCommand({ command: 'update-delegation-config', expectedRevision: 'abc' })).toThrow(
      'no section',
    );
    expect(() => parseUsageEngineCommand({ ...configure, executors: 'all' })).toThrow('array');
    expect(() => parseUsageEngineCommand({ ...configure, delegation: [] })).toThrow('object');
    expect(() => parseUsageEngineCommand({ ...configure, expectedRevision: 'x'.repeat(65) })).toThrow('revision');
  });

  test('carries the delegation answers and refuses outputs that do not conform (ADR 0077)', () => {
    const base = { commandId: 'command-1', completedAt: '2026-10-25T08:00:02.000Z', state: 'succeeded' };
    const qualification = {
      admissibleRouteIds: [],
      outcome: 'no-admissible-route',
      qualificationId: '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5',
      routes: [],
      schemaVersion: 1,
    };
    const qualified = {
      ...base,
      command: 'qualify-delegation',
      output: { kind: 'delegation-qualification', qualification },
    };
    expect(parseUsageEngineCommandCompletion(qualified)).toEqual(qualified as never);
    for (const output of [
      { kind: 'delegation-qualification', qualification: { ...qualification, schemaVersion: 2 } },
      { kind: 'delegation-qualification', qualification: { ...qualification, outcome: 'maybe' } },
      { kind: 'delegation-qualification', qualification: { ...qualification, qualificationId: 7 } },
      { kind: 'delegation-qualification', qualification: { ...qualification, routes: ['x'.repeat(49 * 1024)] } },
      { kind: 'delegation-qualification', qualification, rows: [] },
      { kind: 'none' },
    ]) {
      expect(() => parseUsageEngineCommandCompletion({ ...qualified, output })).toThrow();
    }

    const started = {
      ...base,
      command: 'start-delegation',
      output: { job: { jobId: 'job-1', reused: false, state: 'starting' }, kind: 'delegation-start', refusal: null },
    };
    expect(parseUsageEngineCommandCompletion(started)).toEqual(started as never);
    const refused = {
      ...started,
      output: {
        job: { jobId: 'job-2', reused: false, state: 'refused' },
        kind: 'delegation-start',
        refusal: { message: 'The cited qualification expired.', reason: 'qualification-expired' },
      },
    };
    expect(parseUsageEngineCommandCompletion(refused)).toEqual(refused as never);
    const refusedWithoutRow = { ...started, output: { ...refused.output, job: null } };
    expect(parseUsageEngineCommandCompletion(refusedWithoutRow)).toEqual(refusedWithoutRow as never);
    for (const output of [
      { ...started.output, job: null },
      { ...started.output, job: { ...started.output.job, state: 'queued' } },
      { ...refused.output, refusal: { ...refused.output.refusal, reason: 'busy' } },
      { ...refused.output, refusal: { message: 'x'.repeat(1025), reason: 'pool-busy' } },
      { ...started.output, rows: [] },
    ]) {
      expect(() => parseUsageEngineCommandCompletion({ ...started, output })).toThrow();
    }

    const cancelled = {
      ...base,
      command: 'cancel-delegation',
      output: { jobId: 'job-1', kind: 'delegation-cancel', result: 'cancelling', state: 'running' },
    };
    expect(parseUsageEngineCommandCompletion(cancelled)).toEqual(cancelled as never);
    const unknownJob = { ...cancelled, output: { ...cancelled.output, result: 'not-found', state: null } };
    expect(parseUsageEngineCommandCompletion(unknownJob)).toEqual(unknownJob as never);
    expect(() =>
      parseUsageEngineCommandCompletion({ ...cancelled, output: { ...cancelled.output, result: 'killed' } }),
    ).toThrow();

    const evaluated = {
      ...base,
      command: 'record-delegation-evaluation',
      output: { evaluationId: 'evaluation-1', kind: 'delegation-evaluation', refusal: null },
    };
    expect(parseUsageEngineCommandCompletion(evaluated)).toEqual(evaluated as never);
    const notEnded = {
      ...evaluated,
      output: {
        evaluationId: null,
        kind: 'delegation-evaluation',
        refusal: { message: 'The job is still running.', reason: 'not-ended' },
      },
    };
    expect(parseUsageEngineCommandCompletion(notEnded)).toEqual(notEnded as never);
    for (const output of [
      { evaluationId: null, kind: 'delegation-evaluation', refusal: null },
      { ...notEnded.output, evaluationId: 'evaluation-1' },
      { ...notEnded.output, refusal: { ...notEnded.output.refusal, reason: 'forbidden' } },
    ]) {
      expect(() => parseUsageEngineCommandCompletion({ ...evaluated, output })).toThrow();
    }

    const written = {
      ...base,
      command: 'update-delegation-config',
      output: { issues: [], kind: 'delegation-config', result: 'written', revision: '0123456789abcdef' },
    };
    expect(parseUsageEngineCommandCompletion(written)).toEqual(written as never);
    const invalid = {
      ...written,
      output: {
        issues: [{ path: 'delegation.rules[0].id', reason: 'must match the rule id pattern' }],
        kind: 'delegation-config',
        result: 'invalid',
        revision: '0123456789abcdef',
      },
    };
    expect(parseUsageEngineCommandCompletion(invalid)).toEqual(invalid as never);
    for (const output of [
      { ...written.output, result: 'invalid' },
      { ...invalid.output, result: 'written' },
      { ...invalid.output, issues: [{ path: 'delegation', reason: 'x', value: 'secret' }] },
      { ...written.output, result: 'skipped' },
    ]) {
      expect(() => parseUsageEngineCommandCompletion({ ...written, output })).toThrow();
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

  test('bounds a review or delegation message by UTF-8 bytes on a code-point boundary', () => {
    const limit = usageEngineMaxReviewMessageBytes;
    const bytesOf = (value: string): number => new TextEncoder().encode(value).byteLength;
    expect(limit).toBe(1024);

    const ascii = 'a'.repeat(limit);
    expect(boundUsageEngineReviewMessage(ascii)).toBe(ascii);
    const asciiCut = boundUsageEngineReviewMessage(`${ascii}b`);
    expect(asciiCut).toBe(`${'a'.repeat(limit - 3)}…`);
    expect(bytesOf(asciiCut)).toBe(limit);

    // CJK: three bytes per character, never cut inside one (341 characters fit, 342 do not).
    const cjk = '日'.repeat(341);
    expect(bytesOf(cjk)).toBe(limit - 1);
    expect(boundUsageEngineReviewMessage(cjk)).toBe(cjk);
    const cjkCut = boundUsageEngineReviewMessage(`${cjk}本`);
    expect(cjkCut).toBe(`${'日'.repeat(340)}…`);
    expect(bytesOf(cjkCut)).toBe(limit - 1);

    // Emoji: four bytes and a surrogate pair in UTF-16, never split (256 fit exactly, 257 do not).
    const emoji = '🧪'.repeat(limit / 4);
    expect(bytesOf(emoji)).toBe(limit);
    expect(boundUsageEngineReviewMessage(emoji)).toBe(emoji);
    const emojiCut = boundUsageEngineReviewMessage(`${emoji}🧪`);
    expect(emojiCut).toBe(`${'🧪'.repeat(limit / 4 - 1)}…`);
    expect(bytesOf(emojiCut)).toBe(limit - 1);

    // An ASCII run that ends where a four-byte character would overflow the budget: the marker takes its place.
    const mixedCut = boundUsageEngineReviewMessage(`${'a'.repeat(limit - 4)}🧪🧪`);
    expect(mixedCut).toBe(`${'a'.repeat(limit - 4)}…`);

    // What the helper answers is exactly what the two start-output parsers accept.
    for (const message of [asciiCut, cjkCut, emojiCut, mixedCut]) {
      expect(
        parseUsageEngineDelegationStartOutput({
          job: null,
          kind: 'delegation-start',
          refusal: { message, reason: 'pool-busy' },
        }).refusal?.message,
      ).toBe(message);
      expect(
        parseUsageEngineReviewAttemptOutput({
          attempt: { attemptId: 'attempt-1', reused: false, state: 'refused' },
          kind: 'review-attempt',
          refusal: { message, reason: 'pool-busy' },
        }).refusal?.message,
      ).toBe(message);
    }
    expect(() =>
      parseUsageEngineDelegationStartOutput({
        job: null,
        kind: 'delegation-start',
        refusal: { message: `${cjk}本`, reason: 'pool-busy' },
      }),
    ).toThrow('byte limit');
  });
});

describe('narrow project-group command parser', () => {
  test('answers exactly what the full command parser and the web projection answer', () => {
    const command = {
      command: 'replace-project-groups-by-reference',
      projectGroups: [{ id: 'group-1', name: 'Group 1', sources: [`project-source:${'b'.repeat(64)}`] }],
      revision: 'revision-b',
    };
    const narrow = parseUsageEngineProjectGroupReferenceCommand(command) as unknown;
    expect(narrow).toEqual(parseUsageEngineCommand(command));
    expect(narrow).toEqual(parseWebUsageEngineCommand(command));
    expect(() => parseUsageEngineProjectGroupReferenceCommand({ ...command, extra: true })).toThrow('unknown fields');
    expect(() => parseUsageEngineProjectGroupReferenceCommand({ command: 'publish' })).toThrow(
      'command kind is invalid',
    );
    expect(() =>
      parseUsageEngineProjectGroupReferenceCommand({
        ...command,
        projectGroups: [{ id: 'group-1', name: 'Group 1', sources: ['/private/history'] }],
      }),
    ).toThrow('reference');
  });
});

describe('the delegation config issues an invalid answer lists', () => {
  const issuesBytes = (issues: readonly object[]): number => Buffer.byteLength(JSON.stringify(issues), 'utf8');
  const answer = (issues: readonly { path: string; reason: string }[]) => ({
    issues,
    kind: 'delegation-config' as const,
    result: 'invalid' as const,
    revision: '0123456789abcdef',
  });

  test('keeps a short list whole and empty stays empty', () => {
    expect(boundUsageEngineDelegationConfigIssues([])).toEqual([]);
    const few = [
      { path: 'delegation.rules[0].effect', reason: 'must be forbid, restrict or require' },
      { path: 'delegation.defaults.reservePercent', reason: 'must be a number between 0 and 100' },
    ];
    expect(boundUsageEngineDelegationConfigIssues(few)).toEqual(few);
  });

  test('counts the issues beyond the count bound in a closing entry instead of dropping them', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      path: `delegation.rules[${index}]`,
      reason: 'unknown field(s): x',
    }));
    const listed = boundUsageEngineDelegationConfigIssues(many);
    expect(listed).toHaveLength(64);
    expect(listed.slice(0, 63)).toEqual(many.slice(0, 63));
    expect(listed[63]?.reason).toStartWith('37 more issue(s) not listed');
    expect(parseUsageEngineDelegationConfigOutput(answer(listed)).issues).toHaveLength(64);
  });

  test('keeps sixty-four issues of a kilobyte each under half the completion bound', () => {
    // One unknown key of about a kilobyte in each of the 64 rules the policy admits.
    const wide = Array.from({ length: 64 }, (_, index) => ({
      path: `delegation.rules[${index}]`,
      reason: `unknown field(s): ${'k'.repeat(1000)}${index}`,
    }));
    expect(issuesBytes(wide)).toBeGreaterThan(usageEngineControlBounds.maxCommandCompletionEventBytes);
    const listed = boundUsageEngineDelegationConfigIssues(wide);
    expect(issuesBytes(listed)).toBeLessThanOrEqual(usageEngineControlBounds.maxCommandCompletionEventBytes / 2);
    expect(listed.length).toBeLessThan(wide.length);
    const omitted = wide.length - (listed.length - 1);
    expect(listed.at(-1)?.reason).toStartWith(`${omitted} more issue(s) not listed`);
    expect(listed.slice(0, -1)).toEqual(
      wide
        .slice(0, listed.length - 1)
        .map((issue) => ({ ...issue, reason: boundUsageEngineReviewMessage(issue.reason) })),
    );
    expect(parseUsageEngineDelegationConfigOutput(answer(listed)).issues).toEqual(listed);
  });
});

describe('review stop contract', () => {
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
