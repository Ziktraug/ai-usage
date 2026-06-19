import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UsageSnapshot } from '@ai-usage/core/snapshot';
import { createUsageSnapshot } from '@ai-usage/core/snapshot';
import type { SourcedRow } from '@ai-usage/core/types';
import type { SnapshotServerHandle, SnapshotServerInput } from '@ai-usage/sync/server';
import { describe, expect, test } from 'bun:test';
import { createSyncServeRuntime, upsertEnvToken } from './sync-serve.server';

const machine = { id: 'local-1', label: 'Local Machine' };

const row = (): SourcedRow => ({
  date: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-01-01T00:01:00.000Z'),
  harness: 'Codex',
  provider: 'Codex API',
  name: 'session',
  model: 'gpt-5.3-codex',
  project: 'ai-usage',
  tokIn: 10,
  tokOut: 5,
  tokCr: 0,
  tokCw: 0,
  costActual: 0,
  costApprox: 0,
  costKnown: true,
  calls: 1,
  durationMs: 60_000,
  turns: 1,
  tools: 0,
  linesAdded: null,
  linesDeleted: null,
  source: { harnessKey: 'codex', sourceSessionId: 'session-1' },
});

const snapshot = (): UsageSnapshot =>
  createUsageSnapshot({
    machine,
    rows: [row()],
    generatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

const runtime = (
  overrides: Partial<{ startServer: (input: SnapshotServerInput) => Promise<SnapshotServerHandle> }> = {},
) => {
  const starts: SnapshotServerInput[] = [];
  const envWrites: { key: string; value: string }[] = [];
  let stopped = false;
  return {
    starts,
    envWrites,
    stopped: () => stopped,
    service: createSyncServeRuntime({
      getMachine: async () => machine,
      collectSnapshot: async () => snapshot(),
      startServer:
        overrides.startServer ??
        (async (input) => {
          starts.push(input);
          input.onRequest?.({
            method: 'GET',
            path: '/health',
            remoteAddress: '127.0.0.1',
            status: 200,
            durationMs: 3,
          });
          return {
            port: input.port,
            urls: [`http://${input.host}:${input.port}/snapshot`],
            stop: async () => {
              stopped = true;
            },
          };
        }),
      generateSecret: () => 'generated-secret',
      upsertEnvToken: async (key, value) => {
        envWrites.push({ key, value });
        return { path: '/repo/.env' };
      },
      now: () => new Date('2026-06-19T09:00:00.000Z'),
    }),
  };
};

describe('sync serve runtime', () => {
  test('requires a token before serving on 0.0.0.0', async () => {
    const { service, starts } = runtime();

    const result = await service.start({ host: '0.0.0.0', port: 3847, token: null });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.status).toBe('error');
    expect(result.data.lastError?.reason).toBe('missing-serve-token');
    expect(starts).toHaveLength(0);
    expect(JSON.stringify(result.data)).not.toContain('secret');
  });

  test('starts and stops a snapshot server without exposing the raw token', async () => {
    const { service, starts, stopped } = runtime();

    const started = await service.start({ host: '127.0.0.1', port: 3847, token: 'secret' });

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    expect(started.data.status).toBe('running');
    expect(started.data.tokenConfigured).toBe(true);
    expect(started.data.machine).toEqual(machine);
    expect(started.data.urls).toEqual(['http://127.0.0.1:3847/snapshot']);
    expect(started.data.recentRequests[0]?.path).toBe('/health');
    expect(JSON.stringify(started.data)).not.toContain('secret');
    expect(starts[0]?.token).toBe('secret');

    const stoppedResult = await service.stop();

    expect(stoppedResult.ok).toBe(true);
    if (!stoppedResult.ok) throw new Error(stoppedResult.error.message);
    expect(stopped()).toBe(true);
    expect(stoppedResult.data.status).toBe('stopped');
    expect(stoppedResult.data.urls).toEqual([]);
    expect(stoppedResult.data.tokenConfigured).toBe(false);
  });

  test('generates all-in-one share instructions and writes the repo env token', async () => {
    const { service, starts, envWrites } = runtime();

    const result = await service.startShare({ port: 3847 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(starts[0]?.host).toBe('0.0.0.0');
    expect(starts[0]?.token).toBe('generated-secret');
    expect(envWrites).toEqual([{ key: 'AI_USAGE_SYNC_LOCAL_MACHINE_TOKEN', value: 'generated-secret' }]);
    expect(result.data.envKey).toBe('AI_USAGE_SYNC_LOCAL_MACHINE_TOKEN');
    expect(result.data.envPath).toBe('/repo/.env');
    expect(result.data.remoteName).toBe('local-machine');
    expect(result.data.copyText).toContain('AI_USAGE_SYNC_LOCAL_MACHINE_TOKEN=generated-secret');
    expect(result.data.copyText).toContain('bun run cli -- sync add local-machine http://0.0.0.0:3847/snapshot');
    expect(result.data.state.status).toBe('running');
  });

  test('upserts env tokens in the workspace root env file from an app cwd', async () => {
    const root = await mkdtemp('ai-usage-sync-serve-env-');
    try {
      const appCwd = path.join(root, 'apps', 'report');
      mkdirSync(appCwd, { recursive: true });
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
      writeFileSync(path.join(root, '.env'), 'AI_USAGE_SYNC_HOST_TOKEN=old\nOTHER=value\n');

      const first = await upsertEnvToken('AI_USAGE_SYNC_HOST_TOKEN', 'new', appCwd);
      const second = await upsertEnvToken('AI_USAGE_SYNC_OTHER_HOST_TOKEN', 'secret', appCwd);

      expect(first.path).toBe(path.join(root, '.env'));
      expect(second.path).toBe(path.join(root, '.env'));
      expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe(
        'AI_USAGE_SYNC_HOST_TOKEN=new\nOTHER=value\nAI_USAGE_SYNC_OTHER_HOST_TOKEN=secret\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const mkdtemp = async (prefix: string) => {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(tmpdir(), prefix));
};
