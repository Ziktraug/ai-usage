import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageUsageEngineHandoff } from './handoff';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const fixture = async (): Promise<{ inboxDirectory: string; root: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'usage-engine-handoff-stage-'));
  roots.push(root);
  const inboxDirectory = path.join(root, 'inbox');
  await mkdir(inboxDirectory, { mode: 0o700 });
  return { inboxDirectory, root };
};

test('stages an exact owner-only file and cleans it idempotently', async () => {
  const { inboxDirectory } = await fixture();
  const bytes = new TextEncoder().encode('{"rows":[]}');
  const staged = await stageUsageEngineHandoff(bytes, {
    createHandoffId: () => 'safe-stage',
    inboxDirectory,
  });
  const filePath = path.join(inboxDirectory, 'safe-stage.upload');

  expect({ handoffId: String(staged.input.handoffId), kind: staged.input.kind }).toEqual({
    handoffId: 'safe-stage',
    kind: 'inbox-handoff',
  });
  expect(Array.from(await readFile(filePath))).toEqual(Array.from(bytes));
  expect((await stat(filePath)).mode % 0o1000).toBe(0o600);
  await staged.cleanup();
  await staged.cleanup();
  await expect(Bun.file(filePath).exists()).resolves.toBe(false);
});

test('treats an engine-consumed handoff as an already completed cleanup', async () => {
  const { inboxDirectory } = await fixture();
  const staged = await stageUsageEngineHandoff(new Uint8Array([1]), {
    createHandoffId: () => 'engine-consumed',
    inboxDirectory,
  });
  await unlink(path.join(inboxDirectory, 'engine-consumed.upload'));
  await expect(staged.cleanup()).resolves.toBeUndefined();
});

test('rejects unsafe directories, exclusive-name collisions, symlinks, and byte overflow', async () => {
  const { inboxDirectory, root } = await fixture();
  await chmod(inboxDirectory, 0o755);
  await expect(
    stageUsageEngineHandoff(new Uint8Array([1]), { createHandoffId: () => 'unsafe-dir', inboxDirectory }),
  ).rejects.toThrow('unsafe');
  await chmod(inboxDirectory, 0o700);

  const collisionPath = path.join(inboxDirectory, 'collision.upload');
  await writeFile(collisionPath, 'first', { mode: 0o600 });
  await expect(
    stageUsageEngineHandoff(new Uint8Array([2]), { createHandoffId: () => 'collision', inboxDirectory }),
  ).rejects.toThrow();
  expect(await readFile(collisionPath, 'utf8')).toBe('first');

  const targetPath = path.join(root, 'target');
  await writeFile(targetPath, 'target');
  await symlink(targetPath, path.join(inboxDirectory, 'linked.upload'));
  await expect(
    stageUsageEngineHandoff(new Uint8Array([3]), { createHandoffId: () => 'linked', inboxDirectory }),
  ).rejects.toThrow();
  expect(await readFile(targetPath, 'utf8')).toBe('target');

  await expect(
    stageUsageEngineHandoff(new Uint8Array([1, 2]), {
      createHandoffId: () => 'oversized',
      inboxDirectory,
      maximumBytes: 1,
    }),
  ).rejects.toThrow('byte limit');
});

test('preserves a staged file that changed before web cleanup', async () => {
  const { inboxDirectory } = await fixture();
  const staged = await stageUsageEngineHandoff(new Uint8Array([1]), {
    createHandoffId: () => 'changed-stage',
    inboxDirectory,
  });
  const filePath = path.join(inboxDirectory, 'changed-stage.upload');
  await writeFile(filePath, new Uint8Array([1, 2]));

  await expect(staged.cleanup()).rejects.toThrow('changed');
  await expect(Bun.file(filePath).exists()).resolves.toBe(true);
});
