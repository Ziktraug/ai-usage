import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { USAGE_ENGINE_PROTOCOL_VERSION } from '@ai-usage/usage-engine-control';
import { usageEngineTargetIdFor } from '@ai-usage/usage-engine-control/node';
import { loadUsageEngineRendezvousForWeb } from './usage-engine-control.server';
import type { UsageWebRuntimePaths } from './usage-runtime-paths.server';

test('loads only a rendezvous bound to the web database and config target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plan052-web-rendezvous-'));
  const stateDirectory = path.join(root, 'state');
  const paths: UsageWebRuntimePaths = {
    configCwd: path.join(root, 'config'),
    databasePath: path.join(root, 'store', 'usage.sqlite'),
    inboxDirectory: path.join(stateDirectory, 'inbox'),
    rendezvousPath: path.join(stateDirectory, 'rendezvous.json'),
    stateDirectory,
  };
  try {
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(
      paths.rendezvousPath,
      `${JSON.stringify({
        instanceId: '11111111-1111-4111-8111-111111111111',
        port: 41_052,
        protocolVersion: USAGE_ENGINE_PROTOCOL_VERSION,
        targetId: usageEngineTargetIdFor(paths),
        token: 'fixture-token-with-at-least-thirty-two-bytes',
      })}\n`,
      { mode: 0o600 },
    );

    await expect(loadUsageEngineRendezvousForWeb(paths)).resolves.toMatchObject({
      port: 41_052,
      targetId: usageEngineTargetIdFor(paths),
    });
    for (const mismatchedPaths of [
      { ...paths, databasePath: `${paths.databasePath}.other` },
      { ...paths, configCwd: `${paths.configCwd}.other` },
    ]) {
      try {
        await loadUsageEngineRendezvousForWeb(mismatchedPaths);
        throw new Error('Expected the web rendezvous target to be rejected.');
      } catch (error) {
        expect(error).toMatchObject({ reason: 'target-mismatch' });
        expect(String(error)).not.toContain(paths.databasePath);
        expect(String(error)).not.toContain(paths.configCwd);
      }
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
