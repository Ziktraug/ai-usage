import { describe, expect, test } from 'bun:test';
import type { SessionDetailReportAnchor } from '@ai-usage/report-core/session-detail';
import { sessionDetailRequestFingerprint } from '@ai-usage/report-core/session-detail';
import type { SessionVcsContext, SessionVcsResolveUnavailableReason } from '@ai-usage/report-core/session-vcs';
import { runBoundedStdoutProcess } from './bounded-stdout-process.server';
import {
  createGhSessionVcsProviderResolver,
  resolveSessionVcsForServer,
  type SessionVcsServerDependencies,
} from './session-vcs.server';

const request = { revision: 'revision-a', rowId: 'row-a' };
const vcs: SessionVcsContext = {
  branches: [
    {
      firstObservedAt: '2026-07-01T08:00:00.000Z',
      lastObservedAt: '2026-07-01T08:01:00.000Z',
      name: 'main',
      provenance: 'harness-recorded',
      webUrl: 'https://github.com/fixture/project/tree/main',
    },
    {
      firstObservedAt: '2026-07-01T08:02:00.000Z',
      lastObservedAt: '2026-07-01T08:03:00.000Z',
      name: 'topic/final',
      provenance: 'harness-recorded',
      webUrl: 'https://github.com/fixture/project/tree/topic/final',
    },
  ],
  headCommit: null,
  partial: false,
  pullRequests: [],
  repository: {
    host: 'github.com',
    ownerPath: 'fixture/project',
    provenance: 'local-derived',
    webUrl: 'https://github.com/fixture/project',
  },
};
const anchor: SessionDetailReportAnchor = {
  harnessKey: 'claude',
  machineId: 'machine-a',
  projection: {
    calls: 1,
    durationMs: null,
    modelSegments: null,
    partial: false,
    tokens: null,
    tools: 0,
    turns: 1,
  },
  sourceAuthority: 'local-observed',
  sourceSessionId: 'session-a',
  vcs,
};

const dependencies = (overrides: Partial<SessionVcsServerDependencies> = {}): SessionVcsServerDependencies => ({
  readMachine: () => Promise.resolve({ id: 'machine-a' }),
  resolveAnchor: () =>
    Promise.resolve({
      data: {
        anchor,
        requestFingerprint: sessionDetailRequestFingerprint(request),
        revision: request.revision,
      },
      ok: true,
      requestFingerprint: sessionDetailRequestFingerprint(request),
      revision: request.revision,
    }),
  resolver: {
    resolve: () =>
      Promise.resolve({
        pullRequests: [
          {
            number: 27,
            observedAt: null,
            repository: 'fixture/project',
            url: 'https://github.com/fixture/project/pull/27',
          },
        ],
        repositoryUrl: 'https://github.com/fixture/project',
        status: 'available',
      }),
  },
  ...overrides,
});

