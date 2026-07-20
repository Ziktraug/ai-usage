import { describe, expect, test } from 'bun:test';
import {
  type SessionDetailAnchorResult,
  type SessionDetailRequest,
  sessionDetailRequestFingerprint,
} from '@ai-usage/report-core/session-detail';
import { type RevisionQueryRunnerDependencies, runRevisionQueryForServer } from './revision-query-runner.server';

const request: SessionDetailRequest = { revision: 'revision-a', rowId: 'row-a' };
const fingerprint = sessionDetailRequestFingerprint(request);
const anchorResult: SessionDetailAnchorResult = {
  anchor: {
    harnessKey: 'codex',
    machineId: 'machine-a',
    projection: {
      calls: 1,
      durationMs: 1000,
      modelSegments: [
        {
          model: 'gpt-5',
          tokens: { cacheRead: 0, cacheWrite: 0, input: 10, output: 5, total: 15 },
        },
      ],
      partial: false,
      tokens: { cacheRead: 0, cacheWrite: 0, input: 10, output: 5, total: 15 },
      tools: 0,
      turns: 1,
    },
    sourceAuthority: 'local-observed',
    sourceSessionId: 'session-a',
  },
  requestFingerprint: fingerprint,
  revision: request.revision,
};

const dependenciesReturning = (value: unknown): RevisionQueryRunnerDependencies => ({
  execute: () => Promise.resolve({ ok: true, serializedPayload: JSON.stringify(value) }),
});

describe('revision query runner server session detail anchor', () => {
  test('parses the exact request and successful bounded-runner result', async () => {
    const executions: unknown[] = [];
    const result = await runRevisionQueryForServer('session-detail-anchor', request, {
      execute: (execution) => {
        executions.push(execution);
        return Promise.resolve({ ok: true, serializedPayload: JSON.stringify(anchorResult) });
      },
    });

    expect(executions).toEqual([
      {
        kind: 'session-detail-anchor',
        revision: request.revision,
        serializedRequest: JSON.stringify(request),
      },
    ]);
    expect(result).toEqual({
      data: anchorResult,
      ok: true,
      requestFingerprint: fingerprint,
      revision: request.revision,
    });
  });

  test('maps fingerprint and revision result mismatches to QueryFailed', async () => {
    for (const invalidResult of [
      { ...anchorResult, requestFingerprint: 'session-detail-v2:wrong' },
      { ...anchorResult, revision: 'revision-b' },
    ]) {
      const result = await runRevisionQueryForServer(
        'session-detail-anchor',
        request,
        dependenciesReturning(invalidResult),
      );
      expect(result).toMatchObject({
        error: { revision: request.revision, tag: 'QueryFailed' },
        ok: false,
        requestFingerprint: fingerprint,
        revision: request.revision,
      });
    }
  });

  test('maps a missing lease to RevisionExpired without parsing a result', async () => {
    const result = await runRevisionQueryForServer('session-detail-anchor', request, {
      execute: () => Promise.resolve({ message: 'Revision expired', ok: false }),
    });

    expect(result).toEqual({
      error: { message: 'Revision expired', revision: request.revision, tag: 'RevisionExpired' },
      ok: false,
      requestFingerprint: fingerprint,
      revision: request.revision,
    });
  });

  test('maps bounded process failures to QueryFailed', async () => {
    const result = await runRevisionQueryForServer('session-detail-anchor', request, {
      execute: () => Promise.reject(new Error('bounded runner failed')),
    });

    expect(result).toEqual({
      error: { message: 'bounded runner failed', revision: request.revision, tag: 'QueryFailed' },
      ok: false,
      requestFingerprint: fingerprint,
      revision: request.revision,
    });
  });
});
