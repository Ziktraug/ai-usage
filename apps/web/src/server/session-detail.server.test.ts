import { describe, expect, test } from 'bun:test';
import type { SessionDetail } from '@ai-usage/report-core/session-detail';
import { getLocalSessionDetailForServer } from './session-detail.server';

const request = {
  harnessKey: 'codex',
  machineId: 'machine-a',
  sourceSessionId: 'session-a',
};

const detail: SessionDetail = {
  activeDurationMs: 60_000,
  durationStatus: 'recorded',
  efforts: ['high'],
  elapsedDurationMs: 60_000,
  endedAt: '2026-07-18T10:01:00.000Z',
  idleDurationMs: 0,
  models: ['gpt-5.6-sol'],
  observedAt: '2026-07-18T10:01:01.000Z',
  phases: [],
  prompts: [],
  promptsTruncated: false,
  sourceSessionId: request.sourceSessionId,
  startedAt: '2026-07-18T10:00:00.000Z',
  turns: [],
  turnsStatus: 'recorded',
};

describe('local session detail server', () => {
  test('returns local Codex detail through the validated contract', async () => {
    expect(
      await getLocalSessionDetailForServer(request, {
        readDetail: () => Promise.resolve(detail),
        readMachine: () => Promise.resolve({ id: request.machineId }),
      }),
    ).toEqual({ detail, status: 'available' });
  });

  test('dispatches OpenCode through the same local-detail interface', async () => {
    const dispatchedHarnesses: string[] = [];
    const openCodeRequest = { ...request, harnessKey: 'opencode' };

    expect(
      await getLocalSessionDetailForServer(openCodeRequest, {
        readDetail: (harnessKey) => {
          dispatchedHarnesses.push(harnessKey);
          return Promise.resolve(detail);
        },
        readMachine: () => Promise.resolve({ id: request.machineId }),
      }),
    ).toEqual({ detail, status: 'available' });
    expect(dispatchedHarnesses).toEqual(['opencode']);
  });

  test('does not read history for a session from another machine', async () => {
    let reads = 0;
    const result = await getLocalSessionDetailForServer(request, {
      readDetail: () => {
        reads += 1;
        return Promise.resolve(detail);
      },
      readMachine: () => Promise.resolve({ id: 'machine-b' }),
    });

    expect(result).toMatchObject({ reason: 'not-local', status: 'unavailable' });
    expect(reads).toBe(0);
  });

  test('returns explicit unsupported, missing, and safe read-failure states', async () => {
    const dependencies = {
      readDetail: () => Promise.resolve<SessionDetail | null>(null),
      readMachine: () => Promise.resolve({ id: request.machineId }),
    };
    expect(await getLocalSessionDetailForServer({ ...request, harnessKey: 'claude' }, dependencies)).toMatchObject({
      reason: 'unsupported',
      status: 'unavailable',
    });
    expect(await getLocalSessionDetailForServer(request, dependencies)).toMatchObject({
      reason: 'not-found',
      status: 'unavailable',
    });
    expect(
      await getLocalSessionDetailForServer(request, {
        ...dependencies,
        readDetail: () => Promise.reject(new Error('/private/path must not escape')),
      }),
    ).toEqual({
      message: 'The local Codex history could not be read safely.',
      reason: 'history-unavailable',
      status: 'unavailable',
    });
  });
});