describe('session VCS server', () => {
  test('passes only server-anchored repository and final observed branch to the resolver', async () => {
    const resolutions: unknown[] = [];
    const response = await resolveSessionVcsForServer(
      request,
      dependencies({
        resolver: {
          resolve: (input) => {
            resolutions.push(input);
            return dependencies().resolver.resolve(input);
          },
        },
      }),
    );
    expect(response).toMatchObject({ status: 'available' });
    expect(resolutions).toEqual([{ branch: 'topic/final', repository: vcs.repository }]);
  });

  test('rejects portable, wrong-machine, missing, and unsupported authority before resolver execution', async () => {
    let resolverCalls = 0;
    const resolver = {
      resolve: () => {
        resolverCalls += 1;
        return Promise.resolve({ reason: 'not-found' as const, status: 'unavailable' as const });
      },
    };
    const cases: Array<{
      anchor: SessionDetailReportAnchor | null;
      machine?: string;
      reason: SessionVcsResolveUnavailableReason;
    }> = [
      { anchor: { ...anchor, sourceAuthority: 'portable-opaque' }, reason: 'not-local' },
      { anchor, machine: 'machine-b', reason: 'not-local' },
      { anchor: { ...anchor, vcs: null }, reason: 'provenance-unavailable' },
      {
        anchor: {
          ...anchor,
          vcs: {
            ...vcs,
            repository: { ...vcs.repository!, host: 'gitlab.com', webUrl: 'https://gitlab.com/fixture/project' },
          },
        },
        reason: 'repository-unsupported',
      },
      { anchor: null, reason: 'provenance-unavailable' },
    ];
    for (const item of cases) {
      const response = await resolveSessionVcsForServer(
        request,
        dependencies({
          readMachine: () => Promise.resolve({ id: item.machine ?? 'machine-a' }),
          resolveAnchor: async () => {
            const result = await dependencies().resolveAnchor(request);
            if (!result.ok) {
              return result;
            }
            return { ...result, data: { ...result.data, anchor: item.anchor } };
          },
          resolver,
        }),
      );
      expect(response).toEqual({ reason: item.reason, status: 'unavailable' });
    }
    expect(resolverCalls).toBe(0);
  });

  test('runs gh with strict bounded arguments and sanitizes typed failures', async () => {
    const executions: unknown[] = [];
    const resolver = createGhSessionVcsProviderResolver({
      findExecutable: () => Promise.resolve('/usr/bin/gh'),
      run: (options) => {
        executions.push(options);
        return Promise.resolve({
          stdout: JSON.stringify([{ number: 27, url: 'https://github.com/fixture/project/pull/27' }]),
        });
      },
    });
    expect(await resolver.resolve({ branch: 'topic/final', repository: vcs.repository! })).toMatchObject({
      pullRequests: [{ number: 27 }],
      status: 'available',
    });
    expect(executions).toEqual([
      {
        args: [
          'pr',
          'list',
          '--repo',
          'fixture/project',
          '--head',
          'topic/final',
          '--state',
          'all',
          '--limit',
          '16',
          '--json',
          'number,url',
        ],
        command: '/usr/bin/gh',
        maximumOutputBytes: 262_144,
        shell: false,
        timeoutMs: 5000,
      },
    ]);

    const privateStderr = 'PRIVATE_PROVIDER_STDERR';
    const failed = createGhSessionVcsProviderResolver({
      findExecutable: () => Promise.resolve('/usr/bin/gh'),
      run: () => Promise.reject({ kind: 'auth', stderr: privateStderr }),
    });
    const failure = await failed.resolve({ branch: 'main', repository: vcs.repository! });
    expect(failure).toEqual({ reason: 'resolver-unavailable', status: 'unavailable' });
    expect(JSON.stringify(failure)).not.toContain(privateStderr);
  });

  test('maps missing gh, timeout, invalid JSON, and unsafe provider URLs without leaking output', async () => {
    const inputs: Array<{
      expected: SessionVcsResolveUnavailableReason;
      resolver: ReturnType<typeof createGhSessionVcsProviderResolver>;
    }> = [
      {
        expected: 'resolver-unavailable',
        resolver: createGhSessionVcsProviderResolver({
          findExecutable: () => Promise.resolve(null),
          run: () => Promise.reject(new Error('must not run')),
        }),
      },
      {
        expected: 'timed-out',
        resolver: createGhSessionVcsProviderResolver({
          findExecutable: () => Promise.resolve('/usr/bin/gh'),
          run: () => Promise.reject({ kind: 'timed-out' }),
        }),
      },
      {
        expected: 'resolver-unavailable',
        resolver: createGhSessionVcsProviderResolver({
          findExecutable: () => Promise.resolve('/usr/bin/gh'),
          run: () => Promise.resolve({ stdout: 'PRIVATE_INVALID_OUTPUT' }),
        }),
      },
      {
        expected: 'resolver-unavailable',
        resolver: createGhSessionVcsProviderResolver({
          findExecutable: () => Promise.resolve('/usr/bin/gh'),
          run: () => Promise.resolve({ stdout: JSON.stringify([{ number: 1, url: 'javascript:private' }]) }),
        }),
      },
    ];
    for (const { expected, resolver } of inputs) {
      const response = await resolver.resolve({ branch: 'main', repository: vcs.repository! });
      expect(response).toEqual({ reason: expected, status: 'unavailable' });
      expect(JSON.stringify(response)).not.toContain('PRIVATE');
    }
  });

  test('enforces stdout and timeout bounds in the shell-free process runner', async () => {
    expect(
      await runBoundedStdoutProcess({
        args: ['-e', "process.stdout.write('ok')"],
        command: process.execPath,
        maximumOutputBytes: 16,
        shell: false,
        timeoutMs: 1000,
      }),
    ).toEqual({ stdout: 'ok' });
    await expect(
      runBoundedStdoutProcess({
        args: ['-e', "process.stdout.write('too much output')"],
        command: process.execPath,
        maximumOutputBytes: 4,
        shell: false,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: 'output-limit' });
    await expect(
      runBoundedStdoutProcess({
        args: ['-e', 'setInterval(() => undefined, 1000)'],
        command: process.execPath,
        maximumOutputBytes: 16,
        shell: false,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ kind: 'timed-out' });
  });
});
